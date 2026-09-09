import crypto from "node:crypto";
import { MASTER_PACK_ROLES } from "./master-packs.js";
import { IMAGE2_VISUAL_CONTRACT_VERSION, image2VisualContractPrompt } from "./image2-visual-contract.js";
import { isImage2CoverPage } from "./image2-cover-contract.js";

export const IMAGE2_RENDER_PLAN_SCHEMA_VERSION = "3.0";
export const IMAGE2_TAKEAWAY_MODES = Object.freeze(["none", "side-note", "inline", "bottom-bar"]);
export const IMAGE2_DENSITIES = Object.freeze(["low", "medium", "high"]);
import { IMAGE2_VISUAL_CONTRACT_VERSION as IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION } from "./image2-visual-contract.js";
export { IMAGE2_VISUAL_CONTRACT_VERSION as IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION } from "./image2-visual-contract.js";
export const IMAGE2_CONTENT_ANCHOR_LOCKS = Object.freeze([
  "主背景色、纸张纹理与整体材质",
  "页面外边框、外部安全边距与标题对齐线",
  "正文页标题位置与基线",
  "标题视觉字号、字体角色、字重与行距",
  "分隔线的线宽和颜色；位置、长度和文字间距按本页内容自由安排，保证清楚可读",
  "主辅配色比例与强调色使用规则",
  "线稿图标描边、圆角、边框与组件语言",
  "文字清晰可读、不拥挤"
]);
export const IMAGE2_CONTENT_ANCHOR_FORBIDDEN_COPY = Object.freeze([
  "锚点页标题、副标题、展示文字和数字",
  "锚点页内部页码",
  "锚点页卡片数量与信息布局",
  "锚点页底部结论区中的文字、数字和事实内容"
]);

export function sanitizeImage2StyleDetectionSurface(value = "") {
  return String(value || "")
    .split(/[；;。\n]/)
    .filter((clause) => !/(?:禁止|不得|避免|不使用|不要|排除|不可)[^；;。\n]*$/i.test(clause))
    .join("\n");
}

function clean(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function image2PlanSignature(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function roleForOutlinePage(page, index, pages, coverMode = "auto") {
  if (page.pageRole === "cover" || (index === 0 && coverMode !== "none")) return "cover";
  if (["agenda", "section-divider"].includes(page.pageRole)) return "directory";
  if (index === pages.length - 1 || ["takeaway", "action", "checklist"].includes(page.pageRole)) return "conclusion";
  if ((page.evidence || []).some((item) => /(?:\d|%|倍|万|亿|小时|分钟)/.test(item))) return "data";
  if (["method", "step", "process", "attempt", "turning-point"].includes(page.pageRole)) return "process";
  return "content";
}

function defaultComposition(masterRole, page) {
  const consultingLogic = {
    comparison: "side-by-side-comparison",
    framework: "layered-framework",
    process: "flow-or-relationship",
    timeline: "timeline",
    matrix: "decision-matrix",
    ladder: "progression-ladder",
    case: "case-evidence-board",
    roadmap: "phased-roadmap",
    maturity: "maturity-ladder",
    conclusion: "closing-statement"
  }[page.pageLogic || page.copyBlueprint?.pageLogic];
  if (consultingLogic) return consultingLogic;
  if (masterRole === "cover") return "single-hero";
  if (masterRole === "directory") return "chapter-map";
  if (masterRole === "data") return "metric-story";
  if (masterRole === "process") return "flow-or-relationship";
  if (masterRole === "conclusion") return "closing-statement";
  return (page.displayText?.length || 0) >= 4 ? "structured-grid" : "focal-infographic";
}

function defaultTakeawayMode(page, masterRole) {
  if (masterRole === "cover" || masterRole === "directory") return "none";
  if (masterRole === "conclusion") return "inline";
  if (!page.coreClaim) return "none";
  if ((page.displayText?.length || 0) >= 5) return "side-note";
  return "inline";
}

export function buildImageRenderPlan(outline = {}, options = {}) {
  const pages = Array.isArray(outline.pages) ? outline.pages : [];
  const planPages = pages.map((page, index) => {
    const masterRole = roleForOutlinePage(page, index, pages, outline.coverMode);
    const lockedText = page.verbatimText || page.copyBlueprint?.verbatimText;
    const visibleText = (Array.isArray(lockedText) && lockedText.length)
      ? lockedText
      : [page.title, page.subtitle, page.coreClaim, ...(page.displayText || []), ...(page.evidence || [])].filter(Boolean);
    const density = masterRole === "cover" ? "low" : visibleText.length >= 9 ? "high" : visibleText.length >= 5 ? "medium" : "low";
    const base = {
      pageNo: page.pageNo,
      masterRole,
      compositionKind: defaultComposition(masterRole, page),
      density,
      visibleText: [...visibleText],
      visualIntent: clean(page.copyBlueprint?.oneSentenceAnswer || page.coreClaim || page.title, 280),
      takeawayMode: defaultTakeawayMode(page, masterRole),
      masterReference: `${options.masterPackId || "image2-dark-tactical"}:${masterRole}`
    };
    return { ...base, promptSignature: image2PlanSignature(base) };
  });
  return {
    schemaVersion: IMAGE2_RENDER_PLAN_SCHEMA_VERSION,
    styleId: options.styleId || "",
    masterPackId: options.masterPackId || "image2-dark-tactical",
    masterPackVersion: options.masterPackVersion || "1.0.0",
    styleBibleVersion: options.styleBibleVersion || "6.0",
    renderContractVersion: options.renderContractVersion || "3.0",
    contentOutlineVersion: outline.schemaVersion || "1.0",
    pages: planPages,
    generatedAt: new Date().toISOString(),
    signature: image2PlanSignature(planPages)
  };
}

export function normalizeImageRenderPlan(payload = {}, outline = {}, options = {}) {
  const fallback = buildImageRenderPlan(outline, options);
  const rawPages = Array.isArray(payload.pages) ? payload.pages : [];
  const rawByPageNo = new Map(rawPages.map((page) => [clean(page?.pageNo, 20), page]));
  const pages = fallback.pages.map((base) => {
    const raw = rawByPageNo.get(base.pageNo) || {};
    const masterRole = MASTER_PACK_ROLES.includes(raw.masterRole) && !(outline.coverMode === "none" && raw.masterRole === "cover") ? raw.masterRole : base.masterRole;
    const density = IMAGE2_DENSITIES.includes(raw.density) ? raw.density : base.density;
    const takeawayMode = IMAGE2_TAKEAWAY_MODES.includes(raw.takeawayMode) ? raw.takeawayMode : base.takeawayMode;
    const normalized = {
      pageNo: base.pageNo,
      masterRole,
      compositionKind: clean(raw.compositionKind || base.compositionKind, 120),
      density: masterRole === "cover" ? "low" : density,
      visibleText: [...base.visibleText],
      visualIntent: clean(raw.visualIntent || base.visualIntent, 280),
      takeawayMode: masterRole === "cover" ? "none" : takeawayMode,
      masterReference: clean(raw.masterReference || `${options.masterPackId || fallback.masterPackId}:${masterRole}`, 160)
    };
    return { ...normalized, promptSignature: image2PlanSignature(normalized) };
  });
  const plan = {
    ...fallback,
    pages,
    generatedAt: new Date().toISOString(),
    signature: image2PlanSignature(pages)
  };
  return plan;
}

export function validateImageRenderPlan(plan = {}, outline = {}) {
  const issues = [];
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  if (plan.schemaVersion !== IMAGE2_RENDER_PLAN_SCHEMA_VERSION) issues.push("ImageRenderPlan 版本不是 3.0");
  if (pages.length !== outline.pages?.length) issues.push("视觉计划页数与内容大纲不一致");
  pages.forEach((page, index) => {
    const id = page.pageNo || `第 ${index + 1} 页`;
    if (!MASTER_PACK_ROLES.includes(page.masterRole)) issues.push(`${id} 使用了无效母版角色`);
    if (!IMAGE2_DENSITIES.includes(page.density)) issues.push(`${id} 使用了无效信息密度`);
    if (!IMAGE2_TAKEAWAY_MODES.includes(page.takeawayMode)) issues.push(`${id} 使用了无效总结模式`);
    if (!page.compositionKind) issues.push(`${id} 缺少构图类型`);
    if (!page.visibleText?.length) issues.push(`${id} 缺少可见文字计划`);
    if (page.visibleText?.length > 24) issues.push(`${id} 可见文字共 ${page.visibleText.length} 项，超过单页 24 项容量；请调整拆页或精简文案，未截断原文`);
    if (page.visibleText?.some((text) => String(text).length > 260)) issues.push(`${id} 存在超过 260 字的可见文字项；请拆成可读短句，未截断原文`);
    const expectedText = outline.pages?.[index]?.verbatimText || outline.pages?.[index]?.copyBlueprint?.verbatimText || [];
    if (expectedText.length && JSON.stringify(page.visibleText) !== JSON.stringify(expectedText)) {
      issues.push(`${id} 视觉计划没有逐字消费锁定文案`);
    }
    if (page.masterRole === "cover" && page.density !== "low") issues.push(`${id} 封面必须低密度`);
    if (outline.coverMode === "none" && page.masterRole === "cover") issues.push(`${id} 无封面策略不允许封面母版角色`);
  });
  return { valid: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 12) };
}

export function anchorPageIds(plan = {}) {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const cover = pages.find((page) => page.masterRole === "cover") || pages[0] || null;
  const content = pages.find((page) => !["cover", "directory"].includes(page.masterRole)) || pages[1] || cover;
  return { cover: cover?.pageNo || null, content: content?.pageNo || null };
}

export function initializeDualStyleAnchors(deck = {}) {
  const ids = anchorPageIds(deck.image2RenderPlan);
  const previous = deck.styleAnchors || {};
  const legacy = deck.styleAnchor || null;
  const create = (kind, pageId) => {
    const current = previous[kind];
    if (current?.pageId === pageId) {
      return { ...current, contractVersion: IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION };
    }
    const inherited = legacy?.pageId === pageId ? legacy : null;
    return {
      kind,
      pageId,
      contractVersion: IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION,
      status: inherited?.assetPath ? "generated" : "pending",
      assetPath: inherited?.assetPath || null,
      signature: inherited?.signature || image2PlanSignature({ kind, pageId, plan: deck.image2RenderPlan?.signature }),
      confirmedAt: null,
      updatedAt: new Date().toISOString()
    };
  };
  return { cover: create("cover", ids.cover), content: create("content", ids.content) };
}

export function markAnchorDependentsStale(deck = {}, kind = "content") {
  const anchor = deck.styleAnchors?.[kind];
  if (!anchor) return deck;
  const coverPageId = deck.styleAnchors?.cover?.pageId;
  // The two anchors are independent calibration samples. Redrawing the cover
  // must be page-local: keep the accepted content anchor and all body pages
  // visible. Redrawing the content anchor still invalidates body pages because
  // they inherit its fixed title/typography contract.
  const affectedPageIds = new Set(kind === "cover"
    ? [anchor.pageId]
    : (deck.pages || [])
      .map((page) => page.pageNo || page.id)
      .filter((pageId) => pageId !== coverPageId));
  const pages = (deck.pages || []).map((page) => {
    const id = page.pageNo || page.id;
    if (!affectedPageIds.has(id)) return page;
    const regenerationPreviewImage = page.finalImage
      || page.regenerationPreviewImage
      || (page.imagePath ? { path: page.imagePath } : null);
    return {
      ...page,
      generationStatus: regenerationPreviewImage ? "stale" : "pending",
      regenerationPreviewImage,
      finalImage: null,
      imagePath: null
    };
  });
  const styleAnchors = {
    ...(deck.styleAnchors || {}),
    [kind]: {
      ...anchor,
      contractVersion: IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION,
      status: "pending",
      assetPath: null,
      confirmedAt: null,
      signature: image2PlanSignature({
        kind,
        pageId: anchor.pageId,
        plan: deck.image2RenderPlan?.signature,
        regeneratedAt: new Date().toISOString()
      }),
      updatedAt: new Date().toISOString()
    }
  };
  const generationJobs = Object.fromEntries(Object.entries(deck.generationJobs || {})
    .filter(([pageId, job]) => !affectedPageIds.has(job?.pageNo || job?.pageId || pageId)));
  return { ...deck, styleAnchors, pages, generationJobs, qaReport: null };
}

function usableAnchor(anchor, pageId, allowGenerated) {
  return Boolean(anchor?.assetPath
    && anchor.pageId !== pageId
    && (anchor.status === "confirmed" || (allowGenerated && anchor.status === "generated")));
}

export function image2AnchorDependenciesForPage(deck = {}, page = {}, options = {}) {
  const planPage = deck.image2RenderPlan?.pages?.find((item) => item.pageNo === (page.pageNo || page.id));
  const plannedRole = planPage?.masterRole || page.masterRole || "content";
  const role = isImage2CoverPage({ ...page, image2Plan: planPage || page.image2Plan }) ? "cover" : plannedRole === "cover" ? "content" : plannedRole;
  const anchors = deck.styleAnchors || {};
  const pageId = page.pageNo || page.id;
  const allowGenerated = Boolean(options.allowGenerated);
  const contentAnchorUsable = role !== "cover" && usableAnchor(anchors.content, pageId, allowGenerated);
  // Once P2 (or the first real body page) is confirmed, it becomes the single
  // strict visual master for body pages. Keeping the cover anchor in the same
  // reference set weakens that signal and can pull later pages toward cover
  // composition, so it is only a fallback while no body master is available.
  const coverAnchorUsable = role !== "cover" && !contentAnchorUsable && usableAnchor(anchors.cover, pageId, allowGenerated);
  const items = [
    contentAnchorUsable ? {
      kind: "content-anchor",
      pageId: anchors.content.pageId,
      path: anchors.content.assetPath,
      signature: anchors.content.signature,
      contractVersion: IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION
    } : null,
    coverAnchorUsable ? {
      kind: "cover-anchor",
      pageId: anchors.cover.pageId,
      path: anchors.cover.assetPath,
      signature: anchors.cover.signature
    } : null,
    (deck.masterPack?.roles?.[role]?.assetPath || deck.styleBible?.masterReferences?.[role]) ? {
      kind: "role-master",
      role,
      path: deck.masterPack?.roles?.[role]?.assetPath || deck.styleBible?.masterReferences?.[role]
    } : null,
    deck.styleBible?.typographyReferenceAssetPath ? {
      kind: "typography",
      path: deck.styleBible.typographyReferenceAssetPath
    } : null
  ].filter(Boolean);
  return items.filter((item, index) => items.findIndex((candidate) => candidate.path === item.path) === index).slice(0, 4);
}

export function image2ContentAnchorContractForPage(deck = {}, page = {}, options = {}) {
  const planned = deck.image2RenderPlan?.pages?.find((item) => item.pageNo === (page.pageNo || page.id));
  if (isImage2CoverPage({ ...page, image2Plan: planned || page.image2Plan })) return null;
  const pageId = page.pageNo || page.id;
  const anchor = deck.styleAnchors?.content;
  const allowGenerated = Boolean(options.allowGenerated);
  if (!usableAnchor(anchor, pageId, allowGenerated)) return null;
  return {
    version: IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION,
    mode: "strict-visual-master",
    referenceRole: "strict-style-master",
    priority: 1,
    pageId: anchor.pageId,
    signature: anchor.signature,
    assetPath: anchor.assetPath,
    locks: [...IMAGE2_CONTENT_ANCHOR_LOCKS],
    forbiddenCopy: [...IMAGE2_CONTENT_ANCHOR_FORBIDDEN_COPY],
    visibleTextSource: "current-page-render-contract-only",
    previousGeneratedPageReference: "forbidden"
  };
}

export function image2ContentAnchorPromptContract(contract = null) {
  if (!contract) return "";
  return [
    `【正文视觉母版合同 v${contract.version}】`,
    `正文视觉母版页：${contract.pageId}；这是后续正文页的第一优先级 strict-style-master。所有内容页与重绘必须持续参考同一张母版，禁止自动改用上一张生成页。`,
    `必须完整锁定：${IMAGE2_CONTENT_ANCHOR_LOCKS.join("；")}。`,
    `严禁复制：${contract.forbiddenCopy.join("；")}。`,
    image2VisualContractPrompt()
  ].join("\n");
}

export function image2ReferencePathsForPage(deck = {}, page = {}, options = {}) {
  return image2AnchorDependenciesForPage(deck, page, options).map((item) => item.path);
}
