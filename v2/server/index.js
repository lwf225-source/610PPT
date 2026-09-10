import express from "express";
import { REFERENCE_STYLE_PACKS } from "../../shared/reference-style-catalog.js";
import { cloudMode } from '../../server/runtime-adapter.js';
import { createLocalAccessGuard, loadOrCreateLocalApiToken } from '../../shared/local-access.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxyArtifactFile } from "./artifact-proxy.js";
import { fileURLToPath } from "node:url";
import { TaskEventStore, summarizePage } from "./event-store.js";
import { consultingCopyFromDraft, isPageCopyDraftUnchanged, pageBlocksFromConsultingCopy, pageCopyDraftFromPage } from "./page-copy-contract.js";
import { assertCommittedSplit } from "./split-completion.js";
import { createSplitAdmissionGate } from "./split-admission.js";
import { DurableSplitClient } from "./durable-split-client.js";
import { invalidateEditedPage } from "./page-edit-invalidation.js";
import { splitInputHash } from "../../server/content-candidates.js";
import { WORKBENCH_BUILD_ID } from "../../shared/runtime-version.js";
import { V1Client } from "./v1-client.js";
import { ALL_CONTENT_DETAIL_MODES, normalizeContentDetailMode } from "../../shared/content-detail-contracts.js";
import { ALL_NARRATIVE_MODES } from "../../shared/narrative-contracts.js";
import { deriveContentOutlineFromDeck } from "../../shared/content-outline-ir.js";
import { createGenerationTaskRunner, generationPageNosForTask } from "./generation-task.js";
export { generationTaskCanSettle, generationPageNosForTask, generationProgressForTask } from "./generation-task.js";
import { preparePageRegeneration, prepareQaPageRegenerations } from "./page-regeneration.js";
import { prepareDirectExportDeck } from "./direct-export.js";
import { qaDecisionKeys, qaDecisionSummary } from "./qa-review.js";
import { isStyleProfileConfirmed as matchesConfirmedStyleProfile } from "../public/style-confirmation.js";
import { createStyleReferenceLibrary } from "./style-reference-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.resolve(__dirname, "..");
const WORKBENCH_DIR = path.resolve(V2_DIR, "..");
const PROJECT_ROOT = process.env.PPT_WORKBENCH_ROOT || path.resolve(WORKBENCH_DIR, "..");
const dataDir = process.env.PPT_WORKBENCH_DATA_DIR
  ? path.resolve(process.env.PPT_WORKBENCH_DATA_DIR)
  : process.env.PPT_WORKBENCH_ROOT
    ? path.join(PROJECT_ROOT, "workbench-data")
    : path.join(os.homedir(), "Library", "Application Support", "610PPT");

const STYLE_PREVIEW_DEFINITIONS = Object.freeze({
  ...Object.fromEntries(REFERENCE_STYLE_PACKS.map(pack => [pack.id, { label: `${pack.name}六页母版`, basePath: `image2-style-previews/${pack.id}`, referenceOnly: pack.masterPreviewCount !== 6, pack } ])),
  "image2-game-handdrawn": Object.freeze({ label: "游戏化手绘风六页母版", basePath: "image2-style-previews/image2-game-handdrawn" }),
  "image2-dark-tactical": Object.freeze({ label: "暗色战术风六页母版", basePath: "image2-style-previews/image2-dark-tactical" }),
  "image2-consulting-poster": Object.freeze({ label: "咨询海报风六页母版", basePath: "image2-style-previews/image2-consulting-poster" })
});

const MASTER_PAGE_ROLES = Object.freeze([
  Object.freeze({ id: "cover", label: "封面" }),
  Object.freeze({ id: "directory", label: "目录" }),
  Object.freeze({ id: "data", label: "核心指标" }),
  Object.freeze({ id: "content", label: "业务结构" }),
  Object.freeze({ id: "process", label: "AI 投入" }),
  Object.freeze({ id: "conclusion", label: "结论页" })
]);

// All Image2 styles share one executable semantic-role master pack.
const EXECUTABLE_MASTER_PACK = Object.freeze({
  id: "image2-dark-tactical",
  version: "1.0.0",
  label: "整页视觉一致性母版",
  contract: Object.freeze({
    layoutSystem: "整页视觉图，允许信息构图变化，不更换视觉系统",
    titleAnchor: "标题组件、字高、位置和颜色全套固定；封面按封面角色处理",
    typography: "标题、副标题、模块标题、正文与页脚固定角色层级；文字过长只能换行或重组构图，不得删减、概括、改写或补写锁定文案，不得缩小字号；仍无法容纳时报告排版失败，交由用户调整文案后重新确认",
    spacing: "固定安全边距与信息密度区间；底部结论仅在内容确有收束时使用",
    anchor: "先确认封面与首张正文双锚点；封面锁定气质，正文锁定标题组件、字号尺度与信息密度"
  })
});

function sendSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: task-event\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function deckSummary(deck = {}) {
  return {
    deckId: deck.deckId || "",
    title: deck.title || "未命名演示文稿",
    pageCount: Array.isArray(deck.pages) ? deck.pages.length : 0,
    revision: deck.revision ?? null,
    storageRevision: deck.storageRevision ?? deck.revision ?? null,
    projectId: deck.project?.id || deck.deckId || ""
  };
}

export function missingImage2AnchorGeneration(deck = {}, kind = "content") {
  if (!["cover", "content"].includes(kind)) {
    return { error: "锚点类型必须是 cover 或 content", status: 400 };
  }
  const anchor = deck.styleAnchors?.[kind];
  if (!anchor?.pageId) {
    return { error: `没有找到${kind === "cover" ? "封面" : "正文"}视觉锚点页面`, status: 409 };
  }
  const page = (deck.pages || []).find((item) => [item.id, item.pageNo].includes(anchor.pageId));
  if (!page) return { error: `${anchor.pageId} 不在当前页面列表中`, status: 409 };
  if (page.finalImage?.path || anchor.assetPath) {
    return { error: `${kind === "cover" ? "封面" : "正文"}锚点已经生成`, status: 409 };
  }
  if (page.generationStatus === "generating") {
    return { error: `${anchor.pageId} 正在生成，请勿重复提交`, status: 409 };
  }
  if (kind === "content" && deck.styleAnchors?.cover?.status !== "confirmed") {
    return { error: "请先完成封面锚点，再生成正文视觉母版", status: 409 };
  }
  return { pageId: anchor.pageId, pageNo: page.pageNo || page.id, kind };
}

export function restoreImage2AnchorBinding(deck = {}, kind = "content") {
  if (!["cover", "content"].includes(kind)) {
    return { error: "锚点类型必须是 cover 或 content", status: 400 };
  }
  const anchor = deck.styleAnchors?.[kind];
  if (!anchor?.pageId || !anchor.assetPath) {
    return { error: `${kind === "cover" ? "封面" : "正文"}锚点没有可恢复的原图`, status: 409 };
  }
  const pageIndex = (deck.pages || []).findIndex((page) => [page.id, page.pageNo].includes(anchor.pageId));
  if (pageIndex < 0) return { error: `${anchor.pageId} 不在当前页面列表中`, status: 409 };
  const page = deck.pages[pageIndex];
  if (page.finalImage?.path === anchor.assetPath && page.generationStatus === "generated") {
    return { deck, pageNo: page.pageNo || page.id, path: anchor.assetPath, changed: false };
  }
  const pages = [...deck.pages];
  pages[pageIndex] = {
    ...page,
    generationStatus: "generated",
    generationStatusText: "AI 已生成",
    finalImage: {
      path: anchor.assetPath,
      source: anchor.assetPath,
      importedAt: anchor.updatedAt || new Date().toISOString()
    }
  };
  return {
    deck: { ...deck, pages },
    pageNo: page.pageNo || page.id,
    path: anchor.assetPath,
    changed: true
  };
}

export function findActiveImage2CompileTask(tasks = [], styleId = "") {
  return (tasks || []).find((task) => task?.kind === "image2-compile"
    && ["queued", "running"].includes(task?.status)
    && String(task?.input?.styleId || "") === String(styleId || "")) || null;
}

export function findConflictingImage2CompileTask(tasks = [], styleId = "") {
  return (tasks || []).find((task) => task?.kind === "image2-compile"
    && ["queued", "running"].includes(task?.status)
    && String(task?.input?.styleId || "") !== String(styleId || "")) || null;
}

function pageNoForIndex(index) {
  return `P${String(index + 1).padStart(2, "0")}`;
}

function deckAfterStructureChange(deck = {}, pages = []) {
  const nextPages = pages.map((page, index) => {
    const pageNo = pageNoForIndex(index);
    const {
      finalImage: _finalImage,
      imagePath: _imagePath,
      generationStatus: _generationStatus,
      reviewStatus: _reviewStatus,
      ...rest
    } = page;
    return {
      ...rest,
      id: pageNo,
      pageNo,
      prompt: "",
      status: "draft"
    };
  });
  const nextDeck = {
    ...deck,
    styleProfile: {
      ...(deck.styleProfile || {}),
      targetPageCount: nextPages.length,
      targetPageCountMode: "custom"
    },
    pages: nextPages,
    chapters: nextPages.map((page, index) => ({
      title: `${page.pageNo} ${page.title || "页面"}`,
      range: page.pageNo,
      line: index + 1
    })),
    generationJobs: {},
    imagePrompts: [],
    imageSources: [],
    qaReport: null,
    exportManifest: null
  };
  return {
    ...nextDeck,
    contentOutline: deriveContentOutlineFromDeck(nextDeck),
    image2RenderPlan: null,
    styleAnchor: null,
    styleAnchors: null
  };
}

export function deckAfterStyleChange(deck = {}, styleProfile = {}) {
  const previousStyleId = String(deck.styleProfile?.id || "").trim();
  const nextStyleId = String(styleProfile?.id || "").trim();
  const styleChanged = Boolean(previousStyleId && nextStyleId
    && previousStyleId !== nextStyleId);

  if (!styleChanged) return { ...deck, styleProfile };

  const pages = (deck.pages || []).map((page) => {
    const {
      finalImage: _finalImage,
      imagePath: _imagePath,
      regenerationPreviewImage: _regenerationPreviewImage,
      generationStatus: _generationStatus,
      generationStatusText: _generationStatusText,
      reviewStatus: _reviewStatus,
      error: _error,
      prompt: _prompt,
      image2Plan: _image2Plan,
      styleLock: _styleLock,
      masterPackId: _masterPackId,
      masterPackVersion: _masterPackVersion,
      masterLayoutCandidates: _masterLayoutCandidates,
      ...contentPage
    } = page;
    const previousStyleImage = _finalImage || _regenerationPreviewImage || (_imagePath ? { path: _imagePath } : null) || page.previousStyleImage;
    return (styleProfile.referenceBundleId || deck.styleProfile?.referenceBundleId) && previousStyleImage
      ? { ...contentPage, previousStyleImage, generationStatus: "pending", generationStatusText: "参考已更换，待重新生成" }
      : contentPage;
  });

  return {
    ...deck,
    styleProfile,
    pages,
    masterPack: null,
    styleBible: null,
    image2RenderPlan: null,
    styleAnchor: null,
    styleAnchors: null,
    generationJobs: {},
    imagePrompts: [],
    imageSources: [],
    qaReport: null,
    exportManifest: null
  };
}

function defaultTypographyScale() {
  return {
    coverTitle: 32,
    pageTitle: 24,
    subtitle: 13,
    body: 14,
    moduleTitle: 15,
    chartLabel: 11,
    keyNumber: 28,
    footer: 9
  };
}

function executableMasterPack() {
  return EXECUTABLE_MASTER_PACK;
}

function styleReferenceManifest(styleId) {
  const definition = STYLE_PREVIEW_DEFINITIONS[styleId];
  if (!definition) return null;
  if (definition.referenceOnly) return { version: "1.0.0", styleId, usage: "style-only", montage: `workbench/public/${definition.basePath}/reference.png`, slides: {} };
  const slides = Object.fromEntries(MASTER_PAGE_ROLES.map((role, index) => [
    role.id,
    `workbench/public/${definition.basePath}/slides/slide-${index + 1}.png`
  ]));
  return {
    version: definition.pack?.masterReferenceVersion || "1.0.0",
    styleId,
    montage: `workbench/public/${definition.basePath}/montage.png`,
    slides
  };
}

function masterContractForPack(pack, { locked = true } = {}) {
  return {
    id: pack.id,
    version: pack.version,
    locked,
    ...pack.contract
  };
}

function sendStylePreviewImage(res, relativePath) {
  const filePath = path.join(WORKBENCH_DIR, "public", relativePath);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "母版预览文件不存在" });
    return;
  }
  res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=300" });
  fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

function isStyleProfileConfirmed(profile = {}) {
  const masterPack = executableMasterPack();
  return matchesConfirmedStyleProfile(profile, masterPack);
}

function initialStyleProfile({ narrativeMode, contentDetailMode, targetPageCount }) {
  const masterPack = executableMasterPack();
  return {
    id: "image2-game-handdrawn",
    name: "游戏化手绘风",
    masterPackId: masterPack.id,
    masterPackVersion: masterPack.version,
    masterPackLabel: masterPack.label,
    masterContract: masterContractForPack(masterPack, { locked: false }),
    targetPageCount: Number(targetPageCount) || 0,
    targetPageCountMode: "custom",
    narrativeMode: narrativeMode || "narrative",
    contentDetailMode: normalizeContentDetailMode(contentDetailMode),
    coverMode: "auto",
    // The seed lets Codex plan a coherent deck, but is not a user-confirmed master.
    styleLock: false,
    masterPackLocked: false,
    selectionStatus: "recommended"
  };
}

function styleProfileForPack(styleProfile = {}, current = {}, referenceProfile = null) {
  if (referenceProfile) {
    const pack = executableMasterPack();
    return {
      ...current, ...referenceProfile,
      masterPackId: pack.id, executableMasterPackId: pack.id, masterPackVersion: pack.version,
      masterPackLabel: pack.label, masterContract: masterContractForPack(pack),
      editableMode: "image-only", image2ConsistencyMode: "fixed-anchor",
      styleLock: true, masterPackLocked: true, selectionStatus: "confirmed"
    };
  }
  const id = String(styleProfile.id || "").trim();
  if (!id) throw new Error("请选择一种生成风格");
  if (!STYLE_PREVIEW_DEFINITIONS[id]) {
    throw Object.assign(new Error("可编辑 PPT 生成已移除，请选择 AI 整页视觉风格"), { statusCode: 400 });
  }
  const masterPack = executableMasterPack();
  const referenceManifest = styleReferenceManifest(id);
  if (!referenceManifest) throw new Error("所选 Image2 母版不存在或不完整");
  return {
    ...current,
    id,
    templateId: id,
    name: String(STYLE_PREVIEW_DEFINITIONS[id].pack?.name || styleProfile.name || current.name || id),
    promptBase: String(STYLE_PREVIEW_DEFINITIONS[id].pack?.promptBase || styleProfile.promptBase || (current.referenceBundleId ? "" : current.promptBase) || ""),
    primary: String(STYLE_PREVIEW_DEFINITIONS[id].pack?.primary || styleProfile.primary || current.primary || "#0B5EA7"),
    masterPackId: masterPack.id,
    executableMasterPackId: masterPack.id,
    masterPackVersion: masterPack.version,
    masterPackLabel: masterPack.label,
    masterContract: masterContractForPack(masterPack),
    referenceManifest,
    referenceAssetPaths: referenceManifest
      ? [referenceManifest.montage, ...Object.values(referenceManifest.slides)]
      : undefined,
    editableMode: "image-only",
    image2ConsistencyMode: "fixed-anchor",
    styleLock: true,
    masterPackLocked: true,
    selectionStatus: "confirmed",
    referenceBundleId: undefined, referenceVersion: undefined, referenceStyleSystem: undefined,
    referenceAssets: undefined, referenceSelection: undefined, referenceTypography: undefined,
    customPrompt: undefined, referenceNote: undefined, referenceUsage: undefined
  };
}

export function mapV1SplitEvent(event) {
  const type = event.type || "";
  // V1 emits transport-only heartbeats while Codex is working. They keep the
  // internal fetch body alive but must not overwrite the visible split phase.
  if (type === "heartbeat") return null;
  if (type === "started") return { type: "task.started", payload: { kind: "split", status: "running" } };
  if (type === "phase") return {
    type: "split.phase",
    payload: {
      phase: event.stage || event.phase || "analyzing",
      message: event.message || "",
      total: event.total
    }
  };
  // The V1 engine may emit page records after its full-deck validation. V2
  // deliberately buffers them so the editor never exposes a partial deck.
  if (type === "page-started" || type === "page") return null;
  if (type === "complete") {
    const deck = event.deck || {};
    assertCommittedSplit(deck);
    return {
      type: "split.completed",
      payload: {
        status: "completed",
        candidateId: event.candidateId || null,
        pageCount: deck.pages?.length || event.pageCount || 0,
        projectSlug: deck.project?.slug || "",
        deck: deckSummary(deck),
        pages: (deck.pages || []).map(summarizePage)
      }
    };
  }
  if (type === "error") return { type: "task.failed", payload: { status: "failed", candidateId: event.candidateId || null, message: event.error || event.message || "AI 拆分失败" } };
  return { type: "split.phase", payload: { phase: type || "analyzing" } };
}

export function createV2App({ v1BaseUrl = process.env.PPT_V2_V1_BASE_URL || "http://127.0.0.1:5176", taskDataDir = dataDir, referenceOptions = {} } = {}) {
  const app = express();
  if (!cloudMode()) app.use(createLocalAccessGuard({ token: loadOrCreateLocalApiToken(taskDataDir), bootstrapPaths: ['/', '/index.html'] }));
  const store = new TaskEventStore({ dataDir: taskDataDir });
  const v1 = new V1Client({ baseUrl: v1BaseUrl, dataDir: taskDataDir });
  const referenceLibrary = createStyleReferenceLibrary({ dataDir: taskDataDir, projectRoot: PROJECT_ROOT, ...referenceOptions });
  const splitWorker = new DurableSplitClient({ store, v1, mapEvent: mapV1SplitEvent });
  const splitAdmission = createSplitAdmissionGate({ findActiveTask: async (slug) => (
    await store.listTasks(slug, Number.MAX_SAFE_INTEGER)
  ).find((task) => task.kind === "split" && ["queued", "running"].includes(task.status)) || null });

  app.use(express.json({ limit: "24mb" }));
  app.use((error, req, res, next) => {
    if (!req.path.startsWith("/api/v2/settings/ai")) return next(error);
    res.status(error.status || 400).json({ error: "设置请求格式无效，请重新填写后保存" });
  });
  // Admit settings changes and new work atomically in this process. Background
  // work is additionally checked in the persistent task store below.
  let settingsUpdatePending = false;
  let activeMutationRequests = 0;
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/v2/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const settingsWrite = req.path === "/api/v2/settings/ai" && req.method === "PUT";
    if (settingsUpdatePending || (settingsWrite && activeMutationRequests > 0)) {
      return res.status(409).json({ error: "工作台正在处理请求，请完成后再修改设置或开始新任务" });
    }
    if (settingsWrite) settingsUpdatePending = true;
    else activeMutationRequests++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (settingsWrite) settingsUpdatePending = false;
      else activeMutationRequests--;
    };
    res.once("finish", release);
    if (settingsWrite) req.releaseAiSettingsLock = release;
    else res.once("close", release);
    next();
  });
  for (const [method, suffix] of [["get", ""], ["put", ""], ["post", "/test"], ["post", "/models"]]) {
    app[method](`/api/v2/settings/ai${suffix}`, async (req, res) => {
      res.set("Cache-Control", "no-store");
      const origin = req.get("origin");
      if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
        return res.status(403).json({ error: "设置只允许从当前工作台修改" });
      }
      try {
        if (method === "put" && (referenceLibrary.isBusy() || (await store.listActiveTasks()).length)) {
          return res.status(409).json({ error: "当前有 AI 任务正在运行或排队，请完成或停止后再修改接入设置，避免同一任务混用模型" });
        }
        res.json(await v1.request(`/api/settings/ai${suffix}`, {
          method: method.toUpperCase(), ...(method !== "get" ? { body: req.body || {} } : {}), timeoutMs: 60000
        }));
      } catch (error) { res.status(error.statusCode || 503).json({ error: error.message }); }
      finally { req.releaseAiSettingsLock?.(); }
    });
  }
  app.post("/api/v2/style-references/upload", async (req, res) => {
    try { res.status(202).json({ reference: await referenceLibrary.upload(req, { bundleId: req.query.bundleId }) }); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.get("/api/v2/style-references/:id", async (req, res) => {
    try { res.set("Cache-Control", "no-store").json({ reference: await referenceLibrary.get(req.params.id) }); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  for (const [suffix, method] of [["retry", "retry"], ["selection", "select"], ["configuration", "configure"]]) {
    app.post(`/api/v2/style-references/:id/${suffix}`, async (req, res) => {
      try { res.json({ reference: await referenceLibrary[method](req.params.id, req.body || {}) }); }
      catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
    });
  }
  app.get("/api/v2/style-references/:id/files/:fileId/image", async (req, res) => {
    try { res.set("Cache-Control", "no-store").sendFile(await referenceLibrary.originalFile(req.params.id, req.params.fileId)); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.get("/api/v2/style-references/:id/pages/:pageId/image", async (req, res) => {
    try { res.set("Cache-Control", "no-store").sendFile(await referenceLibrary.file(req.params.id, req.params.pageId)); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.post("/api/v2/projects/:slug/style-reference", async (req, res) => {
    try {
      const reference = req.body?.bundleId ? await referenceLibrary.get(req.body.bundleId) : null;
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = opened.deck || opened;
      const removingActiveReference = !reference && Boolean(deck.styleProfile?.referenceBundleId);
      if ((await store.listTasks(req.params.slug, 100)).some((task) => ["queued", "running"].includes(task.status))) {
        return res.status(409).json({ error: "当前任务仍在运行，请完成或停止后再修改参考" });
      }
      const nextDeck = removingActiveReference ? deckAfterStyleChange(deck, initialStyleProfile(deck.styleProfile)) : deck;
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: {
        ...nextDeck, styleReference: reference ? { bundleId: reference.id } : null
      } } });
      res.json({ deck: saved.deck || saved });
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
  });
  app.use(express.static(process.env.PPT_V2_STATIC_DIR || path.join(V2_DIR, "public")));
  // Expose only browser-safe modules, never the entire shared directory.
  if (!process.env.PPT_V2_STATIC_DIR) app.get("/shared/reference-style-catalog.js", (_req, res) => res.sendFile(path.join(WORKBENCH_DIR, "shared/reference-style-catalog.js")));
  if (!process.env.PPT_V2_STATIC_DIR) app.get("/shared/task-lifecycle-contract.js", (_req, res) => res.sendFile(path.resolve(V2_DIR, "..", "shared", "task-lifecycle-contract.js")));
  if (!process.env.PPT_V2_STATIC_DIR) app.get("/shared/task-domain-reducer.js", (_req, res) => res.sendFile(path.resolve(V2_DIR, "..", "shared", "task-domain-reducer.js")));

  // The public V2 endpoint remains compatible with local service health probes.
  app.get("/api/health", async (req, res) => {
    try {
      const engine = await v1.request("/api/health");
      if (!cloudMode() && !req.localAuthenticated) return res.json({ ok: true, ui: 'v2', buildId: WORKBENCH_BUILD_ID, engine: 'connected' });
      res.json({ ok: true, ui: "v2", buildId: WORKBENCH_BUILD_ID, engine: "connected", engineHealth: engine, dataDir: taskDataDir });
    } catch (error) {
      if (!cloudMode() && !req.localAuthenticated) return res.status(503).json({ ok: false, ui: 'v2', engine: 'unavailable' });
      res.status(503).json({ ok: false, ui: "v2", engine: "unavailable", error: error.message, dataDir: taskDataDir });
    }
  });

  if (process.env.PPT_CLOUD_MODE === '1') app.get('/api/v2/runtime/idle', async (_req, res) => {
    try {
      const engine = await v1.request('/api/health');
      const tasks = await store.listActiveTasks();
      res.json({ idle: engine.busy === false && !referenceLibrary.isBusy() && tasks.length === 0 && activeMutationRequests === 0 });
    } catch { res.status(503).json({ idle: false }); }
  });

  app.get("/api/v2/health", async (_req, res) => {
    try {
      await v1.request("/api/health");
      res.json({ ok: true, v1: "connected", dataDir: taskDataDir });
    } catch (error) {
      res.status(503).json({ ok: false, v1: "unavailable", error: error.message });
    }
  });

  app.get("/api/v2/data-migration/status", async (_req, res) => {
    try {
      res.json(await v1.request("/api/data-migration/status"));
    } catch (error) {
      res.status(503).json({ error: `旧项目迁移服务不可用：${error.message}` });
    }
  });

  app.post("/api/v2/data-migration/run", async (_req, res) => {
    try {
      res.json(await v1.request("/api/data-migration/run", { method: "POST" }));
    } catch (error) {
      res.status(500).json({ error: `旧项目迁移失败：${error.message}` });
    }
  });

  app.get("/api/v2/projects", async (_req, res) => {
    try {
      const payload = await v1.request("/api/projects");
      res.json(payload);
    } catch (error) {
      res.status(503).json({ error: `V1 项目服务不可用：${error.message}` });
    }
  });

  app.post("/api/v2/documents/upload", async (req, res) => {
    try {
      const document = await v1.uploadMultipart("/api/documents/upload", req);
      res.status(201).json({ document });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/v2/documents/recommend-page-count", async (req, res) => {
    const { sourcePath, text, stats, narrativeMode } = req.body || {};
    if (!sourcePath || !text) return res.status(400).json({ error: "请先上传并读取文档" });
    try {
      const payload = await v1.request("/api/documents/recommend-page-count", {
        method: "POST",
        body: { sourcePath, text, stats, narrativeMode }
      });
      res.json(payload);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/open", async (req, res) => {
    try {
      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      res.json(payload);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.get("/api/v2/projects/:slug/deck", async (req, res) => {
    try {
      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      res.json({ deck: payload.deck || payload });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.get("/api/v2/projects/:slug/history", async (req, res) => {
    try { res.json(await v1.request(`/api/projects/${encodeURIComponent(req.params.slug)}/history`, { timeoutMs: 15000 })); }
    catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
  });
  app.post("/api/v2/projects/:slug/history/restore", async (req, res) => {
    try { res.json(await v1.request(`/api/projects/${encodeURIComponent(req.params.slug)}/history/restore`, { method: "POST", body: req.body, timeoutMs: 15000 })); }
    catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
  });

  for (const method of ["get", "post"]) app[method]("/api/v2/projects/:slug/export-previews/:jobId", async (req, res) => {
    try {
      const payload = await v1.request(`/api/projects/${encodeURIComponent(req.params.slug)}/export-previews/${encodeURIComponent(req.params.jobId)}`,
        { method: method.toUpperCase(), ...(method === "post" ? { body: {} } : {}), timeoutMs: 15000 });
      res.json(payload);
    } catch (error) { res.status(error.statusCode || error.status || 502).json({ error: error.message }); }
  });

  app.get("/api/v2/deck/latest", async (_req, res) => {
    try {
      const payload = await v1.request("/api/deck/latest");
      res.json({ deck: payload.deck || null });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.delete("/api/v2/projects/:slug", async (req, res) => {
    try {
      const tasks = await store.listTasks(req.params.slug, 500);
      if (tasks.some((task) => ["queued", "running"].includes(task.status))) {
        return res.status(409).json({ error: "项目仍有任务运行，请等待任务结束后再删除" });
      }
      const payload = await v1.request(`/api/projects/${encodeURIComponent(req.params.slug)}`, { method: "DELETE" });
      // The engine moved the project to recoverable trash. Keep independent
      // task audit records so restoration doesn't silently lose its history.
      res.json({ ...payload, taskRecordsRemoved: 0, taskRecordsRetained: true });
    } catch (error) {
      res.status(error.statusCode || (/不存在/.test(error.message) ? 404 : 400)).json({ error: error.message });
    }
  });

  app.delete("/api/v2/projects", async (req, res) => {
    if (req.body?.confirm !== "DELETE_ALL_PROJECTS") {
      return res.status(400).json({ error: "缺少清空全部项目的确认标识" });
    }
    try {
      const { projects = [] } = await v1.request("/api/projects");
      for (const project of projects) {
        const tasks = await store.listTasks(project.slug, 500);
        if (tasks.some((task) => ["queued", "running"].includes(task.status))) {
          return res.status(409).json({ error: `“${project.title || project.slug}”仍有任务运行，请等待任务结束后再清空` });
        }
      }
      const payload = await v1.request("/api/projects", {
        method: "DELETE",
        body: { confirm: "DELETE_ALL_PROJECTS" }
      });
      res.json({ ...payload, taskProjectsRemoved: 0, taskRecordsRetained: true });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/api/v2/style-previews/:styleId/meta", (req, res) => {
    const definition = STYLE_PREVIEW_DEFINITIONS[req.params.styleId];
    if (!definition) return res.status(404).json({ error: "未找到该母版预览" });
    const masterPack = executableMasterPack();
    res.json({
      styleId: req.params.styleId,
      previewCount: definition.referenceOnly ? 1 : MASTER_PAGE_ROLES.length,
      referenceOnly: Boolean(definition.referenceOnly),
      styleSystem: definition.pack?.styleSystem,
      roleGuidance: definition.pack?.roleGuidance,
      roles: definition.referenceOnly ? [{ id: "reference", label: "风格参考" }] : MASTER_PAGE_ROLES,
      masterPack: {
        id: req.params.styleId,
        executablePackId: masterPack.id,
        version: masterPack.version,
        label: definition.label,
        contract: {
          ...masterContractForPack(masterPack),
          id: req.params.styleId
        }
      }
    });
  });

  app.get("/api/v2/style-previews/:styleId/slides/:slideNumber", (req, res) => {
    const definition = STYLE_PREVIEW_DEFINITIONS[req.params.styleId];
    const slideNumber = Number(req.params.slideNumber);
    if (!definition || !Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > (definition.referenceOnly ? 1 : MASTER_PAGE_ROLES.length)) {
      return res.status(404).json({ error: "未找到该母版页面" });
    }
    sendStylePreviewImage(res, definition.referenceOnly ? `${definition.basePath}/reference.png` : `${definition.basePath}/slides/slide-${slideNumber}.png`);
  });

  app.get("/api/v2/style-previews/:styleId", (req, res) => {
    const definition = STYLE_PREVIEW_DEFINITIONS[req.params.styleId];
    if (!definition) return res.status(404).json({ error: "未找到该母版预览" });
    sendStylePreviewImage(res, `${definition.basePath}/${definition.referenceOnly ? "reference" : "montage"}.png`);
  });

  app.post("/api/v2/projects/:slug/style", async (req, res) => {
    try {
      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = payload.deck || payload;
      const selection = req.body?.styleProfile || {};
      const referenceProfile = selection.referenceBundleId ? await referenceLibrary.profile(selection.referenceBundleId) : null;
      if (referenceProfile && (referenceProfile.id !== selection.id || referenceProfile.referenceVersion !== selection.referenceVersion)) {
        return res.status(409).json({ error: "参考设置已更新，请刷新并重新确认风格" });
      }
      const active = (await store.listTasks(req.params.slug, 100)).some((task) => ["queued", "running"].includes(task.status) && task.kind !== "split");
      if (active && deck.styleProfile?.id !== selection.id) return res.status(409).json({ error: "当前页面仍在生成，请完成或停止后再应用新风格" });
      const styleProfile = styleProfileForPack(selection, deck.styleProfile || {}, referenceProfile);
      const styledDeck = deckAfterStyleChange(deck, styleProfile);
      if (referenceProfile) styledDeck.styleReference = { bundleId: referenceProfile.referenceBundleId };
      const saved = await v1.request("/api/deck/save", {
        method: "POST",
        body: { deck: styledDeck }
      });
      res.json({ deck: saved.deck || saved });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/pages/:pageNo/rewrite-preview", async (req, res) => {
    const { instruction, expectedRevision } = req.body || {};
    if (typeof instruction !== "string" || !instruction.trim() || instruction.trim().length > 2000) return res.status(400).json({ error: "请输入 1–2000 字的修改要求" });
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return res.status(400).json({ error: "缺少有效项目版本，请重新载入" });
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnect);
    try {
      const candidate = await v1.request("/api/deck/rewrite-page-preview", { method: "POST", timeoutMs: 190_000, signal: controller.signal,
        body: { projectSlug: req.params.slug, pageNo: req.params.pageNo, instruction: instruction.trim(), expectedRevision } });
      if (!candidate?.copyBlueprint || candidate.pageNo !== req.params.pageNo || candidate.expectedRevision !== expectedRevision) throw new Error("单页候选与当前页面或版本不匹配，请重试");
      res.json({ copyBlueprint: candidate.copyBlueprint, expectedRevision, pageNo: candidate.pageNo });
    } catch (error) {
      if (!res.destroyed) res.status(error.statusCode || 502).json({ error: error.message });
    } finally { res.off("close", disconnect); }
  });

  app.post("/api/v2/projects/:slug/pages/:pageNo", async (req, res) => {
    try {
      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = payload.deck || payload;
      const pageNo = String(req.params.pageNo || "").trim();
      const pageIndex = (deck.pages || []).findIndex((page) => (page.pageNo || page.id) === pageNo);
      if (pageIndex < 0) return res.status(404).json({ error: "未找到要编辑的页面" });

      const currentPage = deck.pages[pageIndex];
      const currentCopy = pageCopyDraftFromPage(currentPage);
      const structured = req.body?.copyEditMode === "structured";
      const title = String((structured ? req.body.copyBlueprint?.title : req.body?.title) ?? currentCopy.title ?? currentPage.title ?? "").trim();
      if (!title) return res.status(400).json({ error: "页面主标题不能为空" });
      const subtitle = String((structured ? req.body.copyBlueprint?.subtitle : req.body?.subtitle) ?? currentCopy.subtitle ?? "").trim();
      const displayText = String(req.body?.displayText ?? currentCopy.displayText ?? "").trim();
      if (req.body?.expectedRevision !== undefined && Number(req.body.expectedRevision) !== Number(deck.storageRevision ?? deck.revision ?? 0)) {
        return res.status(409).json({ error: "项目已有更新，请重新载入后再编辑；本次修改未覆盖新版本" });
      }
      const draft = structured || req.body?.copyEditMode === "plain" ? req.body : { title, subtitle, displayText };
      if (isPageCopyDraftUnchanged(draft, currentPage)) {
        return res.json({ deck, page: summarizePage(currentPage), unchanged: true });
      }
      const { subtitle: _legacySubtitle, displayText: _legacyDisplayText, ...pageWithoutLegacyCopy } = currentPage;
      const copyBlueprint = consultingCopyFromDraft(draft, currentPage);
      const nextPage = {
        ...pageWithoutLegacyCopy,
        title,
        blocks: pageBlocksFromConsultingCopy(copyBlueprint),
        copyBlueprint,
        verbatimText: copyBlueprint.verbatimText,
        mainPoint: copyBlueprint.oneSentenceAnswer,
        pageLogic: copyBlueprint.pageLogic,
        audienceQuestion: copyBlueprint.audienceQuestion,
        contentEvidence: copyBlueprint.evidence,
        sourceExcerpt: copyBlueprint.sourceRefs,
        task: copyBlueprint.bridgeToNext || "",
        status: "draft"
      };
      const pages = [...deck.pages];
      pages[pageIndex] = nextPage;
      const editedDeck = invalidateEditedPage({ ...deck, pages }, pageNo);
      const saved = await v1.request("/api/deck/save", {
        method: "POST",
        body: {
          deck: {
            ...editedDeck,
            contentOutline: deriveContentOutlineFromDeck(editedDeck)
          }
        }
      });
      const savedDeck = saved.deck || saved;
      const savedPage = (savedDeck.pages || []).find((page) => (page.pageNo || page.id) === pageNo) || nextPage;
      res.json({ deck: savedDeck, page: summarizePage(savedPage) });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/pages/:pageNo/delete", async (req, res) => {
    try {
      const { expectedRevision, expectedPageId } = req.body || {};
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof expectedPageId !== 'string' || !expectedPageId.trim()) {
        return res.status(400).json({ error: '缺少页面版本信息，请重新载入项目后再删除' });
      }
      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = payload.deck || payload;
      if (expectedRevision !== Number(deck.storageRevision ?? deck.revision ?? 0)) {
        return res.status(409).json({ error: '项目内容已更新，请重新载入后再删除，避免误删重新编号的页面' });
      }
      if (!Array.isArray(deck.pages) || deck.pages.length <= 1) {
        return res.status(409).json({ error: "至少需要保留 1 页" });
      }
      const requestedPageNo = String(req.params.pageNo || "").trim();
      const pageIndex = deck.pages.findIndex((page) => (page.pageNo || page.id) === requestedPageNo);
      if (pageIndex < 0) return res.status(404).json({ error: "未找到要删除的页面" });
      if ((deck.pages[pageIndex].id || deck.pages[pageIndex].pageNo) !== expectedPageId) {
        return res.status(409).json({ error: '页面已变化，请重新载入项目后再删除' });
      }

      const nextDeck = deckAfterStructureChange(
        deck,
        deck.pages.filter((_, index) => index !== pageIndex)
      );
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: nextDeck } });
      const savedDeck = saved.deck || saved;
      const selectedPage = savedDeck.pages[Math.min(pageIndex, savedDeck.pages.length - 1)] || savedDeck.pages[0];
      res.json({
        deck: savedDeck,
        pages: savedDeck.pages.map(summarizePage),
        selectedPageNo: selectedPage?.pageNo || selectedPage?.id || "",
        message: `${requestedPageNo} 已删除，页面已重新编号`
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/pages/actions/merge", async (req, res) => {
    try {
      const { expectedRevision, expectedSourcePageId, expectedTargetPageId } = req.body || {};
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || typeof expectedSourcePageId !== 'string' || !expectedSourcePageId.trim()
        || typeof expectedTargetPageId !== 'string' || !expectedTargetPageId.trim()) {
        return res.status(400).json({ error: '缺少页面版本信息，请重新载入项目后再合并' });
      }
      const sourcePageNo = String(req.body?.sourcePageNo || "").trim();
      const targetPageNo = String(req.body?.targetPageNo || "").trim();
      if (!sourcePageNo || !targetPageNo) return res.status(400).json({ error: "请选择来源页和目标页" });
      if (sourcePageNo === targetPageNo) return res.status(400).json({ error: "来源页和目标页不能相同" });

      const payload = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = payload.deck || payload;
      if (expectedRevision !== Number(deck.storageRevision ?? deck.revision ?? 0)) {
        return res.status(409).json({ error: '项目内容已更新，请重新载入后再合并，避免选错重新编号的页面' });
      }
      const sourcePage = (deck.pages || []).find((page) => (page.pageNo || page.id) === sourcePageNo);
      const targetPage = (deck.pages || []).find((page) => (page.pageNo || page.id) === targetPageNo);
      if (!sourcePage || !targetPage) return res.status(404).json({ error: "没有找到要合并的页面" });
      if ((sourcePage.id || sourcePage.pageNo) !== expectedSourcePageId || (targetPage.id || targetPage.pageNo) !== expectedTargetPageId) {
        return res.status(409).json({ error: '页面已变化，请重新载入项目后再合并' });
      }

      const merged = await v1.request("/api/deck/merge-codex", {
        method: "POST",
        body: { deck, sourcePageId: sourcePage.id, targetPageId: targetPage.id }
      });
      const mergedDeck = merged.deck || merged;
      const nextDeck = deckAfterStructureChange(mergedDeck, mergedDeck.pages || []);
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: nextDeck } });
      const savedDeck = saved.deck || saved;
      const mergedPage = savedDeck.pages.find((page) => page.id === merged.mergedPageId)
        || savedDeck.pages.find((page) => (page.pageNo || page.id) === targetPageNo)
        || savedDeck.pages[0];
      res.json({
        deck: savedDeck,
        pages: savedDeck.pages.map(summarizePage),
        mergedPageNo: mergedPage?.pageNo || mergedPage?.id || "",
        message: merged.message || `${sourcePageNo} 已合并到 ${targetPageNo}，AI 已重写目标页文案`
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.get("/api/v2/artifacts/file", async (req, res) => {
    const requestedPath = String(req.query.path || "").trim();
    if (!requestedPath) return res.status(400).json({ error: "缺少文件路径" });
    await proxyArtifactFile({ v1, requestedPath, res });
  });

  app.post("/api/v2/tasks/split/from-project", async (req, res) => {
    const projectSlug = String(req.body?.projectSlug || "").trim();
    if (!projectSlug) return res.status(400).json({ error: "缺少项目标识" });
    const { targetPageCount, contentDetailMode, narrativeMode } = req.body || {};
    if (!Number.isInteger(targetPageCount) || targetPageCount < 3 || targetPageCount > 60) return res.status(400).json({ error: "页数应为 3 到 60 的整数" });
    if (!ALL_CONTENT_DETAIL_MODES.includes(contentDetailMode) || !ALL_NARRATIVE_MODES.includes(narrativeMode)) return res.status(400).json({ error: "请选择有效的内容详略和讲述结构" });
    try {
      const admitted = await splitAdmission.run(projectSlug, async () => {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
      const deck = opened.deck || opened;
      if (!deck?.sourcePath) throw Object.assign(new Error("当前项目没有可重新读取的源文档"), { statusCode: 409 });
      const document = await v1.request("/api/documents/read", { method: "POST", body: { path: deck.sourcePath } });
      if (!document?.text) throw Object.assign(new Error("源文档没有可用于拆分的文本内容"), { statusCode: 409 });
      // Configuration belongs to this new request, not a premature deck save.
      // Admission reuses an active task before this callback, preserving its input.
      const requestDeck = { ...deck, styleProfile: { ...deck.styleProfile,
        targetPageCount, targetPageCountMode: "custom", contentDetailMode, narrativeMode } };
      const task = await splitWorker.enqueue({ projectSlug, deck: requestDeck, document });
      // Admission serializes outbox creation only. The persisted engine queue
      // and its process lease, not this HTTP promise, own the execution.
      return { task, completion: Promise.resolve() };
      });
      res.status(202).json({ task: admitted.task, reused: admitted.reused, message: admitted.reused ? "正在继续已有拆页任务，使用该任务原有设置" : "拆页任务已创建" });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/tasks/split/from-document", async (req, res) => {
    const { sourcePath, text, stats, narrativeMode, contentDetailMode, targetPageCount, referenceBundleId } = req.body || {};
    if (!sourcePath || !text) return res.status(400).json({ error: "请先上传并读取文档" });
    if (!Number.isInteger(Number(targetPageCount)) || Number(targetPageCount) < 3 || Number(targetPageCount) > 60) return res.status(400).json({ error: "页数应为 3 到 60 的整数" });
    const styleProfile = initialStyleProfile({ narrativeMode, contentDetailMode, targetPageCount });
    const typographyScale = defaultTypographyScale();
    try {
      const reference = referenceBundleId ? await referenceLibrary.get(referenceBundleId) : null;
      // The quick local plan gives V2 a stable project identity before Codex streams pages.
      const seeded = await v1.request("/api/deck/analyze", {
        method: "POST",
        body: { sourcePath, text, styleProfile, typographyScale }
      });
      let deck = seeded.deck || seeded;
      if (reference) {
        const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: { ...deck, styleReference: { bundleId: reference.id } } } });
        deck = saved.deck || saved;
      }
      const projectSlug = deck.project?.slug;
      if (!projectSlug) throw new Error("无法为该文档创建本地项目");
      const task = await splitWorker.enqueue({ projectSlug, deck, document: { text, stats } });
      res.status(202).json({ task, project: { slug: projectSlug, title: deck.title || "未命名演示文稿" } });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/tasks/generate/from-project", async (req, res) => {
    const projectSlug = String(req.body?.projectSlug || "").trim();
    const scope = String(req.body?.scope || "image-needed");
    const phase = String(req.body?.phase || "full");
    const pageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String).filter(Boolean) : [];
    if (!projectSlug) return res.status(400).json({ error: "缺少项目标识" });
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
      const deck = opened.deck || opened;
      if (!deck?.pages?.length) return res.status(409).json({ error: "当前项目没有可生成的页面" });
      if (!isStyleProfileConfirmed(deck.styleProfile)) {
        return res.status(409).json({ error: "请先选择并锁定母版，再生成页面" });
      }
      const task = await startV2GenerationTask({ store, v1, projectSlug, deck, scope, phase, pageIds });
      res.status(202).json({ task });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/tasks/image2-compile/from-project", async (req, res) => {
    const projectSlug = String(req.body?.projectSlug || "").trim();
    if (!projectSlug) return res.status(400).json({ error: "缺少项目标识" });
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
      const deck = opened.deck || opened;
      if (!deck?.pages?.length) return res.status(409).json({ error: "当前项目没有可编译的页面" });
      const reference = req.body?.referenceBundleId ? await referenceLibrary.get(req.body.referenceBundleId) : null;
      if (reference && (deck.styleReference?.bundleId !== reference.id || (req.body.referenceVersion && req.body.referenceVersion !== reference.version))) {
        return res.status(409).json({ error: "参考已变化，请返回第三步重新确认" });
      }
      if (!reference && !isStyleProfileConfirmed(deck.styleProfile)) {
        return res.status(409).json({ error: "请先选择并锁定 Image2 风格" });
      }
      const activeTasks = await store.listTasks(projectSlug, 100);
      const selectedStyleId = reference?.profileId || deck.styleProfile?.id;
      const sameStyleTask = reference
        ? activeTasks.find((task) => task.kind === "image2-compile" && ["queued", "running"].includes(task.status) && task.input?.referenceBundleId === reference.id)
        : findActiveImage2CompileTask(activeTasks, selectedStyleId);
      if (sameStyleTask) return res.status(202).json({ task: sameStyleTask, reused: true });
      const conflictingTask = reference ? activeTasks.find((task) => ["queued", "running"].includes(task.status)) : findConflictingImage2CompileTask(activeTasks, selectedStyleId);
      if (conflictingTask) {
        return res.status(409).json({ error: "已有另一风格的视觉计划正在生成，请等待完成后再切换风格" });
      }
      const task = await store.createTask({
        projectSlug,
        kind: "image2-compile",
        input: { deckId: deck.deckId || "", styleId: selectedStyleId || "", ...(reference ? { referenceBundleId: reference.id, referenceVersion: reference.version } : {}) }
      });
      res.status(202).json({ task });
      void runImage2CompileTask({ store, v1, projectSlug, taskId: task.taskId, deck, referenceLibrary, reference });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/image2/anchors/:kind/confirm", async (req, res) => {
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const result = await v1.request("/api/image2/anchors/confirm", {
        method: "POST",
        body: { deck: opened.deck || opened, kind: req.params.kind }
      });
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/image2/anchors/:kind/generate-missing", async (req, res) => {
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const deck = opened.deck || opened;
      const missing = missingImage2AnchorGeneration(deck, req.params.kind);
      if (missing.error) return res.status(missing.status).json({ error: missing.error });
      const task = await startV2GenerationTask({
        store,
        v1,
        projectSlug: req.params.slug,
        deck,
        scope: "selected",
        phase: "anchors",
        pageIds: [missing.pageId],
        reuseActive: false,
        operation: "missing-anchor-generation"
      });
      res.status(202).json({ task, deck, pageNo: missing.pageNo });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/image2/anchors/:kind/restore-binding", async (req, res) => {
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const restored = restoreImage2AnchorBinding(opened.deck || opened, req.params.kind);
      if (restored.error) return res.status(restored.status).json({ error: restored.error });
      if (!restored.changed) return res.json({ deck: restored.deck, pageNo: restored.pageNo, path: restored.path, changed: false });
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: restored.deck } });
      res.json({ deck: saved.deck || saved, pageNo: restored.pageNo, path: restored.path, changed: true });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/image2/anchors/:kind/regenerate", async (req, res) => {
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const reset = await v1.request("/api/image2/anchors/regenerate", {
        method: "POST",
        body: { deck: opened.deck || opened, kind: req.params.kind, feedback: req.body?.feedback }
      });
      const anchor = reset.styleAnchors?.[req.params.kind];
      if (!anchor?.pageId) return res.status(409).json({ error: "没有找到对应的视觉锚点页面" });
      const task = await startV2GenerationTask({
        store,
        v1,
        projectSlug: req.params.slug,
        deck: reset.deck,
        scope: "image-needed",
        phase: "anchors",
        pageIds: [anchor.pageId],
        reuseActive: false,
        operation: "anchor-regeneration"
      });
      res.status(202).json({ task, deck: reset.deck });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/image2/pages/:pageNo/regenerate", async (req, res) => {
    const feedback = String(req.body?.feedback || "").trim();
    if (feedback.length < 2) return res.status(400).json({ error: "请先填写 AI 修改提示词" });
    try {
      const tasks = await store.listTasks(req.params.slug, 100);
      if (tasks.some((task) => ["queued", "running", "cancelling"].includes(task.status))) {
        return res.status(409).json({ error: "当前项目仍有任务运行，请等待结束或停止后再重新生成；本次页面和已有图片未修改" });
      }
      await v1.request(`/api/generation/projects/${encodeURIComponent(req.params.slug)}/idle`);
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const prepared = preparePageRegeneration(opened.deck || opened, req.params.pageNo, feedback);
      if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: prepared.deck, generationPreparation: "page-regeneration" } });
      const savedDeck = saved.deck || saved;
      const task = await startV2GenerationTask({
        store,
        v1,
        projectSlug: req.params.slug,
        deck: savedDeck,
        scope: "selected",
        phase: "remaining",
        pageIds: [prepared.pageId],
        reuseActive: false,
        operation: "page-regeneration"
      });
      res.status(202).json({ task, deck: savedDeck, pageNo: prepared.pageNo });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/tasks/qa-export/from-project", async (req, res) => {
    const projectSlug = String(req.body?.projectSlug || "").trim();
    const requestedPageIds = Array.isArray(req.body?.pageIds) ? req.body.pageIds.map(String).filter(Boolean) : [];
    if (!projectSlug) return res.status(400).json({ error: "缺少项目标识" });
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
      const deck = opened.deck || opened;
      if (!deck?.pages?.length) return res.status(409).json({ error: "当前项目没有可检查的页面" });
      if (!isStyleProfileConfirmed(deck.styleProfile)) {
        return res.status(409).json({ error: "请先选择并锁定母版，再检查导出" });
      }
      const requested = new Set(requestedPageIds);
      const pageNos = (deck.pages || [])
        .filter((page) => requested.has(String(page.id || "")) || requested.has(String(page.pageNo || "")))
        .map((page) => String(page.pageNo || page.id || ""))
        .filter(Boolean);
      if (requestedPageIds.length && !pageNos.length) return res.status(409).json({ error: "没有找到本次需要复检的新生成页面" });
      const task = await store.createTask({
        projectSlug,
        kind: "qa-export",
        input: {
          deckId: deck.deckId || "",
          pageIds: pageNos,
          qaScope: pageNos.length ? "selected" : "full"
        }
      });
      res.status(202).json({ task });
      void runQaExportTask({ store, v1, projectSlug, taskId: task.taskId, deck, pageNos });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/export-direct", async (req, res) => {
    try {
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const prepared = prepareDirectExportDeck(opened.deck || opened);
      if (prepared.error) return res.status(prepared.status || 409).json({ error: prepared.error, missingPageNos: prepared.missingPageNos || [] });
      const deck = prepared.deck;
      const task = await store.createTask({
        projectSlug: req.params.slug,
        kind: "direct-export",
        input: {
          deckId: deck.deckId || "",
          skipQa: true,
          usedFallbackPageNos: prepared.usedFallbackPageNos || []
        }
      });
      res.status(202).json({ task });
      void runDirectExportTask({
        store,
        v1,
        projectSlug: req.params.slug,
        taskId: task.taskId,
        deck,
        usedFallbackPageNos: prepared.usedFallbackPageNos || []
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/tasks/:taskId/qa-decisions", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const decision = String(req.body?.decision || "").trim();
    const feedback = String(req.body?.feedback || "").trim().slice(0, 500);
    if (!key) return res.status(400).json({ error: "缺少问题页标识" });
    if (!["fix", "ignore"].includes(decision)) return res.status(400).json({ error: "请选择修复或不修复" });
    if (decision === "fix" && key === "deck") return res.status(409).json({ error: "整套问题请先重新检查，无法作为单页修复" });
    if (decision === "fix" && feedback.length < 2) return res.status(400).json({ error: "请先填写 AI 修改提示词" });
    try {
      const task = await store.getTask(req.params.slug, req.params.taskId);
      if (!task || task.kind !== "qa-export" || !task.qa) return res.status(404).json({ error: "检查任务不存在" });
      const allowedKeys = qaDecisionKeys(task.qa.issues || []);
      if (!allowedKeys.includes(key)) return res.status(409).json({ error: "该问题页不在本次检查结果中" });
      await store.append(req.params.slug, req.params.taskId, "qa.issue.decision", {
        key,
        pageNo: key === "deck" ? "" : key,
        decision,
        feedback: decision === "fix" ? feedback : "",
        decidedAt: new Date().toISOString()
      });
      res.json({ task: await store.getTask(req.params.slug, req.params.taskId) });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/tasks/:taskId/qa-fixes", async (req, res) => {
    try {
      const qaTask = await store.getTask(req.params.slug, req.params.taskId);
      if (!qaTask || qaTask.kind !== "qa-export" || !qaTask.qa) return res.status(404).json({ error: "检查任务不存在" });
      const review = qaDecisionSummary(qaTask.qa);
      if (review.unresolvedKeys.length) {
        return res.status(409).json({ error: `还有 ${review.unresolvedKeys.length} 个问题页未选择修复或不修复` });
      }
      if (!review.fixKeys.length) return res.status(409).json({ error: "没有待修复页面" });
      let fixKeys = review.fixKeys;
      const retryTaskId = String(req.body?.retryTaskId || "");
      if (retryTaskId) {
        const previous = await store.getTask(req.params.slug, retryTaskId);
        if (previous?.operation !== "qa-batch-regeneration" || previous.input?.parentTaskId !== qaTask.taskId
          || !["paused", "failed", "cancelled"].includes(previous.status)) {
          return res.status(409).json({ error: "原修复任务不匹配或仍在运行，请刷新后重试" });
        }
        const completed = new Set(previous.completedPageNos || []);
        const requested = new Set(previous.generationPageNos || previous.input?.pageIds || []);
        fixKeys = fixKeys.filter((pageNo) => requested.has(pageNo) && !completed.has(pageNo));
      }
      if (!fixKeys.length) return res.status(409).json({ error: "没有待重新修复的页面，请复检已生成页面" });
      const active = (await store.listTasks(req.params.slug, Number.MAX_SAFE_INTEGER))
        .some((task) => ["generation", "image2-compile"].includes(task.kind) && ["queued", "running"].includes(task.status));
      if (active) return res.status(409).json({ error: "当前仍有页面正在生成，请完成后再发起修复" });
      const selections = fixKeys.map((pageNo) => ({
        pageNo,
        feedback: qaTask.qa.decisions?.[pageNo]?.feedback || ""
      }));
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const prepared = prepareQaPageRegenerations(opened.deck || opened, selections);
      if (prepared.error) return res.status(prepared.status).json({ error: prepared.error });
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: prepared.deck } });
      const savedDeck = saved.deck || saved;
      const task = await startV2GenerationTask({
        store,
        v1,
        projectSlug: req.params.slug,
        deck: savedDeck,
        scope: "selected",
        phase: "remaining",
        pageIds: prepared.pageIds,
        reuseActive: false,
        operation: "qa-batch-regeneration",
        parentTaskId: qaTask.taskId
      });
      res.status(202).json({ task, deck: savedDeck, pageNos: prepared.pageNos, qaTaskId: qaTask.taskId });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post("/api/v2/projects/:slug/tasks/:taskId/export", async (req, res) => {
    try {
      const task = await store.getTask(req.params.slug, req.params.taskId);
      if (!task || task.kind !== "qa-export" || !task.qa) return res.status(404).json({ error: "请先完成页面一致性检查" });
      const review = qaDecisionSummary(task.qa);
      if (!review.canExport) {
        return res.status(409).json({ error: `还有 ${review.unresolvedKeys.length} 个问题页未确认修复或不修复` });
      }
      await store.append(req.params.slug, req.params.taskId, "task.started", { kind: "qa-export", status: "running" });
      res.status(202).json({ task: await store.getTask(req.params.slug, req.params.taskId) });
      void runReviewedExportTask({ store, v1, projectSlug: req.params.slug, taskId: req.params.taskId });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.get("/api/v2/projects/:slug/tasks", async (req, res, next) => {
    try {
      const tasks = await store.listTasks(req.params.slug, Number(req.query.limit) || 12);
      res.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v2/projects/:slug/tasks/:taskId", async (req, res) => {
    const task = await store.getTask(req.params.slug, req.params.taskId);
    if (!task) return res.status(404).json({ error: "任务不存在" });
    res.set("Cache-Control", "no-store");
    const after = Number(req.query.after);
    if (req.query.after !== undefined && Number.isSafeInteger(after) && after >= 0 && after === Number(task.lastEventId)) {
      return res.json({ task: null, unchanged: true, lastEventId: task.lastEventId });
    }
    res.json({ task });
  });

  for (const action of ["cancel", "resume"]) {
    app.post(`/api/v2/projects/:slug/tasks/:taskId/${action}`, async (req, res) => {
      try {
        const task = await store.getTask(req.params.slug, req.params.taskId);
        if (!task) return res.status(404).json({ error: "任务不存在" });
        if (action === "cancel" && ["generation", "image2-compile"].includes(task.kind)) {
          // Resolve the immutable task binding, never accept a batch ID from
          // the client or use whichever project is currently open in V1.
          if (["completed", "failed", "cancelled"].includes(task.status)) return res.json({ task });
          if (!task.batchId) return res.status(409).json({ error: "视觉计划尚未进入生图阶段，请等待页面生成开始后停止" });
          if (!["queued", "running"].includes(task.status)) return res.status(409).json({ error: "请先重新打开项目，确认原生成批次状态后停止" });
          const batchRoute = `/api/generation/batches/${encodeURIComponent(task.batchId)}`;
          const original = await v1.request(batchRoute);
          if (original.batch?.batchId !== task.batchId || original.deck?.project?.slug !== req.params.slug
            || (task.input?.deckId && original.deck?.deckId !== task.input.deckId)) {
            return res.status(409).json({ error: "原生图批次与当前项目不匹配，未执行停止" });
          }
          // The engine may finish between the click and this read. Reconcile
          // that original batch instead of turning a completed task cancelled.
          if (["completed", "completed-with-errors", "failed"].includes(original.batch.status)) {
            await runGenerationTask({ store, v1, projectSlug: req.params.slug, taskId: task.taskId,
              batchId: task.batchId, phase: task.generationPhase, activePageNos: task.generationPageNos || [] });
            return res.json({ task: await store.getTask(req.params.slug, task.taskId) });
          }
          if (!task.cancelRequested) await store.append(req.params.slug, task.taskId, "task.cancel.requested", {
            message: "正在停止生成，已返回的页面会保留"
          });
          const stopped = await v1.request(`${batchRoute}/cancel`, { method: "POST", timeoutMs: 15000, body: { reason: "用户停止生成" } });
          if (["interrupted", "completed", "completed-with-errors", "failed"].includes(stopped.batch?.status)) {
            await runGenerationTask({ store, v1, projectSlug: req.params.slug, taskId: task.taskId,
              batchId: task.batchId, phase: task.generationPhase, activePageNos: task.generationPageNos || [] });
          }
          const updated = await store.getTask(req.params.slug, req.params.taskId);
          return res.status(["queued", "running"].includes(updated.status) ? 202 : 200).json({ task: updated });
        }
        if (task.kind !== "split") return res.status(404).json({ error: "拆页任务不存在" });
        if (task.input?.workerProtocol !== "durable-split-v1") return res.status(409).json({ error: "旧任务没有持久请求快照，请使用重新拆页创建可取消、可续跑的任务" });
        const updated = await splitWorker[action](task);
        res.status(202).json({ task: updated });
      } catch (error) { res.status(error.statusCode || 502).json({ error: error.message }); }
    });
  }

  app.post("/api/v2/projects/:slug/tasks/:taskId/recover-content-outline", async (req, res) => {
    try {
      const task = await store.getTask(req.params.slug, req.params.taskId);
      if (!task || task.kind !== "split") return res.status(404).json({ error: "未找到可恢复的拆页任务" });
      if (!["failed", "paused", "interrupted"].includes(task.status)) return res.status(409).json({ error: "只能恢复已失败或中断的拆页任务" });
      const current = await v1.request("/api/projects/open", { method: "POST", body: { slug: req.params.slug } });
      const currentDeck = current.deck || current;
      if (!task.candidateId || (req.body?.candidateId && req.body.candidateId !== task.candidateId)) {
        return res.status(409).json({ error: "本任务没有已绑定的可恢复候选，请重新拆页" });
      }
      const source = await v1.request("/api/documents/read", { method: "POST", body: { path: currentDeck.sourcePath } });
      const currentInputHash = splitInputHash(source.text, currentDeck.styleProfile || {}, currentDeck.typographyScale || {});
      if (!task.input?.inputHash || task.input.inputHash !== currentInputHash || Number(task.input.baseRevision) !== Number(currentDeck.storageRevision ?? currentDeck.revision ?? 0)) {
        return res.status(409).json({ error: "旧任务的来源、配置或版本不匹配，请重新拆页" });
      }
      const recovered = await v1.request("/api/deck/recover-content-outline", {
        method: "POST",
        body: {
          candidateId: task.candidateId,
          taskId: task.taskId,
          inputHash: currentInputHash,
          deck: currentDeck,
          candidateLabel: req.body?.candidateLabel || "v2-task-recovery"
        }
      });
      const deck = recovered.deck || recovered;
      await store.append(req.params.slug, req.params.taskId, "split.completed", {
        status: "completed",
        candidateId: task.candidateId,
        pageCount: deck.pages?.length || 0,
        projectSlug: deck.project?.slug || req.params.slug,
        deck: deckSummary(deck),
        pages: (deck.pages || []).map(summarizePage)
      });
      res.json({ deck, task: await store.getTask(req.params.slug, req.params.taskId), recovered: true, validation: recovered.validation });
    } catch (error) {
      res.status(error.statusCode || 422).json({ error: error.message });
    }
  });

  app.get("/api/v2/projects/:slug/tasks/:taskId/events", async (req, res) => {
    const { slug, taskId } = req.params;
    const task = await store.getTask(slug, taskId);
    if (!task) return res.status(404).json({ error: "任务不存在" });
    const cursors = [req.query.after, req.headers["last-event-id"]].map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0);
    const after = Math.max(0, ...cursors);
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.flushHeaders();
    let replaying = true;
    let cursor = after;
    const pending = [];
    const emit = (event) => {
      if (event.id <= cursor || res.destroyed) return;
      cursor = event.id;
      sendSse(res, event);
    };
    const unsubscribe = store.subscribe(slug, taskId, (event) => replaying ? pending.push(event) : emit(event));
    try {
      for (const event of await store.listEvents(slug, taskId, after)) emit(event);
      replaying = false;
      for (const event of pending.sort((a, b) => a.id - b.id)) emit(event);
    } catch {
      unsubscribe();
      return res.end();
    }
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  return { app, store, v1, splitWorker };
}

export async function recoverV2GenerationTasks({ store, v1 }) {
  const payload = await v1.request("/api/projects");
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];
  const recovered = [];

  for (const project of projects) {
    const projectSlug = String(project?.slug || "").trim();
    if (!projectSlug) continue;
    const tasks = await store.listTasks(projectSlug, 100);
    for (const task of tasks) {
      if (!["generation", "image2-compile"].includes(task?.kind)) continue;
      if (task?.status !== "paused" || task?.recovery?.action !== "continue-generation" || !task?.batchId) continue;
      try {
        const batchPayload = await v1.request(`/api/generation/batches/${encodeURIComponent(task.batchId)}`);
        const batch = batchPayload.batch || {};
        if (batch.status === "interrupted") {
          await store.append(projectSlug, task.taskId, "task.paused", {
            status: "paused",
            action: "continue-generation",
            message: batch.interruptionReason || "原生成批次已停止；已返回的页面会保留，可按需继续剩余页面。"
          });
          continue;
        }
        const phase = batch.phase || task.generationPhase || task.input?.phase || "full";
        const jobs = batchPayload.jobs || {};
        const pageNos = generationPageNosForTask({ jobs }, task.input?.pageIds || [], phase, true);
        if (!pageNos.length) continue;
        await store.append(projectSlug, task.taskId, "generation.started", {
          status: "running",
          total: pageNos.length || batch.total,
          batchId: task.batchId,
          phase,
          pageNos,
          operation: task.input?.operation || ""
        });
        void runGenerationTask({
          store,
          v1,
          projectSlug,
          taskId: task.taskId,
          batchId: task.batchId,
          phase,
          activePageNos: pageNos
        });
        recovered.push({ projectSlug, taskId: task.taskId, batchId: task.batchId, pageNos });
      } catch (error) {
        console.warn(`V2 generation recovery skipped for ${projectSlug}/${task.taskId}: ${error.message}`);
      }
    }
  }
  return recovered;
}

async function startV2GenerationTask({ store, v1, projectSlug, deck, scope = "image-needed", phase = "full", pageIds = [], taskId = "", kind = "generation", reuseActive = true, operation = "", parentTaskId = "" }) {
  const started = await v1.request("/api/generation/start", {
    method: "POST",
    body: { deck, scope, phase, pageIds, reuseActive }
  });
  if (started.manual || !started.batch?.batchId) {
    throw new Error(started.message || "当前 AI 生图服务不可用，无法创建自动生成任务");
  }
  let activeTaskId = taskId;
  if (!activeTaskId) {
    const created = await store.createTask({
      projectSlug,
      kind,
      input: {
        batchId: started.batch.batchId,
        scope,
        phase: started.batch.phase || phase,
        pageIds,
        operation,
        parentTaskId,
        deckId: deck.deckId || ""
      }
    });
    activeTaskId = created.taskId;
  }
  const activePhase = started.batch.phase || phase;
  const activePageNos = generationPageNosForTask(started, pageIds, activePhase);
  const scopedTotal = activePageNos.length || started.batch.total || 0;
  await store.append(projectSlug, activeTaskId, "generation.started", {
    status: "running",
    total: scopedTotal,
    batchId: started.batch.batchId,
    phase: activePhase,
    pageNos: activePageNos,
    operation
  });
  void runGenerationTask({
    store,
    v1,
    projectSlug,
    taskId: activeTaskId,
    batchId: started.batch.batchId,
    phase: activePhase,
    activePageNos
  });
  return store.getTask(projectSlug, activeTaskId);
}

async function runImage2CompileTask({ store, v1, projectSlug, taskId, deck, referenceLibrary, reference }) {
  try {
    await store.append(projectSlug, taskId, "task.started", { kind: "image2-compile", status: "running" });
    if (reference) {
      await referenceLibrary.prepare(reference.id, { onProgress: async ({ status, analysisProgress }) => {
        if (!["parsing", "analyzing"].includes(status)) return;
        await store.append(projectSlug, taskId, "image2.compile.started", {
          status: "running", phase: `reference-${status}`,
          message: status === "parsing" ? "正在解析参考页面" : `正在分析参考的配色、字体和排版${analysisProgress ? ` · 已分析 ${analysisProgress.completed} / ${analysisProgress.total} 页` : ""}`
        });
      } });
      const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
      const current = opened.deck || opened;
      if (current.deckId !== deck.deckId || current.styleReference?.bundleId !== reference.id
        || Number(current.storageRevision ?? current.revision ?? 0) !== Number(deck.storageRevision ?? deck.revision ?? 0)) throw new Error("项目或参考已变化，请返回第三步重新确认");
      const profile = await referenceLibrary.profile(reference.id);
      if (profile.referenceVersion !== reference.version) throw new Error("参考已变化，请返回第三步重新确认");
      const styled = deckAfterStyleChange(current, styleProfileForPack(profile, current.styleProfile || {}, profile));
      styled.styleReference = { bundleId: reference.id };
      const saved = await v1.request("/api/deck/save", { method: "POST", body: { deck: styled } });
      deck = saved.deck || saved;
    }
    await store.append(projectSlug, taskId, "image2.compile.started", {
      status: "running",
      phase: "visual-compiling",
      message: "AI 正在把内容大纲编译为整套视觉计划"
    });
    const compiled = await v1.request("/api/image2/compile", { method: "POST", body: { deck } });
    const compiledDeck = compiled.deck || compiled;
    await store.append(projectSlug, taskId, "image2.compile.completed", {
      status: "running",
      phase: "anchors-pending",
      total: 2,
      deck: deckSummary(compiledDeck),
      planSignature: compiledDeck.image2RenderPlan?.signature || "",
      anchorPageIds: Object.values(compiledDeck.styleAnchors || {}).map((anchor) => anchor?.pageId).filter(Boolean)
    });
    await startV2GenerationTask({
      store,
      v1,
      projectSlug,
      deck: compiledDeck,
      scope: "image-needed",
      phase: "anchors",
      taskId,
      kind: "image2-compile"
    });
  } catch (error) {
    await store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
  }
}

export const runGenerationTask = createGenerationTaskRunner({ deckSummary });

function imagePathsForDeck(deck) {
  return (deck.pages || []).map((page) => page.finalImage?.path || page.finalImage?.source).filter(Boolean);
}

function exportRouteFor(deck) {
  return { path: "/api/export/pptx", imagePaths: imagePathsForDeck(deck) };
}

function summarizeQaIssue(issue = {}) {
  return {
    id: String(issue.id || "quality-issue"),
    category: String(issue.category || "quality"),
    severity: issue.severity === "high" ? "high" : "medium",
    pageNo: String(issue.pageNo || ""),
    title: String(issue.title || ""),
    message: String(issue.message || "质量检查未通过"),
    evidence: String(issue.evidence || ""),
    suggestion: String(issue.suggestion || ""),
    hardBlock: issue.hardBlock === true,
    autoRepairable: issue.autoRepairable === true,
    requiresDecision: issue.requiresDecision !== false
  };
}

function qaIssueRequiresDecision(issue = {}) {
  const category = String(issue.category || "");
  return issue.severity === "high"
    || category.startsWith("image2-visual-audit")
    || ["title-consistency", "visual-consistency", "style-consistency"].includes(category);
}

function expandQaIssueForPageReview(issue = {}, deck = {}) {
  const requiresDecision = qaIssueRequiresDecision(issue);
  const summarized = summarizeQaIssue({ ...issue, requiresDecision });
  if (summarized.id === "image2-visual-audit-score") return [summarized];
  if (summarized.pageNo || !requiresDecision) return [summarized];
  const referencedPages = [...new Set(String(issue.evidence || "").match(/P\d{2}/g) || [])]
    .filter((pageNo) => (deck.pages || []).some((page) => page.pageNo === pageNo));
  if (!referencedPages.length) return [summarized];
  return [
    { ...summarized, requiresDecision: false },
    ...referencedPages.map((pageNo) => ({
      ...summarized,
      id: `${summarized.id}-${pageNo.toLowerCase()}`,
      pageNo,
      title: (deck.pages || []).find((page) => page.pageNo === pageNo)?.title || "",
      requiresDecision: true
    }))
  ];
}

async function runQaExportTask({ store, v1, projectSlug, taskId, deck, pageNos = [] }) {
  try {
    const scopedPageNos = [...new Set((pageNos || []).map(String).filter(Boolean))];
    const total = scopedPageNos.length || deck.pages?.length || 0;
    await store.append(projectSlug, taskId, "task.started", { kind: "qa-export", status: "running" });
    await store.append(projectSlug, taskId, "split.phase", {
      phase: "quality-check",
      total,
      scope: scopedPageNos.length ? "selected" : "full",
      pageNos: scopedPageNos
    });
    const imagePaths = imagePathsForDeck(deck);
    const qa = await v1.request("/api/qa/report", {
      method: "POST",
      body: { deck, imagePaths, pageNos: scopedPageNos }
    });
    const issues = (qa.qaReport?.issues || []).flatMap((issue) => expandQaIssueForPageReview(issue, qa.deck || deck));
    const blockers = issues.filter((issue) => issue.severity === "high");
    await store.append(projectSlug, taskId, "qa.completed", {
      status: qa.qaReport?.status || "pending",
      deck: deckSummary(qa.deck || deck),
      total,
      scope: scopedPageNos.length ? "selected" : "full",
      pageNos: scopedPageNos,
      generatedAt: qa.qaReport?.generatedAt || new Date().toISOString(),
      summary: qa.qaReport?.summary || null,
      checks: qa.qaReport?.checks || [],
      issues,
      blockers: blockers.map((issue) => issue.message),
      warnings: issues.filter((issue) => issue.severity !== "high").map((issue) => issue.message)
    });
    if (issues.some((issue) => issue.requiresDecision)) {
      await store.append(projectSlug, taskId, "task.completed", {
        status: "completed",
        phase: "qa-awaiting-decisions"
      });
      return;
    }
    const readyDeck = qa.deck || deck;
    const target = exportRouteFor(readyDeck);
    const exported = await v1.request(target.path, {
      method: "POST",
      body: { deck: readyDeck, imagePaths: target.imagePaths, purpose: "final" }
    });
    await store.append(projectSlug, taskId, "export.completed", {
      path: exported.path || "",
      preview: exported.preview || null,
      deck: deckSummary(exported.deck || readyDeck)
    });
    await store.append(projectSlug, taskId, "task.completed", { status: "completed" });
  } catch (error) {
    await store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
  }
}

async function runReviewedExportTask({ store, v1, projectSlug, taskId }) {
  try {
    const opened = await v1.request("/api/projects/open", { method: "POST", body: { slug: projectSlug } });
    const deck = opened.deck || opened;
    const target = exportRouteFor(deck);
    const exported = await v1.request(target.path, {
      method: "POST",
      body: { deck, imagePaths: target.imagePaths, purpose: "final", qaOverride: true }
    });
    await store.append(projectSlug, taskId, "export.completed", {
      path: exported.path || "",
      preview: exported.preview || null,
      deck: deckSummary(exported.deck || deck)
    });
    await store.append(projectSlug, taskId, "task.completed", { status: "completed" });
  } catch (error) {
    await store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
  }
}

async function runDirectExportTask({ store, v1, projectSlug, taskId, deck, usedFallbackPageNos = [] }) {
  try {
    const total = deck.pages?.length || 0;
    await store.append(projectSlug, taskId, "task.started", { kind: "direct-export", status: "running", total });
    await store.append(projectSlug, taskId, "split.phase", {
      phase: "direct-export",
      message: `正在打包当前 ${total} 页，已跳过全部质量检查`,
      total
    });
    const target = exportRouteFor(deck);
    const exported = await v1.request(target.path, {
      method: "POST",
      body: { deck, imagePaths: target.imagePaths, purpose: "direct", qaOverride: true }
    });
    await store.append(projectSlug, taskId, "export.completed", {
      path: exported.path || "",
      preview: exported.preview || null,
      deck: deckSummary(exported.deck || deck),
      total,
      skippedQa: true,
      usedFallbackPageNos
    });
    await store.append(projectSlug, taskId, "task.completed", { status: "completed" });
  } catch (error) {
    await store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PPT_V2_PORT || 5182);
  const { app } = createV2App();
  app.listen(port, "127.0.0.1", () => {
    console.log(`610PPT V2 local workspace: http://127.0.0.1:${port}`);
  });
}
