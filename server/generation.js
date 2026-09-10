import fssync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { recoverExecutionImage } from "../shared/codex-image-output.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { requestOpenAiImage, aiSettingsFingerprint } from "./ai-settings.js";
import { createGenerationQaQueue, reusableQaCandidate, retryableImageAuditError } from "./generation-qa-queue.js";
import { codexActionErrorMessage, buildCodexExecBaseArgs } from "./codex-integration.js";
import { compactImageGenerationPrompt, createImageGenerationTelemetry, finalizeImage2BodyPrompt } from "./image-generation-runtime.js";
import { normalizeImage2RepairFeedback } from "../shared/image2-body-layout.js";
import { captureGenerationCandidate, verifyGenerationCandidate, auditGenerationCandidate, assertGenerationCandidateAccepted } from "./generation-candidate.js";
import { generationExecutionContext } from "./generation-batch-coordinator.js";
import { generationDiagnostic } from "./generation-diagnostics.js";
import { IMAGE2_VISUAL_CONTRACT_VERSION, image2VisualContractPrompt } from "../shared/image2-visual-contract.js";
import { isImage2CoverPage, image2CoverVisualPrompt } from "../shared/image2-cover-contract.js";
import { isCustomImage2Reference, selectImage2ReferenceForRole } from "../shared/image2-reference.js";
import {
  image2AnchorDependenciesForPage,
  image2ContentAnchorContractForPage,
  image2ContentAnchorPromptContract,
  initializeDualStyleAnchors
} from "../shared/image2-render-plan.js";

const deps = {};
const aiBatchContext = new AsyncLocalStorage();
const providerSettings = new WeakMap();
const projectPersistChains = new Map();
export const IMAGE2_VISUAL_MASTER_MAX_GENERATION_ATTEMPTS = 1;
export const IMAGE2_TITLE_ANCHOR_MAX_GENERATION_ATTEMPTS = IMAGE2_VISUAL_MASTER_MAX_GENERATION_ATTEMPTS;

export function configureGeneration(injected = {}) {
  Object.assign(deps, injected);
}

export function image2VisualMasterGateRequired(job = {}, deck = {}, phase = "full") {
  return !isImage2CoverPage(job) && phase !== "anchors"
    && fixedImage2AnchorEnabled(deck)
    && Boolean(job.contentAnchorContract)
    && Boolean(job.contentAnchorReferencePath);
}

export function image2TitleAnchorGateRequired(job = {}, deck = {}, phase = "full") {
  return image2VisualMasterGateRequired(job, deck, phase);
}

export function image2VisualMasterRetryPrompt(job = {}, audit = {}, attempt = 1) {
  const feedback = normalizeImage2RepairFeedback(String(audit.feedback || audit.evidence || "").trim());
  return {
    ...job,
    qualityGateAttempt: attempt,
    prompt: [
      job.prompt,
      "【生成后正文视觉母版校验未通过：强制重绘】",
      `这是第 ${attempt} 次生成后的定向修复。不得改动页面事实和其他可见文字；只修复与正文视觉母版不一致的视觉维度。`,
      image2VisualContractPrompt(),
      "标题过长只能换行，不得精简或改写锁定文字；第一行仍须使用同一锚点和同一视觉字号；禁止缩小字号、改变字重、行距或字体角色。",
      "只修复有证据的固定项偏离；反馈若涉及自由构图项，不得照搬母版构图。不得为了通过校验而复制母版页的文字、数字、卡片数量或事实内容。",
      "旧反馈中关于副标题有无、引述或导语归属、标题区顺序、分隔线位置及文字间距的要求已取消，应忽略；不得据此移动或删改副标题及引述。只修复有明确证据的文字重叠、裁切或不可读，不补副标题、不留空白占位。",
      feedback ? `上一轮校验反馈：${feedback}` : "上一轮校验反馈：标题、版心或完整视觉系统与正文视觉母版不一致。"
    ].join("\n\n")
  };
}

export function image2TitleAnchorRetryPrompt(job = {}, audit = {}, attempt = 1) {
  return image2VisualMasterRetryPrompt(job, audit, attempt);
}

export async function generateWithImage2VisualMasterGate({
  job,
  deck,
  provider,
  phase = "full",
  maxAttempts = IMAGE2_VISUAL_MASTER_MAX_GENERATION_ATTEMPTS,
  dispatch = dispatchImageGenerationJob,
  audit = aiBatchContext.getStore()?.integration?.auditImage2PageVisualMasterWithCodex || deps.auditImage2PageVisualMasterWithCodex || deps.auditImage2PageTitleAnchorWithCodex,
  onRetry = null,
  scheduleGeneration = (operation) => operation(),
  scheduleAudit = (operation) => operation(),
  maxAuditAttempts = 2,
  candidate = null,
  allowCandidateRedraw = true,
  onCandidate = null,
  onAuditAttempt = null,
  onAuditResult = null,
  onAuditRetry = null
}) {
  const gateRequired = image2VisualMasterGateRequired(job, deck, phase);
  // A visual rejection requires a human decision. Even legacy callers passing
  // a larger retry budget may generate only once per explicit request.
  const attempts = 1;
  let activeJob = job;
  let lastAudit = null;
  let lastResult = null;
  let generationCalls = 0;
  let auditCalls = 0;
  let currentCandidate = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      let reusable = attempt === 1 && gateRequired ? reusableQaCandidate(candidate, job) : null;
      if (reusable) {
        try { await verifyGenerationCandidate({ deck, job, candidate, resolvePath: deps.resolveStoredPath }); }
        catch (error) {
          if (!allowCandidateRedraw) { error.generationResult = reusable; throw error; }
          reusable = null; // Explicit normal generation may redraw; automatic QA checkpoint recovery cannot.
        }
      }
      result = reusable || await scheduleGeneration(async () => {
        generationCalls++;
        return dispatch(activeJob, deck, provider);
      });
    } catch (error) {
      // A targeted visual-master repair may time out after the previous attempt already
      // wrote a usable candidate image. Preserve that candidate and keep the
      // failure in the quality-check lane instead of reporting a false no-image
      // generation failure.
      if (gateRequired && lastResult?.imagePath && !error.generationResult) {
        error.code = error.code || "IMAGE2_VISUAL_MASTER_RETRY_ERROR";
        error.generationResult = lastResult;
        error.qualityGateAudit = lastAudit;
      }
      throw error;
    }
    lastResult = result;
    if (gateRequired && result?.imagePath) {
      try { currentCandidate = await captureGenerationCandidate({ deck, job, result, resolvePath: deps.resolveStoredPath }); }
      catch (error) { error.generationResult = result; throw error; }
    }
    if (result?.imagePath && typeof onCandidate === "function") await onCandidate({ result, candidate: currentCandidate, attempt, gateRequired, reused: generationCalls === 0 });
    if (!gateRequired || !result?.imagePath) {
      return { result, audit: null, attemptsUsed: generationCalls, auditAttempts: auditCalls, generationJob: activeJob };
    }
    if (typeof audit !== "function") {
      throw Object.assign(new Error("正文视觉母版已启用，但视觉一致性校验器不可用，已阻止绑定最终图"), { code: "IMAGE2_VISUAL_MASTER_AUDIT_ERROR", generationResult: result });
    }
    try {
      const auditLimit = Math.max(1, Math.min(2, Number(maxAuditAttempts) || 1));
      for (let auditAttempt = 1; auditAttempt <= auditLimit; auditAttempt++) {
        try {
          lastAudit = await scheduleAudit(async () => {
            auditCalls++;
            await onAuditAttempt?.({ result, attempt, auditAttempt, auditCalls });
            currentCandidate = await auditGenerationCandidate({ deck, job, candidate: currentCandidate, audit, resolvePath: deps.resolveStoredPath });
            return currentCandidate.audit;
          });
          if (typeof lastAudit?.passed !== "boolean") throw new Error("Invalid audit response: missing passed boolean");
          await onAuditResult?.({ result, attempt, audit: lastAudit, auditCalls });
          break;
        } catch (error) {
          if (auditAttempt >= auditLimit || !retryableImageAuditError(error)) throw error;
          await onAuditRetry?.({ result, attempt, auditAttempt, auditCalls, error });
        }
      }
    } catch (error) {
      error.code = error.code || "IMAGE2_VISUAL_MASTER_AUDIT_ERROR";
      error.generationResult = result;
      error.auditAttempts = auditCalls;
      throw error;
    }
    if (lastAudit?.reviewRequired === true || lastAudit?.decision === "review") {
      throw Object.assign(new Error("图片已保留，视觉校验证据不足，待复查；未自动重绘。"), {
        code: "IMAGE2_VISUAL_MASTER_REVIEW_REQUIRED", generationResult: result,
        qualityGateAudit: lastAudit, auditAttempts: auditCalls
      });
    }
    if (lastAudit?.passed === true) {
      await assertGenerationCandidateAccepted({ deck, job, candidate: currentCandidate, resolvePath: deps.resolveStoredPath });
      return { result, candidate: currentCandidate, audit: lastAudit, attemptsUsed: generationCalls, auditAttempts: auditCalls, generationJob: activeJob };
    }
    break;
  }

  const reason = String(lastAudit?.feedback || lastAudit?.evidence || "页面未通过正文视觉母版一致性校验").trim();
  const error = new Error(`正文视觉母版校验未通过，图片已保留，等待人工确认：${reason}`);
  error.code = "IMAGE2_VISUAL_MASTER_AUDIT_FAILED";
  error.generationResult = lastResult;
  error.qualityGateAudit = lastAudit;
  error.auditAttempts = auditCalls;
  throw error;
}

export async function generateWithImage2TitleAnchorGate(options = {}) {
  return generateWithImage2VisualMasterGate(options);
}

export function imageGenerationProviderStatus() {
  const settings = deps.aiSettingsSnapshot?.();
  const remember = (value) => {
    if (settings) { value.fingerprint = aiSettingsFingerprint(settings); providerSettings.set(value, settings); }
    return value;
  };
  if (settings?.provider === "openai") return remember({
    mode: "openai", provider: "openai-images", configured: Boolean(settings.openai.apiKey), canDispatch: Boolean(settings.openai.apiKey),
    model: settings.openai.imageModel, bridgeUrl: null, tokenConfigured: Boolean(settings.openai.apiKey),
    message: settings.openai.apiKey ? "使用 OpenAI API 完成整页生图、参考图继承与成图审核。" : "请在设置中配置 OpenAI API Key。"
  });
  const bridgeUrl = process.env.PPT_IMAGE_BRIDGE_URL || "";
  const tokenConfigured = Boolean(process.env.PPT_IMAGE_BRIDGE_TOKEN);
  if (bridgeUrl) {
    return remember({
      mode: "bridge",
      provider: "local-image-bridge",
      configured: true,
      canDispatch: true,
      bridgeUrl,
      tokenConfigured,
      message: "已配置本地 image bridge；前端不接触密钥，任务由后端转发。"
    });
  }
  const codexExecutable = deps.localCodexExecutable();
  if (codexExecutable) {
    return remember({
      mode: "local-codex",
      provider: "codex-imagegen",
      configured: true,
      canDispatch: true,
      bridgeUrl: null,
      tokenConfigured: false,
      message: "使用本机 Codex 登录态直接调用 Image Gen，无需 API Key。"
    });
  }
  return remember({
    mode: "manual",
    provider: "codex-imagegen-unavailable",
    configured: false,
    canDispatch: false,
    bridgeUrl: null,
    tokenConfigured: false,
    message: "未找到本机 Codex。请先安装或登录 Codex，再重新生成。"
  });
}

function resolvedGenerationReferences(job) {
  const resolved = (job.styleReferencePaths || [])
    .map((item) => deps.resolveStoredPath ? deps.resolveStoredPath(item) : deps.safeJoin(deps.PROJECT_ROOT, item));
  if (job.referenceBundleId) {
    const missing = resolved.filter((item) => !fssync.existsSync(item));
    if (missing.length) throw new Error(`用户参考图已不可用，已停止生成：${missing.join("、")}`);
    if (!resolved.length) throw new Error("用户参考包未传入实际图片，已停止生成");
  }
  return resolved.filter((item) => fssync.existsSync(item));
}

function localCodexImagePrompt(job, outputPath, { api = false } = {}) {
  const isCover = isImage2CoverPage(job);
  const referencePaths = resolvedGenerationReferences(job);
  const selectedStyleReferencePaths = (job.selectedStyleReferencePaths || [])
    .map((item) => deps.resolveStoredPath ? deps.resolveStoredPath(item) : deps.safeJoin(deps.PROJECT_ROOT, item))
    .filter((item) => referencePaths.includes(item));
  const typographyReferencePath = job.typographyReferencePath
    ? (deps.resolveStoredPath ? deps.resolveStoredPath(job.typographyReferencePath) : deps.safeJoin(deps.PROJECT_ROOT, job.typographyReferencePath))
    : "";
  const anchorReferencePaths = (job.anchorReferencePaths || [])
    .map((item) => deps.resolveStoredPath ? deps.resolveStoredPath(item) : deps.safeJoin(deps.PROJECT_ROOT, item))
    .filter((item) => referencePaths.includes(item));
  const selectedStyleReferenceSet = new Set(selectedStyleReferencePaths);
  const anchorReferenceSet = new Set(anchorReferencePaths);
  const referenceLabel = (item) => {
    const index = referencePaths.indexOf(item);
    return index >= 0 ? `参考图 ${index + 1}` : "参考图";
  };
  const referenceLabels = (items) => items.map(referenceLabel).join("、");
  const supportingVisualReferencePaths = referencePaths.filter((item) => (
    item !== typographyReferencePath
    && !selectedStyleReferenceSet.has(item)
    && !anchorReferenceSet.has(item)
  ));
  const prompt = [
    api ? "生成一张完整的 16:9 PPT 页面图，所有文字和视觉元素必须一次生成。" : "直接使用内置 image_gen.imagegen 工具生成一张完整的 16:9 PPT 页面图。",
    api ? "输出完整页面图片；不要生成代码、工具调用说明或操作界面。" : "必须实际调用 Image Gen；不得用 HTML、SVG、Canvas、Python、PIL、PowerPoint 或其他脚本拼图代替。",
    ...(api ? [] : [
      "本次只执行一次 image_gen.imagegen 调用，生成一个页面候选。首次生成成功后立即保存并交回，禁止在同一次任务内自行重绘、生成备选或反复优化；文字及视觉检查由工作台后续流程负责，保持所有既定文案和排版要求。",
      "如工具仍在运行，继续等待同一次调用，不能重复发起。工具失败或未返回可读取的生成文件时，明确返回失败原因，不得用重新生图解决文件接收问题。只可复制本次工具返回的生成文件，不搜索或使用其他任务的图片。"
    ]),
    "页面中的标题、正文、标签和图表文字必须由 Image Gen 在整张图片内一次生成，不得后贴文字。",
    "优先保证中文文字可读、标题完整、信息层级清楚，不要显示 P01/P02 等内部页码。",
    referencePaths.length
      ? `本次已按顺序附上 ${referencePaths.length} 张参考图（${referenceLabels(referencePaths)}）。必须使用本次附图，不得读取或搜索其他文件。`
      : "严格遵守提示词中的整套风格协议，不得自行切换视觉风格。",
    anchorReferencePaths.length
      ? `正文视觉母版（第一优先级 strict-style-master）：${referenceLabels(anchorReferencePaths)}。持续使用同一张已确认母版，禁止改用上一张生成页。\n${image2VisualContractPrompt()}`
      : "当前页尚无成品正文视觉母版，必须严格沿用固定风格样张与风格协议。",
    selectedStyleReferencePaths.length && !job.contentAnchorContract
      ? `用于建立母版的用户选定风格样张：${referenceLabels(selectedStyleReferencePaths)}。不得复制样张中的文字、数字、Logo 或事实内容。`
      : "已确认正文视觉母版决定字体与配色；其他用户参考图只提供页面角色的布局借鉴。",
    job.referenceLayoutPath && job.contentAnchorContract
      ? "用户参考页仅用于局部布局（layout-only）。不得学习它的字体、配色或标题位置以覆盖第一张正文视觉母版，不得复制文字、数字和固定栏目数量。"
      : "",
    job.referenceIdentityOnly
      ? "当前没有匹配角色的参考页，只从上传图学习配色、材质和字体气质；另建适合本页内容的信息布局，正文不得复制封面构图。"
      : "",
    job.contentAnchorContract
      ? `正文视觉母版依赖：${job.contentAnchorPageId} / ${job.contentAnchorSignature}\n必须复制完整视觉规范，但严禁复制母版页的标题、副标题、展示文字、数字、内部页码、卡片数量、信息布局或底部结论区中的事实内容。本页可见文字以当前页白名单为唯一事实源。`
      : "",
    supportingVisualReferencePaths.length
      ? `辅助构图参考（第三优先级，content-only）：${referenceLabels(supportingVisualReferencePaths)}。只参考当前页面角色的内容关系和组件分区，不得覆盖正文视觉母版，也不得复制其中的文字、数字、Logo 或具体页面内容。`
      : "",
    typographyReferencePath
      ? `字体字形参考图：${referenceLabel(typographyReferencePath)}。只学习同一字体角色、字重、字面比例和字号层级，不复制字形板中的示例文字、配色或版式。整套页面的同一文字角色必须保持相同视觉字高；文字过长时只能换行，不得删减、精简或改写锁定文字，不得缩小字号。无法容纳时明确报告排版失败。`
      : "字体气质跟随已确认母版；尚无母版时跟随选定样张。同一文字角色锁定字重、字面比例和字号层级，不指定具体字体名称。",
    "严格依据下面的页面提示词生成：",
    compactImageGenerationPrompt(job.prompt),
    isCover ? image2CoverVisualPrompt() : job.contentAnchorContract ? image2VisualContractPrompt() : "",
    api ? "最终输出 PNG 图片，严格使用当前页文字白名单，不把文件路径或生产说明画在图中。" : `生成完成后，将最终 PNG 文件复制到以下绝对路径：\nFINAL_OUTPUT_PATH: ${outputPath}`,
    api ? "只输出最终页面图片。" : "不要询问，不要只返回提示词，不要解释过程。确认文件确实写入后，只回答最终绝对路径。"
  ].join("\n\n");
  return isCover ? prompt : finalizeImage2BodyPrompt(prompt);
}

function validateGeneratedImageFile(filePath) {
  if (!fssync.existsSync(filePath)) throw new Error("Codex 已返回，但没有写出页面图片");
  const stats = fssync.statSync(filePath);
  if (!stats.isFile() || stats.size < 64) throw new Error("Codex 写出的页面图片为空或不完整");
  const header = Buffer.alloc(12);
  const fd = fssync.openSync(filePath, "r");
  try {
    fssync.readSync(fd, header, 0, header.length, 0);
  } finally {
    fssync.closeSync(fd);
  }
  const isPng = header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) throw new Error("Codex 写出的文件不是有效 PNG 图片");
}

export async function recoverGeneratedImageAfterProcessError(outputPath, graceMs = 5000) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (true) {
    try {
      validateGeneratedImageFile(outputPath);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function runLocalCodexImageGeneration(job, deck) {
  const execution = generationExecutionContext.getStore();
  execution?.signal.throwIfAborted();
  const settings = aiBatchContext.getStore()?.settings || deps.aiSettingsSnapshot?.();
  const codexExecutable = deps.localCodexExecutable(settings);
  const runtimePolicy = { model: settings?.codex.model || deps.CODEX_MODEL || "gpt-5.6-sol", reasoningEffort: settings?.codex.reasoningEffort || deps.CODEX_REASONING_EFFORT || "medium", serviceTier: deps.CODEX_SERVICE_TIER || "priority" };
  if (!codexExecutable) throw new Error("未找到本机 Codex 命令");
  const projectDir = deps.projectDirFor(deck);
  const finalImagesDir = path.join(projectDir, "final-images");
  const generationLogsDir = path.join(projectDir, "generation-logs");
  await fs.mkdir(finalImagesDir, { recursive: true });
  await fs.mkdir(generationLogsDir, { recursive: true });
  const uniqueSuffix = crypto.randomBytes(3).toString("hex");
  const outputPath = path.join(finalImagesDir, `${job.pageNo}-${job.promptHash}-${Date.now()}-${uniqueSuffix}.png`);
  const resolvedReferencePaths = resolvedGenerationReferences(job);
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "610ppt-imagegen-runtime-"));
  const runtimeOutputPath = path.join(runtimeDir, "final.png");
  try {
    const runtimeReferencePaths = [];
    for (const [index, sourcePath] of resolvedReferencePaths.entries()) {
      const extension = path.extname(sourcePath).toLowerCase() || ".png";
      const targetPath = path.join(runtimeDir, `reference-${String(index + 1).padStart(2, "0")}${extension}`);
      await fs.copyFile(sourcePath, targetPath, fssync.constants.COPYFILE_EXCL);
      runtimeReferencePaths.push(targetPath);
    }
    const args = [
      "--ask-for-approval", "never",
      ...buildCodexExecBaseArgs(runtimePolicy),
      "--ignore-rules",
      "--config", "mcp_servers={}",
      "--config", "features.apps=false",
      "--config", 'web_search="disabled"',
      "--config", "features.shell_tool=false",
      "--config", "features.unified_exec=false",
      "--config", "features.skill_mcp_dependency_install=false",
      "--config", "project_doc_max_bytes=0",
      "--json",
      "--color", "never",
      "--sandbox", "workspace-write",
      "--cd", runtimeDir,
      ...runtimeReferencePaths.flatMap((imagePath) => ["--image", imagePath]),
      "-"
    ];
    const startedAt = new Date();
    const telemetry = createImageGenerationTelemetry();
    const prompt = localCodexImagePrompt(job, "final.png");
    let processResult = null;
    let processError = null;
    try {
      processResult = await deps.runProcessWithInput(
        codexExecutable,
        args,
        prompt,
        { cwd: runtimeDir, timeoutMs: deps.CODEX_IMAGE_TIMEOUT_MS, timeoutLabel: "Codex 生图", onStdoutChunk: telemetry.onStdoutChunk }
      );
    } catch (error) {
      processError = error;
    }
    // Native Codex can save a tool result without passing its path to the model.
    // Recover only this execution's unique PNG, then run the unchanged QA gates.
    let recoveredHandoff = false;
    const recoveryBlocked = () => execution?.signal.aborted
      || processError?.name === "AbortError"
      || ["ABORT_ERR", "GENERATION_BATCH_STOPPED", "PROCESS_GROUP_UNKNOWN", "PROCESS_GROUP_STILL_RUNNING"].includes(processError?.code);
    if (!fssync.existsSync(runtimeOutputPath) && !recoveryBlocked()) {
      const recovered = await recoverExecutionImage({
        stdout: processResult?.stdout || processError?.stdout || "",
        startedAt: startedAt.getTime(),
        generatedImagesRoot: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "generated_images")
      });
      if (recovered.bytes) {
        execution?.signal.throwIfAborted();
        await fs.writeFile(runtimeOutputPath, recovered.bytes, { mode: 0o600, flag: "wx" });
        recoveredHandoff = true;
      } else if (!processError) {
        processError = Object.assign(new Error("Connector did not return all requested outputs"), { stdout: processResult?.stdout || "" });
      }
    }
    const recoveredAfterProcessError = processError && !recoveryBlocked()
      ? await recoverGeneratedImageAfterProcessError(runtimeOutputPath)
      : false;
    const logPath = path.join(generationLogsDir, `${job.pageNo}-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`);
    const failureReason = processError ? codexActionErrorMessage(processError, "生图") : "";
    const logContent = JSON.stringify(generationDiagnostic({ job, startedAt, prompt,
      references: resolvedReferencePaths, result: processResult, error: processError,
      failureReason,
      recovered: recoveredAfterProcessError || recoveredHandoff,
      runtimePolicy,
      timing: telemetry.snapshot() }), null, 2);
    await fs.writeFile(logPath, logContent, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(() => {});
    trimGenerationLogs(generationLogsDir).catch(() => {});
    execution?.signal.throwIfAborted();
    if (processError && !recoveredAfterProcessError) throw new Error(failureReason);
    validateGeneratedImageFile(runtimeOutputPath);
    await fs.copyFile(runtimeOutputPath, outputPath, fssync.constants.COPYFILE_EXCL);
    await fs.chmod(outputPath, 0o600);
    return {
      imagePath: deps.rel(outputPath),
      providerJobId: job.jobId,
      logPath: deps.rel(logPath),
      message: `${job.pageNo} 已由本机 Codex Image Gen 生成`
    };
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

async function trimGenerationLogs(generationLogsDir, keep = 30) {
  const entries = await fs.readdir(generationLogsDir).catch(() => []);
  const logFiles = entries.filter((name) => name.endsWith(".log")).sort();
  const excess = logFiles.length - keep;
  if (excess <= 0) return;
  await Promise.all(
    logFiles.slice(0, excess).map((name) => fs.unlink(path.join(generationLogsDir, name)).catch(() => {}))
  );
}

async function runOpenAiImageGeneration(job, deck, provider) {
  const settings = aiBatchContext.getStore()?.settings || providerSettings.get(provider) || deps.aiSettingsSnapshot?.();
  if (!settings || settings.provider !== "openai" || (provider.fingerprint && provider.fingerprint !== aiSettingsFingerprint(settings))) throw new Error("生图设置已变化，请重新开始本次生成");
  const execution = generationExecutionContext.getStore();
  execution?.assertOwner();
  execution?.signal.throwIfAborted();
  const references = resolvedGenerationReferences(job);
  if (references.length !== new Set(job.styleReferencePaths || []).size) throw new Error("生图参考图缺失，已停止生成");
  const projectDir = deps.projectDirFor(deck);
  const finalImagesDir = path.join(projectDir, "final-images");
  const logDir = path.join(projectDir, "generation-logs");
  await fs.mkdir(finalImagesDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  const startedAt = new Date();
  const outputPath = path.join(finalImagesDir, `${job.pageNo}-${job.promptHash}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.png`);
  const prompt = localCodexImagePrompt(job, "", { api: true });
  const result = await (deps.requestOpenAiImage || requestOpenAiImage)(settings, { prompt, images: references, signal: execution?.signal, timeoutMs: deps.CODEX_IMAGE_TIMEOUT_MS });
  execution?.signal.throwIfAborted();
  execution?.assertOwner();
  await fs.writeFile(outputPath, result.bytes, { mode: 0o600, flag: "wx" });
  validateGeneratedImageFile(outputPath);
  const logPath = path.join(logDir, `${job.pageNo}-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`);
  await fs.writeFile(logPath, JSON.stringify({ provider: "openai-images", model: settings.openai.imageModel, startedAt: startedAt.toISOString(), elapsedMs: Date.now() - startedAt.getTime(), attempts: result.attempts, promptCharacters: prompt.length, referenceCount: references.length, width: result.width, height: result.height }), { mode: 0o600, flag: "wx" });
  trimGenerationLogs(logDir).catch(() => {});
  return { imagePath: deps.rel(outputPath), providerJobId: job.jobId, logPath: deps.rel(logPath), message: `${job.pageNo} 已由 OpenAI API 生成` };
}

export async function dispatchImageGenerationJob(job, deck, provider) {
  if (provider.mode === "openai") return runOpenAiImageGeneration(job, deck, provider);
  if (provider.mode === "local-codex") {
    return runLocalCodexImageGeneration(job, deck);
  }
  const execution = generationExecutionContext.getStore();
  execution?.signal.throwIfAborted();
  execution?.assertOwner();
  const signal = AbortSignal.any([
    AbortSignal.timeout(deps.CODEX_IMAGE_TIMEOUT_MS || 420000),
    ...(execution?.signal ? [execution.signal] : [])
  ]);
  const response = await fetch(provider.bridgeUrl, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(process.env.PPT_IMAGE_BRIDGE_TOKEN ? { Authorization: `Bearer ${process.env.PPT_IMAGE_BRIDGE_TOKEN}` } : {})
    },
    body: JSON.stringify({
      job,
      prompt: job.prompt,
      suggestedFileName: job.suggestedFileName,
      targetDir: job.targetDir,
      project: deck.project || null
    })
  });
  const result = await response.json().catch((error) => {
    signal.throwIfAborted();
    throw error;
  });
  signal.throwIfAborted();
  execution?.assertOwner();
  if (!response.ok) throw new Error(result.error || `bridge HTTP ${response.status}`);
  return result;
}

function withGenerationBatchLock(batch, task) {
  const next = batch.persistChain.then(task, task);
  batch.persistChain = next.catch(() => {});
  return next;
}

function withProjectGenerationLock(batch, task) {
  const projectKey = path.resolve(deps.projectDirFor(batch.deck));
  const previous = projectPersistChains.get(projectKey) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {});
  projectPersistChains.set(projectKey, settled);
  settled.finally(() => {
    if (projectPersistChains.get(projectKey) === settled) projectPersistChains.delete(projectKey);
  });
  return next;
}

async function latestProjectDeck(batch) {
  const deckPath = path.join(deps.projectDirFor(batch.deck), "deck.json");
  try {
    return JSON.parse(await fs.readFile(deckPath, "utf8"));
  } catch {
    return { ...batch.deck };
  }
}

export function generationBatchPayload(batch) {
  const now = batch.finishedAt ? new Date(batch.finishedAt).getTime() : Date.now();
  const startedAt = new Date(batch.startedAt).getTime();
  const jobs = Object.values(batch.jobs || {});
  const phaseJobs = jobs.filter((job) => (job?.phase || "full") === (batch.phase || "full"));
  const hasCompletePhaseSnapshot = phaseJobs.length === Number(batch.total || 0);
  const completedStatuses = new Set(["generated", "imported", "dispatched"]);
  const completedJobs = hasCompletePhaseSnapshot
    ? phaseJobs.filter((job) => completedStatuses.has(job?.status))
    : [];
  const failedJobs = hasCompletePhaseSnapshot
    ? phaseJobs.filter((job) => job?.status === "failed")
    : [];
  const activeJobs = hasCompletePhaseSnapshot
    ? phaseJobs.filter((job) => job?.status === "generating" && !["qa-queued", "generation-queued", "awaiting-review"].includes(job.workStage))
    : [];
  const completed = hasCompletePhaseSnapshot ? completedJobs.length : Number(batch.completed || 0);
  const failed = hasCompletePhaseSnapshot ? failedJobs.length : Number(batch.failed || 0);
  const durations = (batch.durationSamples?.length
    ? batch.durationSamples
    : (hasCompletePhaseSnapshot ? phaseJobs : jobs).map((job) => job?.durationMs))
    .map((duration) => Number(duration || 0))
    .filter((duration) => duration > 0);
  const averageDurationMs = durations.length
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
    : 0;
  const pending = Math.max(0, batch.total - completed - failed);
  const concurrency = batch.phase === "anchors"
    // The cover and first body page are independent calibration samples. Run
    // them together so the user does not wait for two full Image Gen turns.
    ? 2
    : Math.min(3, Math.max(1, deps.CODEX_IMAGE_CONCURRENCY || 1));
  const activePageNos = hasCompletePhaseSnapshot
    ? activeJobs.map((job) => job.pageNo).filter(Boolean)
    : [...(batch.activePageNos || [])];
  const activePageJobs = hasCompletePhaseSnapshot
    ? activeJobs.map((job) => {
      const jobStartedAt = job.startedAt || job.updatedAt || null;
      const jobStartedMs = jobStartedAt ? new Date(jobStartedAt).getTime() : Number.NaN;
      return {
        pageId: job.pageId,
        pageNo: job.pageNo,
        startedAt: jobStartedAt,
        elapsedMs: Number.isFinite(jobStartedMs) ? Math.max(0, now - jobStartedMs) : null
      };
    })
    : activePageNos.map((pageNo) => ({
      pageId: null,
      pageNo,
      startedAt: batch.startedAt || null,
      elapsedMs: Math.max(0, now - startedAt)
    }));
  const completedPageNos = hasCompletePhaseSnapshot
    ? completedJobs.map((job) => job.pageNo).filter(Boolean)
    : [...(batch.completedPageNos || [])];
  const failedPages = hasCompletePhaseSnapshot
    ? failedJobs.map((job) => ({ pageId: job.pageId, pageNo: job.pageNo, error: job.error || "生成失败" }))
    : [...(batch.failedPages || [])];
  return {
    batchId: batch.batchId,
    phase: batch.phase || "full",
    status: batch.status,
    interruptionReason: batch.interruptionReason || "",
    total: batch.total,
    completed,
    failed,
    pending,
    concurrency,
    scheduling: batch.schedulingState || null,
    averageDurationMs,
    estimatedRemainingMs: averageDurationMs && pending
      ? Math.ceil(pending / concurrency) * averageDurationMs
      : 0,
    activePageNos: [...new Set(activePageNos)].sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true })),
    activePageJobs,
    isSlow: activePageJobs.some((job) => Number(job.elapsedMs || 0) >= 120000),
    completedPageNos: [...new Set(completedPageNos)].sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true })),
    failedPages,
    elapsedMs: Math.max(0, now - startedAt),
    startedAt: batch.startedAt,
    updatedAt: batch.updatedAt,
    finishedAt: batch.finishedAt || null
  };
}

async function updateGenerationBatchJob(batch, job, status, patch = {}) {
  const execution = generationExecutionContext.getStore();
  const assertMutationAllowed = () => {
    execution?.assertOwner();
    if (execution && (execution.signal.aborted || batch.status !== "running")) throw Object.assign(new Error("生成任务已停止，拒绝写入项目"), { code: "GENERATION_BATCH_STOPPED" });
  };
  return withGenerationBatchLock(batch, () => withProjectGenerationLock(batch, async () => {
    assertMutationAllowed();
    const updatedAt = new Date().toISOString();
    const currentJob = {
      ...batch.jobs[job.pageId],
      ...job,
      ...patch,
      qaCandidate: Object.hasOwn(patch, "qaCandidate") ? patch.qaCandidate : (batch.jobs[job.pageId]?.qaCandidate || job.qaCandidate || null),
      status,
      statusText: patch.statusText || deps.generationStatusText(status),
      updatedAt
    };
    batch.updatedAt = updatedAt;
    if (status === "generating" && !["qa-queued", "generation-queued", "awaiting-review"].includes(patch.workStage)) batch.activePageNos.add(job.pageNo);
    if (["qa-queued", "generation-queued", "awaiting-review"].includes(patch.workStage)) batch.activePageNos.delete(job.pageNo);
    if (["generated", "imported", "failed"].includes(status)) batch.activePageNos.delete(job.pageNo);

    const latestDeck = await latestProjectDeck(batch);
    // A batch records what its workers are doing. The committed deck instead
    // records whether those results still match its current inputs. Anchor
    // invalidation can remove or mark deck jobs stale without stopping workers;
    // importing that projection here erases their real progress and failures.
    batch.jobs = {
      ...batch.jobs,
      [job.pageId]: currentJob
    };
    batch.deck = {
      ...latestDeck,
      generationJobs: { ...(latestDeck.generationJobs || {}), [job.pageId]: currentJob }
    };

    if (status === "generated" && patch.bridgeResult?.imagePath) {
      let beforeCommit = assertMutationAllowed;
      if (image2VisualMasterGateRequired(job, batch.deck, batch.phase)) {
        const currentInput = applyCurrentStyleAnchorToJob(latestDeck.generationJobs?.[job.pageId] || job, latestDeck, { phase: batch.phase });
        beforeCommit = async () => {
          assertMutationAllowed();
          await assertGenerationCandidateAccepted({ deck: latestDeck, job: currentInput, candidate: currentJob.qaCandidate, resolvePath: deps.resolveStoredPath });
          assertMutationAllowed();
        };
        await beforeCommit();
      }
      assertMutationAllowed();
      const bound = await deps.bindFinalImagesToDeck(
        batch.deck,
        [patch.bridgeResult.imagePath],
        { keepInPlace: true, revisionAction: "codex-image-generation-progress", beforeBuild: assertMutationAllowed, beforeCommit }
      );
      batch.deck = bound.deck;
      if (batch.phase === "anchors" && fixedImage2AnchorEnabled(batch.deck)) {
        const anchors = initializeDualStyleAnchors(batch.deck);
        const kind = Object.entries(anchors).find(([, anchor]) => anchor?.pageId === job.pageNo || anchor?.pageId === job.pageId)?.[0];
        if (kind) {
          const generatedPage = (batch.deck.pages || []).find((page) => (page.pageNo || page.id) === job.pageNo || page.id === job.pageId);
          const assetPath = generatedPage?.finalImage?.path || patch.bridgeResult.imagePath;
          batch.deck = await deps.writeProjectArtifacts({
            ...batch.deck,
            styleAnchors: {
              ...anchors,
              [kind]: {
                ...anchors[kind],
                // The selected style already locks the cover's visual mood.
                // Only the first body page is the user-confirmed typography
                // and density calibration gate for all remaining pages.
                status: kind === "cover" ? "confirmed" : "generated",
                assetPath,
                confirmedAt: kind === "cover" ? updatedAt : null,
                regenerationFeedback: null,
                regenerationRequestedAt: null,
                updatedAt
              }
            },
            generationJobs: batch.deck.generationJobs
          }, { skipRevision: true, revisionAction: `image2-${kind}-anchor-generated`, beforeBuild: assertMutationAllowed, beforeCommit: assertMutationAllowed });
        }
      }
    } else {
      const qualityCheckCandidatePath = String(patch.qaCandidate?.result?.imagePath || (status === "failed" && patch.failureStage === "quality-check" ? patch.bridgeResult?.imagePath : "") || "").trim();
      const pages = qualityCheckCandidatePath
        ? (batch.deck.pages || []).map((page, index) => {
            const pageNo = deps.pageNoForPage(page, index);
            if (page.id !== job.pageId && pageNo !== job.pageNo) return page;
            return {
              ...page,
              generationStatus: status,
              failureStage: status === "failed" ? "quality-check" : null,
              regenerationPreviewImage: {
                path: qualityCheckCandidatePath,
                source: qualityCheckCandidatePath,
                reason: "quality-check",
                updatedAt
              }
            };
          })
        : batch.deck.pages;
      batch.deck = await deps.writeProjectArtifacts(
        { ...batch.deck, pages },
        { skipRevision: true, revisionAction: "image-job-progress", beforeBuild: assertMutationAllowed, beforeCommit: assertMutationAllowed }
      );
    }
    if (deps.persistGenerationBatchSnapshot) await deps.persistGenerationBatchSnapshot(batch);
    return batch.deck;
  }));
}

export async function runGenerationBatch(batch, provider) {
  const settings = providerSettings.get(provider) || deps.aiSettingsSnapshot?.();
  return aiBatchContext.run({ settings, integration: deps.aiCodexIntegrationSnapshot?.(settings) }, () => runGenerationBatchWithSnapshot(batch, provider));
}

async function runGenerationBatchWithSnapshot(batch, provider) {
  const execution = generationExecutionContext.getStore();
  try {
    const concurrency = batch.phase === "anchors"
      ? 2
      // Remaining Image2 pages all reference the SAME confirmed content anchor
      // (previousGeneratedPageReference is forbidden by contract), so they have
      // no data dependency on each other and can be generated concurrently.
      : (["local-codex", "openai"].includes(provider.mode)
        ? Math.min(3, Math.max(1, deps.CODEX_IMAGE_CONCURRENCY || 1))
        : 1);
    const orderedQueue = [...batch.queued].sort((left, right) =>
      String(left.pageNo || left.pageId || "").localeCompare(
        String(right.pageNo || right.pageId || ""),
        "zh-CN",
        { numeric: true }
      )
    );
    batch.queued = orderedQueue;
    const splitScheduling = deps.CODEX_GENERATION_QA_PIPELINE !== false;
    const queue = createGenerationQaQueue({ totalConcurrency: concurrency, generationConcurrency: concurrency, qaConcurrency: deps.CODEX_IMAGE_QA_CONCURRENCY || 1, onChange: (state) => { batch.schedulingState = state; } });
    const requireRunning = () => {
      execution?.assertOwner();
      if (execution?.signal.aborted) throw Object.assign(new Error("生成任务已停止"), { code: "GENERATION_BATCH_STOPPED" });
      if (batch.status !== "running") throw Object.assign(new Error("生图批次已停止，未再启动模型"), { code: "GENERATION_BATCH_STOPPED" });
    };
    const runJob = async (job) => {
        if (batch.status !== "running") {
          return { pageId: job.pageId, pageNo: job.pageNo, ok: false, cancelled: true };
        }
        const anchoredJob = applyCurrentStyleAnchorToJob(job, batch.deck, { phase: batch.phase });
        let startedAt = null;
        const previousAttempts = Number(batch.jobs[anchoredJob.pageId]?.attempts || anchoredJob.attempts || 0);
        let generationAttempts = 0;
        let auditAttempts = Number(batch.jobs[anchoredJob.pageId]?.auditAttempts || 0);
        let currentCandidate = anchoredJob.qaCandidate || null;
        if (currentCandidate?.result?.imagePath) {
          const storedPath = deps.resolveStoredPath ? deps.resolveStoredPath(currentCandidate.result.imagePath) : currentCandidate.result.imagePath;
          if (!storedPath || !fssync.existsSync(storedPath)) currentCandidate = null;
        }
        const schedule = (lane, operation) => splitScheduling ? queue.run(lane, operation) : operation();
        try {
          const gated = await generateWithImage2VisualMasterGate({
            job: anchoredJob,
            deck: batch.deck,
            provider,
            phase: batch.phase,
            candidate: currentCandidate,
            allowCandidateRedraw: !execution?.qaRecoveryPageIds?.has(anchoredJob.pageId),
            maxAttempts: execution?.qaRecoveryPageIds?.has(anchoredJob.pageId) ? 1 : IMAGE2_VISUAL_MASTER_MAX_GENERATION_ATTEMPTS,
            maxAuditAttempts: deps.CODEX_IMAGE_QA_MAX_ATTEMPTS || 2,
            dispatch: deps.dispatchImageGenerationJob || dispatchImageGenerationJob,
            scheduleGeneration: (operation) => schedule("generation", async () => {
              requireRunning();
              startedAt ||= new Date().toISOString();
              generationAttempts++;
              await updateGenerationBatchJob(batch, anchoredJob, "generating", { startedAt, workStage: "generation", statusText: "正在生成图片", attempts: previousAttempts + generationAttempts });
              return operation();
            }),
            scheduleAudit: (operation) => schedule("qa", async () => { requireRunning(); return operation(); }),
            onCandidate: async ({ result, candidate: boundCandidate, attempt, gateRequired }) => {
              startedAt ||= new Date().toISOString();
              if (!gateRequired) return;
              currentCandidate = { ...boundCandidate, generationAttempt: attempt, updatedAt: new Date().toISOString() };
              await updateGenerationBatchJob(batch, anchoredJob, "generating", { startedAt, workStage: "qa-queued", statusText: "图片已生成，等待校验", qaCandidate: currentCandidate, qualityGate: { kind: "image2-visual-master", status: "pending", updatedAt: new Date().toISOString() }, bridgeResult: { imagePath: result.imagePath, previewUrl: result.previewUrl || null }, attempts: previousAttempts + generationAttempts });
            },
            onAuditAttempt: async () => {
              auditAttempts++;
              await updateGenerationBatchJob(batch, anchoredJob, "generating", { workStage: "auditing", statusText: "图片已生成，正在校验", auditAttempts });
            },
            onAuditResult: async ({ audit }) => {
              const review = audit.reviewRequired === true || audit.decision === "review";
              currentCandidate = { ...currentCandidate, status: review ? "error" : audit.passed ? "passed" : "rejected", audit, updatedAt: new Date().toISOString() };
              await updateGenerationBatchJob(batch, anchoredJob, "generating", { workStage: audit.passed ? "binding" : "awaiting-review", statusText: review ? "图片已保留，等待人工确认" : audit.passed ? "校验通过，正在绑定最终图" : "校验未通过，等待人工确认", qaCandidate: currentCandidate });
            },
            onAuditRetry: async ({ error }) => {
              currentCandidate = { ...currentCandidate, status: "error", updatedAt: new Date().toISOString() };
              await updateGenerationBatchJob(batch, anchoredJob, "generating", { workStage: "qa-queued", statusText: "审查服务暂时失败，正在复查同一候选图", qaCandidate: currentCandidate, qualityGate: { kind: "image2-visual-master", status: "audit-retrying", message: error.message, updatedAt: new Date().toISOString() } });
            }
          });
          const result = gated.result;
          const completedAt = new Date().toISOString();
          await updateGenerationBatchJob(batch, anchoredJob, result.imagePath ? "generated" : "dispatched", {
            ...(gated.candidate ? { qaCandidate: gated.candidate } : {}),
            workStage: "complete",
            providerJobId: result.jobId || result.providerJobId || null,
            completedAt,
            attempts: previousAttempts + gated.attemptsUsed,
            auditAttempts,
            durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
            qualityGate: gated.audit ? {
              kind: "image2-visual-master",
              status: "passed",
              attempt: gated.attemptsUsed,
              audit: gated.audit,
              updatedAt: completedAt
            } : null,
            bridgeResult: {
              imagePath: result.imagePath || null,
              previewUrl: result.previewUrl || null,
              message: result.message || ""
            }
          });
          batch.durationSamples = [
            ...(batch.durationSamples || []),
            Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
          ].filter((duration) => duration > 0).slice(-20);
          batch.completed += 1;
          batch.completedPageNos.push(anchoredJob.pageNo);
          batch.completedPageNos.sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true }));
          batch.updatedAt = new Date().toISOString();
          return { pageId: anchoredJob.pageId, pageNo: anchoredJob.pageNo, ok: true };
        } catch (error) {
          if (execution?.signal.aborted) return { pageId: anchoredJob.pageId, pageNo: anchoredJob.pageNo, ok: false, cancelled: true };
          const completedAt = new Date().toISOString();
          const generatedResult = error.generationResult || null;
          const qualityCheckFailure = Boolean(
            generatedResult?.imagePath
            && (String(error.code || "").startsWith("IMAGE2_VISUAL_MASTER_") || /正文视觉母版/.test(error.message || ""))
          );
          const reviewRequired = error.code === "IMAGE2_VISUAL_MASTER_REVIEW_REQUIRED";
          await updateGenerationBatchJob(batch, anchoredJob, "failed", {
            workStage: qualityCheckFailure ? "awaiting-review" : "failed",
            qaCandidate: currentCandidate && generatedResult?.imagePath ? { ...currentCandidate, result: generatedResult, status: error.code === "IMAGE2_VISUAL_MASTER_AUDIT_FAILED" || error.code === "IMAGE2_VISUAL_MASTER_RETRY_ERROR" ? "rejected" : "error" } : currentCandidate,
            attempts: previousAttempts + generationAttempts,
            auditAttempts,
            error: reviewRequired ? error.message : qualityCheckFailure ? `图片已生成，但正文视觉母版校验失败：${error.message}` : error.message,
            statusText: reviewRequired ? "图片已保留，等待人工确认" : qualityCheckFailure ? (error.code === "IMAGE2_VISUAL_MASTER_AUDIT_FAILED" ? "校验未通过，等待人工确认" : "校验未完成，等待人工确认") : undefined,
            failureStage: qualityCheckFailure ? "quality-check" : "generation",
            qualityGate: qualityCheckFailure ? {
              kind: "image2-visual-master",
              status: reviewRequired ? "review-required" : error.code === "IMAGE2_VISUAL_MASTER_AUDIT_FAILED" ? "failed" : "error",
              code: error.code || null,
              audit: error.qualityGateAudit || null,
              updatedAt: completedAt
            } : null,
            bridgeResult: generatedResult?.imagePath ? {
              imagePath: generatedResult.imagePath,
              previewUrl: generatedResult.previewUrl || null,
              message: generatedResult.message || "图片已写入，等待重新校验"
            } : null,
            completedAt,
            durationMs: startedAt ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()) : 0
          });
          batch.failed += 1;
          batch.failedPages.push({
            pageId: anchoredJob.pageId,
            pageNo: anchoredJob.pageNo,
            error: qualityCheckFailure ? `图片已生成，但正文视觉母版校验失败：${error.message}` : error.message,
            failureStage: qualityCheckFailure ? "quality-check" : "generation",
            imagePath: generatedResult?.imagePath || null
          });
          batch.updatedAt = new Date().toISOString();
          return { pageId: anchoredJob.pageId, pageNo: anchoredJob.pageNo, ok: false, error: error.message };
        }
      };
    // Both calibration samples start together. The remaining phase is still
    // blocked by the body-anchor confirmation route, not by this concurrency.
    const results = splitScheduling ? await Promise.all(orderedQueue.map(runJob)) : await deps.mapWithConcurrency(orderedQueue, concurrency, runJob);
    await batch.persistChain;
    batch.results = results;
    if (batch.status === "running") {
      batch.status = batch.failed ? (batch.completed ? "completed-with-errors" : "failed") : "completed";
    }
    batch.finishedAt = new Date().toISOString();
    batch.updatedAt = batch.finishedAt;
  } catch (error) {
    batch.status = "failed";
    batch.failedPages.push({ pageId: null, pageNo: null, error: error.message });
    batch.finishedAt = new Date().toISOString();
    batch.updatedAt = batch.finishedAt;
  }
  if (deps.persistGenerationBatchSnapshot) await deps.persistGenerationBatchSnapshot(batch);
  if (deps.releaseGenerationBatchLease) deps.releaseGenerationBatchLease(batch);
}

function pageNeedsImageGeneration(page) {
  return page.editableMode === "image-only";
}

export function imageGenerationPageIds(deck, scope = "selected", pageIds = []) {
  if (scope === "image-needed" || !pageIds.length) {
    return (deck.pages || [])
      .filter((page) => pageNeedsImageGeneration(page))
      .map((page) => page.id);
  }
  return pageIds;
}

export function existingGenerationJobs(deck = {}) {
  const jobs = deck.generationJobs || {};
  if (Array.isArray(jobs)) {
    return Object.fromEntries(jobs.map((job) => [job.pageId, job]).filter(([pageId]) => pageId));
  }
  return jobs && typeof jobs === "object" ? jobs : {};
}

function recoverableGenerationImagePath(page = {}, job = {}) {
  const qualityCheckFailure = page.failureStage === "quality-check" || job.failureStage === "quality-check";
  const pageImage = page.finalImage?.path
    || page.finalImage?.source
    || page.regenerationPreviewImage?.path
    || page.regenerationPreviewImage?.source
    || "";
  const auditedCandidate = qualityCheckFailure
    ? (job.bridgeResult?.imagePath
      || job.generationResult?.imagePath
      || job.finalImage
      || job.staleFinalImage
      || "")
    : "";
  return pageImage || auditedCandidate;
}

export function image2RemainingGenerationPageIds(deck = {}, { anchorPageIds = [], pageIds = [] } = {}) {
  const anchors = new Set((anchorPageIds || []).map(String).filter(Boolean));
  const requested = new Set((pageIds || []).map(String).filter(Boolean));
  const jobs = existingGenerationJobs(deck);

  return (deck.pages || [])
    .map((page, index) => ({ page, pageNo: deps.pageNoForPage(page, index) }))
    .filter(({ page, pageNo }) => {
      const pageId = page.id || pageNo;
      if (anchors.has(String(pageNo)) || anchors.has(String(pageId))) return false;
      if (requested.size && !requested.has(String(pageNo)) && !requested.has(String(pageId))) return false;
      const job = jobs[pageId] || jobs[pageNo] || {};
      if (page.generationStatus === "stale" || job.status === "stale") return true;
      if (reusableQaCandidate(job.qaCandidate, job)) return true;
      return !recoverableGenerationImagePath(page, job);
    })
    .map(({ page, pageNo }) => page.id || pageNo);
}

function buildGenerationJob(page, index, deck, previousJob = null, options = {}) {
  const pageNo = deps.pageNoForPage(page, index);
  const styleBible = deps.buildImage2StyleBible(deck.styleProfile || deps.DEFAULT_STYLE_PROFILE, deck.typographyScale || deps.DEFAULT_TYPOGRAPHY_SCALE);
  const basePrompt = deps.buildPrompt(page, deck.styleProfile || deps.DEFAULT_STYLE_PROFILE, deck.typographyScale || deps.DEFAULT_TYPOGRAPHY_SCALE, styleBible);
  const contentAnchorContract = fixedImage2AnchorEnabled(deck)
    ? image2ContentAnchorContractForPage(deck, page, { allowGenerated: options.phase === "anchors" })
    : null;
  const anchorPromptContract = image2ContentAnchorPromptContract(contentAnchorContract);
  const anchors = initializeDualStyleAnchors(deck);
  const regeneratedAnchor = Object.values(anchors).find((anchor) => anchor?.pageId === pageNo || anchor?.pageId === page.id);
  const regenerationFeedback = normalizeImage2RepairFeedback(String(regeneratedAnchor?.regenerationFeedback || "").trim());
  const regenerationPromptContract = regenerationFeedback
    ? [
      "【本次锚点重绘修改要求】",
      regenerationFeedback,
      "保持当前页内容事实、页面角色和已选风格参考不变；只按上述要求调整视觉。"
    ].join("\n")
    : "";
  const combinedPrompt = [basePrompt, anchorPromptContract, regenerationPromptContract].filter(Boolean).join("\n\n");
  const prompt = !isImage2CoverPage(page) ? finalizeImage2BodyPrompt(combinedPrompt) : combinedPrompt;
  const hash = deps.promptHash(prompt);
  const pagePlan = deck.image2RenderPlan?.pages?.find((item) => item.pageNo === pageNo) || null;
  const image2PlanSignature = pagePlan?.promptSignature || null;
  const renderPlanSignature = deck.image2RenderPlan?.signature || null;
  const samePrompt = previousJob?.promptHash === hash
    && (!previousJob?.image2PlanSignature || previousJob.image2PlanSignature === image2PlanSignature)
    && (!previousJob?.renderPlanSignature || previousJob.renderPlanSignature === renderPlanSignature);
  const keepPreviousStatus = samePrompt && previousJob?.status && !["generated", "imported", "manual-ready", "failed"].includes(previousJob.status);
  const status = keepPreviousStatus ? previousJob.status : "queued";
  const createdAt = samePrompt && previousJob?.createdAt ? previousJob.createdAt : new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const suggestedBaseName = `${pageNo}-${deps.slugify(page.title || "slide").slice(0, 42) || "slide"}.png`;
  const userReferencePaths = (deck.styleProfile?.referenceAssets || [])
      .filter((item) => item?.type === "image" && item?.path)
      .map((item) => item.path);
  const builtInStyleReferencePaths = styleBible?.referenceAssetPaths
    || (styleBible?.referenceAssetPath ? [styleBible.referenceAssetPath] : []);
  const isCoverRole = page.masterRole === "cover" || page.narrativeRole === "cover" || (!page.masterRole && deck.styleProfile?.coverMode !== "none" && pageNo === "P01");
  const normalizedRole = isCoverRole
    ? "cover"
    : (["directory", "data", "content", "process", "conclusion"].includes(page.masterRole)
        ? page.masterRole
        : page.narrativeRole === "conclusion" || page.narrativeRole === "takeaway" ? "conclusion"
          : page.pageType === "data-native" ? "data"
            : page.pageType === "process" ? "process"
              : "content");
  const manifest = styleBible?.referenceManifest || {};
  const customReference = isCustomImage2Reference(deck.styleProfile);
  const customSelection = customReference || manifest.usage === "style-only" ? selectImage2ReferenceForRole(deck.styleProfile, styleBible, normalizedRole) : null;
  const roleMatchedStyleReferencePath = manifest.slides?.[normalizedRole]
    || (isCoverRole ? builtInStyleReferencePaths[0] : builtInStyleReferencePaths[1])
    || builtInStyleReferencePaths[0];
  const montageReferencePath = manifest.montage || null;
  const selectedStyleReferencePaths = customSelection?.paths || [
    roleMatchedStyleReferencePath,
    montageReferencePath,
    ...userReferencePaths.slice(0, 1)
  ].filter((item, itemIndex, items) => item && items.indexOf(item) === itemIndex).slice(0, 3);
  const selectedStyleReferenceSignature = deps.promptHash(JSON.stringify({
    styleId: styleBible?.styleId || deck.styleProfile?.templateId || deck.styleProfile?.id || "",
    styleBibleSignature: styleBible?.signature || null,
    role: normalizedRole,
    references: selectedStyleReferencePaths
  }));
  const styleReferencePaths = [
    ...selectedStyleReferencePaths,
    styleBible?.typographyReferenceAssetPath
  ].filter((item, itemIndex, items) => item && items.indexOf(item) === itemIndex).slice(0, 6);

  return applyCurrentStyleAnchorToJob({
    jobId: samePrompt && previousJob?.jobId ? previousJob.jobId : `job-${pageNo}-${hash}-${Date.now()}`,
    pageId: page.id || pageNo,
    pageNo,
    title: page.title,
    masterRole: isImage2CoverPage(page) ? "cover" : (pagePlan?.masterRole === "cover" ? "content" : pagePlan?.masterRole || page.masterRole || "content"),
    pageType: page.pageType,
    editableMode: page.editableMode,
    visualPriority: page.visualPriority,
    provider: "codex-imagegen",
    status,
    statusText: deps.generationStatusText(status),
    promptHash: hash,
    prompt,
    image2PlanSignature,
    renderPlanSignature,
    contentAnchorContract,
    contentAnchorContractVersion: contentAnchorContract?.version || null,
    contentAnchorPageId: contentAnchorContract?.pageId || null,
    contentAnchorSignature: contentAnchorContract?.signature || null,
    contentAnchorReferencePath: contentAnchorContract?.assetPath || null,
    styleLockSignature: styleBible?.signature || null,
    selectedStyleReferencePaths,
    selectedStyleReferenceSignature,
    referenceBundleId: deck.styleProfile?.referenceBundleId || null,
    referenceVersion: deck.styleProfile?.referenceVersion || null,
    referenceLayoutPath: customSelection ? customSelection.layoutPath : manifest.slides?.[normalizedRole] || null,
    referenceIdentityOnly: customSelection?.identityOnly || false,
    styleReferencePaths,
    typographyReferencePath: styleBible?.typographyReferenceAssetPath || null,
    suggestedFileName: suggestedBaseName,
    targetDir: deck.project?.dir ? `${deck.project.dir}/final-images` : "final-images",
    manualInstruction: null,
    qaCandidate: samePrompt ? previousJob?.qaCandidate || null : null,
    attempts: samePrompt ? Number(previousJob?.attempts || 0) : 0,
    auditAttempts: samePrompt ? Number(previousJob?.auditAttempts || 0) : 0,
    createdAt,
    updatedAt
  }, deck, options);
}

export function fixedImage2AnchorEnabled(deck = {}) {
  return deck.styleProfile?.image2ConsistencyMode !== "off"
    && deck.styleAnchor?.status !== "disabled";
}

export function applyCurrentStyleAnchorToJob(job, deck = {}, options = {}) {
  if (!fixedImage2AnchorEnabled(deck)) return job;
  const page = (deck.pages || []).find((item, index) => (item.id || deps.pageNoForPage(item, index)) === job.pageId || deps.pageNoForPage(item, index) === job.pageNo) || {};
  const phase = options.phase || job.phase || "full";
  const allowGenerated = phase === "anchors";
  const plannedDependencies = image2AnchorDependenciesForPage(deck, page, { allowGenerated });
  // 封面锚点与正文视觉母版是同一套 Style Bible 下的两个独立样本。锚点阶段若互相引用，
  // 不仅只能串行，还会在第二张写入后让第一张因依赖签名变化而被误判为 stale。
  const anchorDependencies = phase === "anchors"
    ? plannedDependencies.filter((item) => item.kind !== "content-anchor" && item.kind !== "cover-anchor")
    : plannedDependencies;
  const anchorReferencePaths = anchorDependencies
    .filter((item) => item.kind === "content-anchor" || item.kind === "cover-anchor")
    .map((item) => item.path);
  const supportingReferences = anchorDependencies
    .filter((item) => item.kind !== "content-anchor" && item.kind !== "cover-anchor")
    .map((item) => item.path);
  const hasContentMaster = anchorDependencies.some((item) => item.kind === "content-anchor");
  const styleReferencePaths = (hasContentMaster ? [
    ...anchorReferencePaths,
    job.referenceLayoutPath,
    job.typographyReferencePath,
    ...anchorDependencies.filter((item) => item.kind === "typography").map((item) => item.path)
  ] : [
    ...anchorReferencePaths,
    ...(job.selectedStyleReferencePaths || []),
    ...supportingReferences,
    ...(job.styleReferencePaths || [])
  ])
    .filter((item, index, items) => item && items.indexOf(item) === index)
    .slice(0, 4);
  return {
    ...job,
    phase,
    visualContractVersion: IMAGE2_VISUAL_CONTRACT_VERSION,
    styleReferencePaths,
    anchorDependencies,
    anchorReferencePaths,
    anchorReferencePath: anchorReferencePaths[0] || null,
    referenceRoles: styleReferencePaths.map((referencePath) => ({
      path: referencePath,
      role: anchorDependencies.find((item) => item.path === referencePath)?.kind === "content-anchor"
        ? "strict-style-master"
        : anchorDependencies.find((item) => item.path === referencePath)?.kind === "cover-anchor"
          ? "cover-style-anchor"
          : hasContentMaster && referencePath === job.referenceLayoutPath
            ? "layout-only"
          : (job.selectedStyleReferencePaths || []).includes(referencePath)
            ? "selected-style-support"
            : "content-only-support"
    })),
    anchorSignature: (phase === "anchors" ? [
      job.selectedStyleReferenceSignature ? `selected-style:${job.selectedStyleReferenceSignature}` : "",
      ...anchorDependencies.map((item) => item.signature || `${item.kind}:${item.path}`)
    ] : [
      ...anchorDependencies.map((item) => item.signature || `${item.kind}:${item.path}`),
      job.selectedStyleReferenceSignature ? `selected-style:${job.selectedStyleReferenceSignature}` : ""
    ]).filter(Boolean).join(":") || null
  };
}

export function enqueueGenerationJobs(deck, pageIds = [], options = {}) {
  const existingJobs = existingGenerationJobs(deck);
  const requested = new Set(pageIds.length ? pageIds : (deck.pages || []).map((page) => page.id));
  const nextJobs = { ...existingJobs };
  const queued = [];

  (deck.pages || []).forEach((page, index) => {
    const pageNo = deps.pageNoForPage(page, index);
    if (!requested.has(page.id) && !requested.has(pageNo)) return;
    const pageId = page.id || pageNo;
    const job = buildGenerationJob(page, index, deck, existingJobs[pageId], options);
    nextJobs[pageId] = job;
    queued.push(job);
  });

  return { jobs: nextJobs, queued };
}

export function reconcileGenerationJobs(deck = {}) {
  const jobs = existingGenerationJobs(deck);
  const pages = deck.pages || [];
  const reconciled = { ...jobs };

  pages.forEach((page, index) => {
    const pageNo = deps.pageNoForPage(page, index);
    const pageId = page.id || pageNo;
    const job = reconciled[pageId];
    if (!job) return;
    const rebuiltJob = buildGenerationJob(page, index, deck, job, { phase: job.phase || "full" });
    const prompt = rebuiltJob.prompt;
    const hash = deps.promptHash(prompt);
    const planChanged = Boolean(job.image2PlanSignature && job.image2PlanSignature !== rebuiltJob.image2PlanSignature)
      || Boolean(job.renderPlanSignature && job.renderPlanSignature !== rebuiltJob.renderPlanSignature)
      || Boolean(job.anchorSignature && job.anchorSignature !== rebuiltJob.anchorSignature);
    const anchorPages = [deck.styleAnchors?.cover?.pageId, deck.styleAnchors?.content?.pageId].filter(Boolean);
    const isAnchorPhaseJob = job.phase === "anchors"
      && fixedImage2AnchorEnabled(deck)
      && (anchorPages.includes(pageId) || anchorPages.includes(pageNo));
    // Cover and content anchors render independently in the anchor phase.
    // Binding or confirming one anchor rewrites the deck and changes the other
    // job's rebuilt prompt (the content-anchor contract appears), which must
    // NOT make an already-rendered anchor stale unless its own style/master
    // contract actually changed. This protection applies to BOTH anchors.
    const anchorContractChanged = isAnchorPhaseJob && (
      Boolean(job.image2PlanSignature && job.image2PlanSignature !== rebuiltJob.image2PlanSignature)
      || Boolean(job.renderPlanSignature && job.renderPlanSignature !== rebuiltJob.renderPlanSignature)
      || Boolean(job.selectedStyleReferenceSignature && job.selectedStyleReferenceSignature !== rebuiltJob.selectedStyleReferenceSignature)
      || Boolean(job.styleLockSignature && job.styleLockSignature !== rebuiltJob.styleLockSignature)
    );
    const jobNeedsRefresh = isAnchorPhaseJob
      ? anchorContractChanged
      : (job.promptHash !== hash || planChanged);
    if (jobNeedsRefresh) {
      reconciled[pageId] = {
        ...rebuiltJob,
        status: "stale",
        statusText: deps.generationStatusText("stale"),
        staleFinalImage: page.finalImage?.path || job.finalImage || null,
        updatedAt: new Date().toISOString()
      };
      return;
    }
    if (job.status === "stale") {
      // Self-heal anchors that were wrongly marked stale by the old logic:
      // if the anchor's own contract did not change and its rendered image
      // still exists, restore it instead of forcing a costly regeneration.
      const recoverableImage = page.finalImage?.path || job.staleFinalImage || job.finalImage || null;
      if (isAnchorPhaseJob && !anchorContractChanged && recoverableImage) {
        reconciled[pageId] = {
          ...job,
          ...rebuiltJob,
          status: "generated",
          statusText: deps.generationStatusText("generated"),
          finalImage: recoverableImage,
          staleFinalImage: null,
          updatedAt: new Date().toISOString()
        };
        return;
      }
      reconciled[pageId] = {
        ...job,
        ...rebuiltJob,
        status: "stale",
        statusText: deps.generationStatusText("stale"),
        staleFinalImage: page.finalImage?.path || job.staleFinalImage || job.finalImage || null,
        updatedAt: new Date().toISOString()
      };
      return;
    }
    // A previous accepted image must not promote its pending replacement.
    if ((job.qaCandidate && ["queued", "generating", "failed"].includes(job.status))
      || (job.workStage && ["queued", "generating"].includes(job.status))) return;
    if (page.finalImage?.path) {
      reconciled[pageId] = {
        ...job,
        ...rebuiltJob,
        status: "imported",
        statusText: deps.generationStatusText("imported"),
        finalImage: page.finalImage.path,
        updatedAt: new Date().toISOString()
      };
    }
  });

  return reconciled;
}
