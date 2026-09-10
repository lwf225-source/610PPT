import { REFERENCE_STYLE_PACKS } from "/shared/reference-style-catalog.js?v=20260910-reference-masters-v2";
import { plainTextDraft } from "./plain-copy.js?v=20260906-plain-copy-v1";
import { createStyleReferenceUpload } from "./style-reference-upload.js?v=20260907-ai-models-v1";
import { renderReferencePreview, referencePreviewUrl } from "./reference-preview.js";
import { missingImagePageIdsForState, visiblePagesForState } from "./page-visibility.js?v=20260909-generation-status-v6";
import { batchRepairCounts, batchRepairState } from "./batch-repair-state.js?v=20260907-qa-repair-v1";
import { isStyleProfileConfirmed, styleGenerationUiAction } from "./style-confirmation.js?v=20260828-style-running-v1";
import { startingTaskForStep, taskForStep } from "./task-step.js?v=20260828-immediate-loading-v1";
import { splitActionState, splitDisplayConfiguration, splitLifecycleControl, splitTaskBusyForState } from "./split-task-state.js";
import { SPLIT_STAGES, splitStatus, splitElapsedLabel } from "./split-status.js?v=20260909-split-status-v2";
import { contentSummary, contentPreview } from "./content-review.js?v=20260906-plain-copy-v1";
import { mountCopyBlueprintEditor } from "./copy-blueprint-editor.js?v=20260906-plain-copy-v1";
import { createExportPreviewController, exportPreviewMarkup } from "./export-preview-state.js?v=20260906-plain-copy-v1";
import { createProjectHistoryDialog, projectHistoryBusy, tasksAfterHistoryRestore } from "./project-history.js?v=20260906-plain-copy-v1";
import { createTaskObserver } from "./task-observer.js?v=20260909-progress-sync-v1";
import { isTaskSettled, reduceTaskLifecycle } from "/shared/task-lifecycle-contract.js?v=20260907-split-status-v1";
import { isTaskDomainEvent, reduceTaskDomain } from "/shared/task-domain-reducer.js?v=20260906-plain-copy-v1";
import {
  LAST_PROJECT_STORAGE_KEY,
  findProjectForDeck,
  findRestorableProject,
  visibleProjectsWithSelection
} from "./project-session.js";


const state = {
  activeStep: 1,
  contentExpandedPageNo: "",
  contentEditPageNo: "",
  contentStructureMode: false,
  contentSaveBusy: false,
  selectedProject: null,
  task: null,
  selectedPageNo: "",
  eventSource: null,
  document: null,
  recommendation: null,
  narrativeMode: "narrative",
  contentDetailMode: "focus",
  deck: null,
  pendingStyleId: "",
  stylePreviewPackId: "",
  stylePreviewSlideIndex: 0,
  projectQuery: "",
  projectsExpanded: false,
  projectDeletion: null,
  projectDeletionBusy: false,
  tasks: [],
  documentSplitBusy: false,
  pageCountAnalysisRun: 0,
  pageCountAnalysisController: null,
  mergeSourcePageNo: "",
  pendingDeletePageNo: "",
  pageMutationBusy: false,
  anchorBusy: "",
  generationStartError: "",
  taskStartBusy: "",
  qaActionBusy: "",
  qaReviewTask: null
};

const collapsedProjectLimit = 8;
const masterPackVersion = "1.0.0";

function readLastProjectSlug() {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberProject(project) {
  const slug = String(project?.slug || "").trim();
  if (!slug) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, slug);
  } catch {
    // The project remains usable when browser storage is unavailable.
  }
}

function forgetLastProject() {
  try {
    window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // Nothing else to clean up when browser storage is unavailable.
  }
}

const masterPageRoles = [
  { id: "cover", label: "封面" },
  { id: "directory", label: "目录" },
  { id: "data", label: "核心指标" },
  { id: "content", label: "业务结构" },
  { id: "process", label: "AI 投入" },
  { id: "conclusion", label: "结论页" }
];

const masterContractLabels = {
  layoutSystem: "版式系统",
  titleAnchor: "正文视觉母版",
  typography: "字体层级",
  spacing: "间距规范",
  anchor: "一致性锚点"
};

const styleMasterMetaCache = new Map();

const narrativeOptions = [
  { id: "narrative", name: "故事推进", flow: "起因 → 转折 → 方法 → 结果" },
  { id: "pyramid", name: "结论先行", flow: "结论 → 论据 → 建议" },
  { id: "instructional", name: "方法教学", flow: "步骤 → 规则 → 案例" },
  { id: "showcase", name: "成果展示", flow: "结果 → 亮点 → 证明" },
  { id: "briefing", name: "简报纪要", flow: "背景 → 现状 → 风险 → 行动" }
];

const contentDetailOptions = [
  { id: "focus", name: "重点展示", description: "保留原文核心信息、关键数字和必要依据" },
  { id: "detailed", name: "详细展示", description: "保留更多原文分项、过程、背景和支撑信息" }
];

const stylePacks = [
  ...REFERENCE_STYLE_PACKS,
  { id: "image2-game-handdrawn", name: "游戏化手绘风", description: "游戏分享、复盘、强记忆点页面", primary: "#E87817", previewId: "image2-game-handdrawn", promptBase: "2D 游戏手绘信息图，整页视觉叙事，统一标题组件与画面锚点" },
  { id: "image2-dark-tactical", name: "暗色战术风", description: "游戏业务、策略复盘、沉浸式展示", primary: "#18D1C0", previewId: "image2-dark-tactical", promptBase: "暗色战术信息图，深色底，青绿色信息层，整页视觉一致" },
  { id: "image2-consulting-poster", name: "咨询海报风", description: "观点表达、策略汇报、视觉封面", primary: "#BE5B31", previewId: "image2-consulting-poster", promptBase: "咨询海报式整页信息图，强标题、少文字、重点数字与空间秩序" }
];

const stepCopy = {
  1: { eyebrow: "第 1 步 / 4", title: "上传文档", description: "上传内容，选择讲述结构与页数，再交给 AI 拆页。" },
  2: { eyebrow: "第 2 步 / 4", title: "确认内容", description: "先看整套讲什么，点击任一页查看或修改内容。" },
  3: { eyebrow: "第 3 步 / 4", title: "选择风格", description: "选择一套风格，统一整套 PPT 的视觉。" },
  4: { eyebrow: "第 4 步 / 4", title: "编辑导出", description: "逐页预览、修改文案并完成质量检查，确认后导出 PPTX。" }
};

const $ = (id) => document.getElementById(id);
const projectList = $("projectList");
const pageStream = $("pageStream");
let installPrompt = null;
let pageCountAnalysisTimer = null;
let pageCountAnalysisHideTimer = null;
let pageCountAnalysisDockState = null;
let taskProgressToastTimer = null;
let taskProgressToastStartedAt = 0;
let taskProgressToastKey = "";
let splitConnectionIssue = false;
let noticeTimer = null;
let workspaceLoadEpoch = 0;
let generationControlBusy = false;
let referenceProjectSlug = "";
const referenceUpload = createStyleReferenceUpload({
  root: $("styleReferenceUpload"), fileInput: $("referenceFile"), api,
  onNotice: (message, mode) => {
    $("referenceDialogNotice").textContent = message;
    if (!$("referenceDialog").open) showNotice(message, mode);
  },
  currentProject: () => state.selectedProject?.slug || "",
  onChange: (reference) => {
    if (referenceUpload.isBusy()) $("referenceDialogNotice").textContent = "";
    if (reference?.profileId
      && (!state.pendingStyleId || state.pendingStyleId.startsWith("image2-reference-") || !hasConfirmedStyle())) {
      state.pendingStyleId = reference.profileId;
    }
    renderStylePanel(); updateActions();
  },
  onAttach: async (bundleId) => {
    const projectSlug = state.selectedProject?.slug;
    if (!projectSlug) return;
    const loadEpoch = workspaceLoadEpoch;
    const result = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/style-reference`, {
      method: "POST", body: JSON.stringify({ bundleId })
    });
    if (loadEpoch === workspaceLoadEpoch && state.selectedProject?.slug === projectSlug) { state.deck = result.deck; state.pendingStyleId = ""; }
  }
});
$("retryReferenceGeneration").addEventListener("click", async () => {
  const id = state.task?.input?.referenceBundleId;
  if (!id || step4TaskInProgress()) return;
  await referenceUpload.load(id);
  await startTask("image2-compile", { referenceBundleId: id, referenceVersion: referenceUpload.get()?.version });
});
$("closeReferenceDialog").addEventListener("click", () => $("referenceDialog").close());

const taskObserver = createTaskObserver({
  currentTask: () => state.task,
  currentProject: () => state.selectedProject?.slug,
  readSnapshot: (projectSlug, taskId, { signal, after }) => api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(taskId)}?after=${after}`, { signal }),
  applySnapshot: (task) => {
    state.task = task;
    rememberQaTask(task);
    if (!state.selectedPageNo) state.selectedPageNo = task.pages?.[0]?.pageNo || "";
    renderTask(); updateActions();
  },
  applyEvent: absorbEvent,
  isSettled: isTaskSettled,
  onSettled: (_task, projectSlug) => loadDeck(projectSlug),
  onConnectionRestored: () => { splitConnectionIssue = false; renderTask(); updateActions(); },
  onConnectionIssue: () => { if (state.task && !isTaskSettled(state.task)) { splitConnectionIssue = true; renderTask(); setTaskStatus("连接恢复中", "neutral"); } }
});
// Background suspension and network changes can leave a silent event stream.
// Reconcile from persisted state as soon as this workspace becomes usable again.
window.addEventListener("online", () => taskObserver.resume());
window.addEventListener("pageshow", () => taskObserver.resume());
window.addEventListener("focus", () => taskObserver.resume());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") taskObserver.resume();
});
const exportPreviewController = createExportPreviewController({
  request: api,
  onChange: ({ binding, preview }) => {
    const task = taskForActiveStep();
    if (state.activeStep !== 4 || !binding || state.selectedProject?.slug !== binding.projectSlug || task?.taskId !== binding.taskId || task?.export?.preview?.jobId !== preview?.jobId) return;
    task.export = { ...task.export, preview };
    if (state.task?.taskId === task.taskId) state.task.export = task.export;
    for (const entry of state.tasks) if (entry.taskId === task.taskId) entry.export = task.export;
    renderTaskSummary(task);
  }
});
window.addEventListener("pagehide", () => exportPreviewController.dispose());
const projectHistoryDialog = createProjectHistoryDialog({
  document, request: api, onRestored: applyHistoryRestoration,
  isBusy: (slug) => state.projectDeletionBusy || (state.selectedProject?.slug === slug && (Boolean(state.taskStartBusy) || projectHistoryBusy([...(state.tasks || []), ...(state.task ? [state.task] : [])], slug)))
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  }[character]));
}

function resourceUrl(url) {
  return referencePreviewUrl(url);
}

function artifactUrl(filePath) {
  return resourceUrl(`/api/v2/artifacts/file?path=${encodeURIComponent(filePath)}`);
}

function downloadArtifact(filePath) {
  if (!filePath) return;
  const url = artifactUrl(filePath);
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.click();
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "本地服务请求失败"), { status: response.status, statusCode: response.status });
  return payload;
}

let dataMigrationBusy = false;
let dataMigrationState = null;

function renderDataMigration(migration = null) {
  dataMigrationState = migration;
  const banner = $("dataMigrationBanner");
  const button = $("runDataMigration");
  const available = migration?.status === "available";
  banner.hidden = !available;
  if (!available) return;
  const projectCount = Number(migration.legacyProjectCount || 0);
  $("dataMigrationCopy").textContent = `迁移前会自动备份，已有同名项目不会覆盖；检测到 ${projectCount} 个旧项目。`;
  button.disabled = dataMigrationBusy;
  button.textContent = dataMigrationBusy ? "正在迁移" : `迁移 ${projectCount} 个项目`;
}

async function loadDataMigrationStatus() {
  try {
    const { migration } = await api("/api/v2/data-migration/status");
    renderDataMigration(migration);
    return migration;
  } catch {
    renderDataMigration(null);
    return null;
  }
}

async function runDataMigration() {
  if (dataMigrationBusy) return;
  dataMigrationBusy = true;
  renderDataMigration(dataMigrationState);
  try {
    const { migration } = await api("/api/v2/data-migration/run", { method: "POST" });
    renderDataMigration(migration);
    await loadProjects();
    const imported = Number(migration?.importedProjects?.length || 0);
    showNotice(`旧项目数据已迁移并完成备份${imported ? `：导入 ${imported} 个项目` : ""}`, "success");
  } catch (error) {
    showNotice(`迁移旧数据失败：${error.message}`, "error");
    await loadDataMigrationStatus();
  } finally {
    dataMigrationBusy = false;
    await loadDataMigrationStatus();
  }
}

function showNotice(message, mode = "neutral") {
  const notice = $("globalNotice");
  window.clearTimeout(noticeTimer);
  noticeTimer = null;
  if (!message) {
    notice.hidden = true;
    notice.classList.remove("showing");
    notice.textContent = "";
    return;
  }
  notice.dataset.mode = mode;
  notice.setAttribute("role", mode === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", mode === "error" ? "assertive" : "polite");
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.remove("showing");
  void notice.offsetWidth;
  notice.classList.add("showing");
  const duration = mode === "error" ? 7000 : mode === "warning" ? 5500 : 3500;
  noticeTimer = window.setTimeout(() => {
    notice.hidden = true;
    notice.classList.remove("showing");
    notice.textContent = "";
    noticeTimer = null;
  }, duration);
}

function updatePageCountAnalysisElapsed(startedAt) {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  $("pageCountAnalysisElapsed").textContent = `已用时 ${elapsed} 秒`;
  if (pageCountAnalysisDockState?.mode === "running") {
    pageCountAnalysisDockState.elapsed = elapsed;
    renderStepActionDock();
  }
}

function showPageCountAnalysisOverlay() {
  const overlay = $("pageCountAnalysisOverlay");
  const startedAt = Date.now();
  window.clearTimeout(pageCountAnalysisHideTimer);
  window.clearInterval(pageCountAnalysisTimer);
  overlay.hidden = true;
  overlay.dataset.mode = "running";
  overlay.setAttribute("aria-busy", "true");
  $("pageCountAnalysisTitle").textContent = "AI 正在分析建议页数";
  $("pageCountAnalysisDetail").textContent = "正在读取内容结构、信息密度与章节边界";
  pageCountAnalysisDockState = {
    mode: "running",
    title: "AI 正在分析建议页数",
    detail: "正在读取内容结构、信息密度与章节边界",
    elapsed: 0
  };
  renderTask();
  updatePageCountAnalysisElapsed(startedAt);
  pageCountAnalysisTimer = window.setInterval(() => updatePageCountAnalysisElapsed(startedAt), 1000);
}

function finishPageCountAnalysisOverlay({ mode, title, detail, delay = 1400 }) {
  const overlay = $("pageCountAnalysisOverlay");
  window.clearInterval(pageCountAnalysisTimer);
  pageCountAnalysisTimer = null;
  overlay.hidden = true;
  overlay.dataset.mode = mode;
  overlay.setAttribute("aria-busy", "false");
  $("pageCountAnalysisTitle").textContent = title;
  $("pageCountAnalysisDetail").textContent = detail;
  $("pageCountAnalysisElapsed").textContent = mode === "success" ? "分析完成" : "可手动设置页数";
  pageCountAnalysisDockState = { mode, title, detail, elapsed: 0 };
  renderStepActionDock();
  window.clearTimeout(pageCountAnalysisHideTimer);
  pageCountAnalysisHideTimer = window.setTimeout(() => {
    overlay.hidden = true;
    pageCountAnalysisDockState = null;
    renderStepActionDock();
  }, delay);
}

function cancelPageCountAnalysis() {
  state.pageCountAnalysisRun += 1;
  state.pageCountAnalysisController?.abort();
  state.pageCountAnalysisController = null;
  window.clearInterval(pageCountAnalysisTimer);
  window.clearTimeout(pageCountAnalysisHideTimer);
  pageCountAnalysisTimer = null;
  pageCountAnalysisHideTimer = null;
  pageCountAnalysisDockState = null;
  $("pageCountAnalysisOverlay").hidden = true;
  renderStepActionDock();
}

function setEngineStatus(text, mode = "neutral") {
  const node = $("engineStatus");
  node.textContent = text;
  node.dataset.mode = mode;
}

function setTaskStatus(text, mode = "neutral") {
  const node = $("taskStatus");
  node.textContent = text;
  node.dataset.mode = mode;
}

function hasConfirmedStyle(profile = state.deck?.styleProfile) {
  return isStyleProfileConfirmed(profile, {
    id: "image2-dark-tactical",
    version: masterPackVersion
  });
}

function activeStyleTaskKind(pack = activeStylePack()) {
  const expectedKind = "image2-compile";
  if (state.taskStartBusy === expectedKind) return expectedKind;
  const activeTasks = [state.task, ...(state.tasks || []).filter((task) => task.taskId !== state.task?.taskId)].filter(Boolean);
  return activeTasks.some((task) => task.kind === expectedKind && ["queued", "running"].includes(task.status))
    ? expectedKind
    : "";
}

function currentStyleGenerationAction(pack = activeStylePack()) {
  if (!pack) return { mode: "generate", label: "确认风格并生成 PPT", busyLabel: "正在锁定风格" };
  const action = styleGenerationUiAction(state.deck || {}, pack, {
    id: "image2-dark-tactical",
    version: masterPackVersion
  }, activeStyleTaskKind(pack));
  return ["resume", "running"].includes(action.mode) ? action : { ...action, label: "确认风格并开始生成" };
}

function hasPages() {
  return Boolean(state.deck?.pages?.length || state.task?.pages?.length);
}

function splitTaskInProgress() {
  return splitTaskBusyForState({
    taskStartBusy: state.taskStartBusy,
    activeTask: state.task,
    tasks: state.tasks
  });
}

function canEnterStep(step) {
  if (step === 1) return true;
  if (step === 2) return Boolean(state.selectedProject && hasPages());
  if (step >= 3 && splitTaskInProgress()) return false;
  if (step >= 3 && splitTaskNeedsCompletion()) return false;
  if (step === 3) return Boolean(state.selectedProject && state.deck?.pages?.length && splitConfigurationMatchesDeck());
  return Boolean(state.selectedProject && state.deck?.pages?.length && hasConfirmedStyle());
}

function splitTaskNeedsCompletion() {
  const task = taskForStep({ activeTask: state.task, tasks: state.tasks, step: 2 });
  return splitLifecycleControl(task)?.action === "resume";
}

function splitConfigurationMatchesDeck() {
  if (!state.deck?.pages?.length) return false;
  const profile = state.deck.styleProfile || {};
  const targetPageCount = Number($("targetPageCount")?.value) || Number(profile.targetPageCount) || state.deck.pages.length;
  return (profile.narrativeMode || "narrative") === state.narrativeMode
    && (profile.contentDetailMode || "focus") === state.contentDetailMode
    && Number(profile.targetPageCount || state.deck.pages.length) === targetPageCount;
}

function setActiveStep(step, { force = false } = {}) {
  const nextStep = Math.max(1, Math.min(4, Number(step) || 1));
  if (!force && !canEnterStep(nextStep)) {
    const messages = {
      2: "请先上传文档并完成拆页。",
      3: splitTaskInProgress() ? "拆页文案仍在生成，请完成后再选择风格。" : "请先确认拆页文案。",
      4: splitTaskInProgress() ? "拆页文案仍在生成，请完成后再编辑导出。" : "请先选择并确认风格。"
    };
    showNotice(messages[nextStep], "warning");
    return;
  }
  if (state.contentSaveBusy) return showNotice("正在保存，请稍候。", "warning");
  if (state.activeStep === 2 && nextStep !== 2 && hasContentDrafts()) {
    const draftKey = [...copyEditorDrafts.keys()].find((key) => JSON.parse(key)[0] === state.selectedProject?.slug);
    state.selectedPageNo = state.contentExpandedPageNo = JSON.parse(draftKey)[1];
    renderTask();
    showNotice("还有未保存的修改，请先保存或放弃本页修改。", "warning");
    return;
  }
  state.activeStep = nextStep;
  showNotice("");
  const copy = stepCopy[nextStep];
  $("stepEyebrow").textContent = copy.eyebrow;
  $("stepTitle").textContent = copy.title;
  $("stepDescription").textContent = copy.description;

  $("step1Panel").classList.toggle("active", nextStep === 1);
  $("step1Panel").hidden = nextStep !== 1;
  $("pageWorkflow").classList.toggle("active", nextStep === 2 || nextStep === 4);
  $("pageWorkflow").classList.toggle("review-mode", nextStep === 4);
  $("pageWorkflow").hidden = nextStep !== 2 && nextStep !== 4;
  $("step3Panel").classList.toggle("active", nextStep === 3);
  $("step3Panel").hidden = nextStep !== 3;

  document.querySelectorAll(".step-button").forEach((button) => {
    const buttonStep = Number(button.dataset.step);
    button.classList.toggle("active", buttonStep === nextStep);
    button.classList.toggle("completed", buttonStep < nextStep && canEnterStep(buttonStep));
    button.setAttribute("aria-current", buttonStep === nextStep ? "step" : "false");
  });

  if (nextStep !== 2 && nextStep !== 4) {
    document.body.classList.remove("image2-anchor-workspace");
    $("pageWorkflow").classList.remove("image2-anchor-mode");
    $("image2AnchorPanel").hidden = true;
  }
  if (nextStep === 2 || nextStep === 4) configurePageWorkspace(nextStep);
  if (nextStep === 3) renderStylePanel();
  updateActions();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function configurePageWorkspace(step) {
  const isReview = step === 4;
  $("pageWorkflow").classList.toggle("content-review-mode", step === 2);
  const showAnchors = isReview;
  $("stageEyebrow").textContent = isReview ? "预览与导出" : "整套生成";
  $("stageTitle").textContent = isReview ? "编辑导出" : "整套大纲";
  $("stageDescription").textContent = isReview
    ? "预览每一页，修改后重新生成或直接检查导出。"
    : "查看顺序和重点，展开需要修改的页面。";
  $("pagePanelTitle").textContent = isReview ? "页面预览与文案" : "本页文案";
  $("startSplit").hidden = isReview;
  $("goStyle").hidden = isReview;
  $("startGeneration").hidden = !isReview || showAnchors;
  $("startQaExport").hidden = !isReview || (showAnchors && !image2AnchorsConfirmed());
  $("image2AnchorPanel").hidden = !showAnchors;
  $("pageWorkflow").classList.toggle("image2-anchor-mode", showAnchors);
  document.body.classList.toggle("image2-anchor-workspace", showAnchors);
  document.querySelector(".page-workspace").hidden = showAnchors;
  if (showAnchors) renderImage2Anchors();
  renderSplitConfigurationSummary(isReview);
  renderTask();
}

function renderSplitConfigurationSummary(isReview = state.activeStep === 4) {
  const node = $("splitConfigurationSummary");
  if (!node) return;
  const configuration = splitDisplayConfiguration({ task: taskForActiveStep(), deck: state.deck, narrativeMode: state.narrativeMode, contentDetailMode: state.contentDetailMode });
  if (isReview || !configuration.pageCount) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const narrative = narrativeOptions.find((option) => option.id === configuration.narrativeMode)?.name || selectedNarrative().name;
  const contentDetail = contentDetailOptions.find((option) => option.id === configuration.contentDetailMode)?.name || selectedContentDetail().name;
  const configurationChanged = configuration.source === "deck" && !splitConfigurationMatchesDeck();
  node.textContent = `${narrative} · ${contentDetail} · ${configuration.pageCount}页${configurationChanged ? " · 设置已改变，请重新拆页" : ""}`;
  node.hidden = false;
}

function renderStepActionDock() {
  const dock = $("stepActionDock");
  if (!dock) return;
  const step = state.activeStep;
  const visible = step >= 1 && step <= 3;
  dock.hidden = !visible;
  document.body.classList.toggle("step-action-dock-workspace", visible);
  if (!visible) return;

  const progress = $("stepDockProgress");
  const progressLabel = $("stepDockProgressLabel");
  const title = $("stepDockTitle");
  const hint = $("stepDockHint");
  const secondary = $("stepDockSecondary");
  const primary = $("stepDockPrimary");
  dock.classList.remove("content-review-ready");
  secondary.hidden = true;
  secondary.dataset.sourceAction = "";
  secondary.dataset.targetStep = "";
  primary.dataset.sourceAction = "";
  primary.dataset.targetStep = "";

  if (step === 1) {
    const ready = Boolean(state.document?.text);
    const documentName = state.document?.source?.name || state.document?.name || "";
    const count = Number($("targetPageCount")?.value) || 0;
    progress.textContent = ready ? "1 / 1" : "0 / 1";
    progressLabel.textContent = ready ? "文档已上传" : "等待上传文档";
    title.textContent = ready ? "拆页设置已确认" : "先上传一份文档";
    hint.textContent = ready
      ? `${documentName || "当前文档"} · ${selectedNarrative().name} · ${selectedContentDetail().name} · ${count ? `${count} 页` : "AI 分析页数"}`
      : "支持 Markdown、Word、PPTX、PDF";
    primary.dataset.sourceAction = "splitDocument";
    primary.textContent = ready ? "开始拆页" : "请先上传文档";
    primary.disabled = $("splitDocument").disabled;
  } else if (step === 2) {
    const analysis = pageCountAnalysisDockState;
    const task = taskForActiveStep();
    const taskOutlinePages = [...(task?.pages || [])];
    const pages = taskOutlinePages.length ? taskOutlinePages : [...(state.deck?.pages || [])];
    const configuration = splitDisplayConfiguration({ task, deck: state.deck });
    const total = configuration.source === "task" ? configuration.pageCount : Number(task?.total) || pages.length || 0;
    const completed = task
      ? Math.min(total || pages.length, Number(task.completed ?? pages.length) || 0)
      : pages.length;
    const running = ["queued", "running"].includes(task?.status);
    const failed = ["failed", "paused", "cancelled"].includes(task?.status);
    const split = splitStatus(task, { connectionIssue: splitConnectionIssue });
    const lifecycle = splitLifecycleControl(task, splitControlBusy);
    const lifecycleButton = $("controlSplit");
    lifecycleButton.hidden = !lifecycle;
    lifecycleButton.textContent = lifecycle?.label || "取消拆页";
    lifecycleButton.disabled = !lifecycle || lifecycle.disabled;
    const matches = splitConfigurationMatchesDeck();
    progress.textContent = analysis ? (analysis.mode === "success" ? "1 / 1" : "0 / 1") : running ? (split.stage ? `第 ${split.stage}/4 步` : "准备中") : `${completed} / ${total || pages.length || 0}`;
    progressLabel.textContent = analysis
      ? (analysis.mode === "running" ? `正在分析 · ${analysis.elapsed || 0} 秒` : analysis.mode === "success" ? "建议页数已生成" : "页数分析未完成")
      : running
        ? `${split.label} · 共 ${total || "待定"} 页`
      : total
        ? `已完成 ${completed} 页 · ${Math.round((completed / total) * 100)}%`
        : "等待生成文案";
    title.textContent = analysis
      ? analysis.title
      : running
      ? split.title
      : failed
        ? split.title
        : pages.length && matches
          ? "整套文案已就绪"
          : pages.length
            ? "拆页设置已改变"
            : "等待拆页文案";
    hint.textContent = analysis
      ? analysis.detail
      : running
      ? `${split.detail} · ${splitElapsedLabel(task)}`
      : failed
        ? split.detail
        : pages.length && matches
          ? "确认页面结构与文案后，进入风格选择。"
          : pages.length
            ? "请按当前设置重新拆页，再确认文案。"
            : "文案生成完成后可进入风格选择。";
    secondary.hidden = Boolean(analysis);
    secondary.dataset.sourceAction = lifecycle ? "controlSplit" : "startSplit";
    secondary.textContent = lifecycle?.label || (running ? "正在拆页" : "重新拆页");
    secondary.disabled = lifecycle ? lifecycle.disabled : running || $("startSplit").disabled;
    primary.dataset.sourceAction = "goStyle";
    primary.textContent = analysis
      ? (analysis.mode === "running" ? "正在分析页数" : "正在创建拆页任务")
      : running
        ? "生成完成后可确认"
        : "下一步：选风格";
    primary.disabled = Boolean(analysis) || running || $("goStyle").disabled;
    if (!analysis && !running && !failed && pages.length) {
      dock.classList.add("content-review-ready");
      title.textContent = `共 ${pages.length} 页 · 内容可随时修改`;
      hint.textContent = matches ? "满意后直接进入下一步，无需逐页确认。" : "内容偏好已改变，可在调整整套内容中重新生成。";
      secondary.dataset.sourceAction = "adjustContent";
      secondary.textContent = "调整整套内容";
      secondary.disabled = false;
      secondary.hidden = false;
    }
  } else {
    const pack = activeStylePack();
    const styleAction = currentStyleGenerationAction(pack);
    const generationRunning = styleAction.mode === "running";
    const routeName = "AI 整页视觉";
    progress.textContent = pack ? "1 / 1" : "0 / 1";
    progressLabel.textContent = generationRunning ? "生成任务进行中" : pack ? "已选择 1 套风格" : "等待选择风格";
    title.textContent = generationRunning ? `正在生成 ${pack.name}` : pack ? `已选择 ${pack.name}` : "请选择整套风格";
    hint.textContent = pack
      ? generationRunning
        ? `${routeName} · 已进入生成流程，返回编辑导出查看当前进度。`
        : styleAction.mode === "resume"
        ? `${routeName} · 当前风格已锁定，直接返回编辑导出，不会重新生成。`
        : styleAction.mode === "replace"
          ? `${routeName} · 应用后会按新风格重新生成视觉锚点。`
          : `${routeName} · 确认后进入编辑导出并开始生成。`
      : `${routeName} · 选择一套母版后确认。`;
    secondary.hidden = false;
    secondary.dataset.targetStep = "2";
    secondary.textContent = "返回调整文案";
    secondary.disabled = false;
    primary.dataset.sourceAction = generationRunning ? "" : "confirmStyleGenerate";
    primary.dataset.targetStep = generationRunning ? "4" : "";
    primary.textContent = $("confirmStyleGenerate").textContent;
    primary.disabled = $("confirmStyleGenerate").disabled;
  }
  dock.classList.toggle("no-secondary", secondary.hidden);
}

function updateActions() {
  updateReferenceControls();
  const hasProject = Boolean(state.selectedProject);
  const splitBusy = splitTaskInProgress();
  const step4Busy = step4TaskInProgress();
  const image2MutationBusy = image2MutationInProgress();
  const splitActions = splitActionState({
    hasProject,
    configurationMatches: splitConfigurationMatchesDeck() && !splitTaskNeedsCompletion(),
    splitBusy
  });
  $("splitDocument").disabled = !state.document?.text || state.documentSplitBusy;
  $("startSplit").disabled = splitActions.restartDisabled;
  $("goStyle").disabled = splitActions.confirmDisabled;
  $("startGeneration").disabled = !hasProject || !hasConfirmedStyle();
  $("startQaExport").disabled = !hasProject || !hasConfirmedStyle()
    || !image2AnchorsConfirmed();
  const stylePack = activeStylePack();
  const styleAction = currentStyleGenerationAction(stylePack);
  const confirmStyleButton = $("confirmStyleGenerate");
  confirmStyleButton.textContent = styleAction.label;
  confirmStyleButton.disabled = !hasProject || !stylePack || (stylePack.custom && (referenceUpload.isBusy() || referenceUpload.isDirty())) || (Boolean(activeStyleTaskKind(stylePack)) && styleAction.mode !== "running");
  const remainingButton = $("generateRemainingPages");
  const generationTask = taskForActiveStep();
  const canStopGeneration = generationStopAvailable(generationTask);
  const stopButton = $("stopGeneration");
  if (stopButton) {
    stopButton.hidden = !canStopGeneration;
    stopButton.disabled = generationControlBusy || generationTask?.phase === "cancelling";
    stopButton.textContent = stopButton.disabled ? "正在停止…" : "停止生成";
  }
  if (remainingButton) {
    remainingButton.hidden = canStopGeneration;
    const pages = visiblePages();
    const missingAnchorKind = missingImage2AnchorKind();
    const anchorActionReady = image2GenerationFailure(generationTask)?.compileFailed || image2AnchorsConfirmed() || canGenerateMissingImage2Anchor(missingAnchorKind);
    remainingButton.disabled = !hasProject || !pages.length || !anchorActionReady || image2MutationBusy || step4Busy || Boolean(state.qaActionBusy);
    const qaTask = qaTaskForReview();
    if (state.task?.kind === "qa-export" && qaTask?.qa && !qaTask.export?.path) {
      const review = qaDecisionState(qaTask.qa);
      remainingButton.disabled = remainingButton.disabled
        || (!review.canExport && !review.canStartFixes)
        || Boolean(state.qaActionBusy);
    }
  }
  const adjustAnchorsButton = $("adjustImage2Anchors");
  if (adjustAnchorsButton) adjustAnchorsButton.disabled = image2MutationBusy || step4Busy;
  const regenerateSubmit = $("anchorRegenerateSubmit");
  if (regenerateSubmit && !$("anchorRegenerateKind")?.value.startsWith("qa-page:")) {
    regenerateSubmit.disabled = image2MutationBusy || String($("anchorRegenerateFeedback")?.value || "").trim().length < 2;
  }
  const directExportButton = $("directExportPptx");
  if (directExportButton) {
    const pages = visiblePages();
    const allPagesVisible = pages.length > 0 && pages.every((page) => Boolean(pageImagePath(page)));
    directExportButton.hidden = state.activeStep !== 4
      || !allPagesVisible;
    if (remainingButton) {
      remainingButton.classList.toggle("primary", directExportButton.hidden);
      remainingButton.classList.toggle("secondary", !directExportButton.hidden);
      remainingButton.classList.toggle("checked-export", !directExportButton.hidden);
    }
    directExportButton.disabled = !hasProject || !image2AnchorsConfirmed() || step4Busy || Boolean(state.qaActionBusy);
    directExportButton.textContent = state.task?.kind === "direct-export" && state.task?.export?.path
      ? "再次直接导出"
      : state.task?.kind === "direct-export" && ["queued", "running"].includes(state.task.status)
        ? "直接导出中"
        : "直接导出（跳过检查）";
  }
  renderSplitConfigurationSummary();
  renderStepActionDock();
}

function image2Anchors() {
  return state.deck?.styleAnchors || {};
}

function image2AnchorsConfirmed() {
  const anchors = image2Anchors();
  return ["cover", "content"].every((kind) => anchors[kind]?.status === "confirmed");
}

function missingImage2AnchorKind() {
  for (const kind of ["cover", "content"]) {
    const anchor = image2Anchors()[kind];
    const page = image2AnchorPage(kind);
    if (anchor?.pageId && !pageImagePath(page) && !anchor.assetPath) return kind;
  }
  return "";
}

function canGenerateMissingImage2Anchor(kind = missingImage2AnchorKind()) {
  if (!kind || image2MutationInProgress()) return false;
  const page = image2AnchorPage(kind);
  if (page?.generationStatus === "generating") return false;
  return kind === "cover" || image2Anchors().cover?.status === "confirmed";
}

function image2AnchorPage(kind, pages = visiblePages()) {
  const anchor = image2Anchors()[kind];
  if (!anchor?.pageId) return null;
  const savedPage = (state.deck?.pages || []).find((page) => [page.id, page.pageNo].includes(anchor.pageId));
  return pages.find((page) => [page.id, page.pageNo].includes(anchor.pageId) || sameImage2Page(page, savedPage)) || null;
}

function anchorStatusLabel(anchor = {}, page = {}) {
  if (anchor.status === "confirmed") return "已确认";
  if (page.generationStatus === "cancelled") return pageImagePath(page) ? "图片已保留，已停止" : "已停止";
  if (image2WorkStageLabel(page)) return image2WorkStageLabel(page);
  if (page.generationStatus === "preparing") return "准备中";
  if (page.generationStatus === "generating") return "生成中";
  if (page.generationStatus === "stale") return "待重新生成";
  if (page.generationStatus === "failed") {
    return image2FailurePresentation(page).label;
  }
  if (pageImagePath(page)) return "待确认";
  return "等待生成";
}

function sameImage2Page(left, right) {
  if (!left || !right) return false;
  return [left.id, left.pageNo].filter(Boolean).some((value) => [right.id, right.pageNo].includes(value));
}

function image2PageStatus(page = {}) {
  if (page.generationStatus === "cancelled") return pageImagePath(page) ? "图片已保留，已停止" : "已停止";
  if (image2WorkStageLabel(page)) return image2WorkStageLabel(page);
  if (page.generationStatus === "preparing") return "准备中";
  if (page.generationStatus === "generating") return "生成中";
  if (page.generationStatus === "failed") {
    return image2FailurePresentation(page).label;
  }
  if (page.generationStatus === "stale") return "待重新生成";
  if (pageImagePath(page)) return "已生成";
  return "等待生成";
}

function step4TaskInProgress(task = state.task) {
  return state.activeStep === 4
    && ["queued", "running"].includes(task?.status)
    && ["image2-compile", "generation", "qa-export", "direct-export"].includes(task?.kind);
}

function image2MutationInProgress() {
  if (state.anchorBusy || ["generation", "image2-compile", "qa-export", "direct-export"].includes(state.taskStartBusy)) return true;
  const seen = new Set();
  return [state.task, ...(state.tasks || [])].some((task) => {
    if (!task || (task.projectSlug && task.projectSlug !== state.selectedProject?.slug)) return false;
    if (task.taskId && seen.has(task.taskId)) return false;
    if (task.taskId) seen.add(task.taskId);
    return ["generation", "image2-compile", "qa-export", "direct-export"].includes(task.kind)
      && ["queued", "running", "cancelling"].includes(task.status);
  });
}

function image2WorkStageLabel(page = {}) {
  if (page.generationStatus !== "generating") return "";
  return ({ "qa-queued": "图片已生成，等待校验", auditing: "图片已生成，正在校验", binding: "校验通过，正在保存", "awaiting-review": "等待人工确认", "generation-queued": "等待修正生图" })[page.workStage] || "";
}

function image2CardLiveTaskState(task = null, page = {}, pages = []) {
  if (!["image2-compile", "generation"].includes(task?.kind) || !["queued", "running"].includes(task?.status)) return "";
  const pageNo = String(page.pageNo || page.id || "");
  const batchScope = Array.isArray(task.generationPageNos) ? new Set(task.generationPageNos.map(String).filter(Boolean)) : null;
  if (batchScope && !batchScope.has(pageNo)) return "";
  const concurrency = Math.max(1, Number(task.concurrency) || 1);
  const activePageNos = (task.activePageNos || []).map(String).filter(Boolean).slice(0, concurrency);
  const taskPage = (task.pages || []).find((item) => String(item.pageNo || item.id || "") === pageNo);
  if (["generated", "imported", "failed", "completed", "dispatched", "stale", "cancelled"].includes(taskPage?.generationStatus)) return "";
  if (image2WorkStageLabel(taskPage || page)) return "auditing";
  if (taskPage?.generationStatus === "preparing") return "preparing";
  if (activePageNos.includes(pageNo)) return "generating";
  if (taskPage?.generationStatus === "generating") return "generating";
  if (["queued", "pending", "writing"].includes(taskPage?.generationStatus)) return "queued";
  if (["generated", "failed", "completed"].includes(taskPage?.generationStatus) || pageImagePath(taskPage)) return "";
  const scopedPageNos = batchScope || new Set([
    ...(task.anchorPageIds || []),
    ...(task.input?.pageIds || [])
  ].map(String).filter(Boolean));
  if (activePageNos.length) return scopedPageNos.has(pageNo) ? "queued" : "";
  const total = Math.max(0, Number(task.total || 0));
  const completed = Math.max(0, Number(task.completed || 0));
  if ((total > 0 && completed >= total) || ["anchor-ready", "generated", "generated-with-errors"].includes(task.phase)) return "";
  const candidates = [task.currentPage, ...(batchScope || task.anchorPageIds || [])].map(String).filter((pageNo) => pageNo && (!batchScope || batchScope.has(pageNo)));
  // Explicit progress is authoritative. A missing worker does not turn a
  // completed, invalidated or auditing page back into a preparation target.
  const unreported = candidates.filter((candidate) => !(task.pages || []).some((item) => String(item.pageNo || item.id || "") === candidate && (item.generationStatus || item.workStage)));
  const target = unreported.find((candidate) => pages.some((item) => [item.pageNo, item.id].map(String).includes(candidate)))
    || (!candidates.length && !(task.pages || []).length ? String(pages[0]?.pageNo || pages[0]?.id || "") : "");
  if (pageNo && pageNo === target) return "preparing";
  return scopedPageNos.has(pageNo) ? "queued" : "";
}

function image2FailurePresentation(page = {}) {
  const gate = page.qualityGate || page.qa?.qualityGate || {};
  const detail = String(page.error || page.generationError || gate.message || "").trim();
  const code = String(page.errorCode || gate.errorCode || gate.code || "");
  const hasImage = Boolean(pageImagePath(page));
  const qualityCheck = page.failureStage === "quality-check" || gate.kind === "image2-visual-master";
  const retained = hasImage ? "已有图片已保留，可查看大图或仅重新生成此页。" : "当前文档与页数设置已保留，可仅重新生成此页。";
  if (page.failureStage === "image-handoff" || /IMAGE_HANDOFF|生图结果未回传|等待人工确认：.*(?:PNG|图片|目录)/.test(`${code} ${detail}`)) {
    return {
      category: "image-handoff",
      label: hasImage ? "图片已保留，等待人工确认" : "图片未回传，等待人工确认",
      summary: hasImage ? "已找回本次任务的原图，尚未通过校验。请查看大图确认；未重新生图。" : "执行端未交回可读取的图片，任务记录已保留；未自动重新生图。",
      detail
    };
  }
  if (gate.status === "review-required" || gate.audit?.reviewRequired === true
      || /REVIEW_REQUIRED|证据不足|待复查/.test(`${code} ${detail}`)) {
    return {
      category: "review-required",
      label: hasImage ? "图片已保留，等待人工确认" : "等待人工确认",
      summary: "视觉校验证据不足，尚未判定通过或不通过；已有图片已保留，未自动重绘。请人工查看后决定是否重新生成。",
      detail
    };
  }
  // A failed repair or unavailable reviewer is not a second visual rejection.
  // Older jobs only expose a wrapped error string, so inspect the cause first.
  if (!qualityCheck && /^(?:Codex\s+)?(?:(?:生图|生成)失败[：:]\s*)?(?:Codex\s+)?(?:退出码\s*\d+|(?:生图\s+)?exited with code\s*\d+)\s*$/i.test(detail)) {
    return {
      category: "unknown-error",
      label: "生成失败",
      summary: "Codex 执行异常结束，旧任务记录未保存具体原因，无法仅凭退出码判断。请查看当时的本地连接器日志。",
      detail
    };
  }
  // Put the actual provider/connector cause directly on the card; a retained
  // preview alone does not mean that this attempt reached visual QA.
  if (!qualityCheck && /^Codex\s/.test(detail)) {
    return { category: "generation-error", label: "生成失败", summary: detail, detail: "" };
  }
  if (/超时|timed?\s*out|timeout/i.test(`${code} ${detail}`)) {
    const redraw = qualityCheck && /生图|重绘|修正|RETRY_ERROR/i.test(`${code} ${detail}`);
    return {
      category: "timeout",
      label: hasImage ? (redraw ? "图片已保留，修正超时" : "图片已保留，校验超时") : "生成超时",
      summary: `${redraw ? "自动修正生图超时，尚未完成修正后的校验。" : qualityCheck ? "视觉校验超时，暂未得到有效结果。" : "AI 生图超时。"}${retained}`,
      detail
    };
  }
  const serviceError = gate.status === "error"
    || /AUDIT_ERROR|RETRY_ERROR|校验器不可用|校验服务|审查服务|未返回(?:有效|校验|审查)|无效.*(?:结果|响应)|Invalid audit|invalid.*(?:json|response)|解析.*失败|网络(?:异常|错误|失败)|连接(?:失败|断开|拒绝)|限流|配额(?:不足|耗尽)|rate.?limit|quota.*(?:exceed|limit)|ECONN|ENOTFOUND|fetch failed|provider.*(?:returned|error|failed|unavailable)|服务.*(?:失败|异常|不可用)|\b(?:429|502|503|504)\b/i.test(`${code} ${detail}`);
  if (serviceError) {
    return {
      category: "service-error",
      label: hasImage ? "图片已保留，校验未完成" : "生成服务异常",
      summary: `${qualityCheck ? "修正或校验服务未完成，暂不能确认本页是否符合母版。" : "图片生成服务未完成。"}${retained}`,
      detail
    };
  }
  if (qualityCheck) {
    const failedAudit = gate.status === "failed" || gate.audit?.passed === false
      || /AUDIT_FAILED|强制校验连续\s*\d+\s*次未通过|一致性校验.*未通过/.test(`${code} ${detail}`);
    if (failedAudit) {
      const repeated = /强制校验连续\s*([2-9]|\d{2,})\s*次未通过|自动修正后仍未通过/.test(detail)
        || (gate.status === "failed" && Number(gate.attempt || 0) > 1);
      return {
        category: "visual-mismatch",
        label: "校验未通过，等待人工确认",
        summary: `${repeated ? "页面自动修正后仍未通过正文视觉母版一致性校验。" : "页面未通过正文视觉母版一致性校验。"}已有图片已保留，等待人工查看原因；只有主动点击重新生成，才会再次出图。`,
        detail
      };
    }
    return {
      category: "audit-incomplete",
      label: hasImage ? "图片已保留，校验未完成" : "校验未完成",
      summary: `本页尚无有效的最终视觉校验结果。${retained}`,
      detail
    };
  }
  return {
    category: "generation-error",
    label: "生成失败",
    summary: detail || `图片生成未完成。${retained}`,
    detail: ""
  };
}

function generationOutputCount(task = {}) {
  // Count only this task's published images, never saved deck previews from an
  // earlier run. Candidates already exist even while their audits or repairs run.
  const scope = new Set(task.generationPageNos || []);
  const images = new Set((task.pages || []).filter((page) => page.imagePath && (!scope.size || scope.has(page.pageNo)))
    .map((page) => page.pageNo || page.id).filter(Boolean));
  return Math.min(Number(task.total) || Infinity, Math.max(images.size, Number(task.completed) || 0, Number(task.generatedCount) || 0));
}

function taskProgressTitle(task = {}) {
  if (task.phase === "cancelling") return "正在停止生成";
  if (["generation", "image2-compile"].includes(task.kind) && ["running", "queued"].includes(task.status)) {
    const activePages = (task.pages || []).filter((page) => page.generationStatus === "generating" && !image2WorkStageLabel(page));
    const activePageNos = [...new Set(activePages.map((page) => page.pageNo || page.id).filter(Boolean))];
    if (activePageNos.length) return `正在生成 ${activePageNos.join("、")}`;
    const auditPageNos = (task.pages || []).filter((page) => image2WorkStageLabel(page)).map((page) => page.pageNo || page.id).filter(Boolean);
    if (auditPageNos.length) return `图片已生成，正在校验 ${auditPageNos.join("、")}`;
    if ((task.pages || []).some((page) => page.generationStatus === "stale")) return "部分页面已变更，等待重新生成";
  }
  if (["generation", "image2-compile"].includes(task.kind) && ["running", "queued"].includes(task.status)
    && Number(task.total) > 0 && generationOutputCount(task) >= Number(task.total)) return "图片已出齐，正在校验";
  if (["generation", "image2-compile"].includes(task.kind) && ["running", "queued"].includes(task.status) && task.qaPageNos?.length && !task.activePageNos?.length) return "AI 正在校验已生成页面";
  if (task.kind === "image2-compile") {
    if (task.status === "completed" || task.phase === "anchor-ready") return "视觉锚点已生成，等待确认";
    if (["anchors-pending", "anchors", "anchor-generating"].includes(task.phase)) return "AI 正在生成封面与正文视觉锚点";
    if (["remaining", "generating"].includes(task.phase)) return "AI 正在生成剩余页面";
    if (task.phase === "reference-parsing") return "正在解析参考页面";
    if (task.phase === "reference-analyzing") return "正在分析参考风格与排版";
    if (task.phase === "starting") return "正在创建视觉锚点任务";
    return "AI 正在规划整套页面视觉";
  }
  const regenerationPageNo = singlePageRegenerationNo(task);
  const pageNo = singlePageTaskNo(task);
  const operation = task?.operation || task?.input?.operation || "";
  if (task.kind === "generation" && task.operation === "qa-batch-regeneration") return `AI 正在批量修复 ${task.total || task.input?.pageIds?.length || ""} 页`;
  if (task.kind === "generation" && regenerationPageNo) return `AI 正在重新生成 ${regenerationPageNo}`;
  if (task.kind === "generation" && operation === "missing-anchor-generation" && pageNo) return task.phase === "starting" ? `正在提交 ${pageNo} 生成任务` : `AI 正在生成 ${pageNo} 锚点`;
  if (task.kind === "generation") return "AI 正在生成页面图片";
  if (task.kind === "qa-export" && task.input?.qaScope === "selected") return `AI 正在检查新生成的 ${task.total || task.input?.pageIds?.length || ""} 页`;
  if (task.kind === "qa-export") return "AI 正在检查整套 PPT";
  if (task.kind === "direct-export") return "正在直接导出 PPTX";
  return "AI 正在处理任务";
}

function taskProgressDetail(task = {}) {
  if (task.phase === "starting" && task.operation === "missing-anchor-generation") return "正在等待服务器确认任务，确认后自动显示生成进度。";
  const regenerationPageNo = singlePageRegenerationNo(task);
  if (task.kind === "generation" && regenerationPageNo) {
    const metrics = [
      `正在按提示词优化 ${regenerationPageNo}`,
      task.averageDurationMs ? `单页平均 ${compactDuration(task.averageDurationMs)}` : "",
      task.estimatedRemainingMs ? `预计剩余 ${compactDuration(task.estimatedRemainingMs)}` : ""
    ].filter(Boolean);
    return metrics.join(" · ");
  }
  if (task.kind === "qa-export" && task.input?.qaScope === "selected") {
    return `只复检 ${task.input.pageIds.join("、")}，已检查过的页面不重复执行。`;
  }
  if (task.kind === "direct-export") return `正在打包当前页面版本 · 已跳过全部质量检查。`;
  const phaseText = ["generation", "image2-compile"].includes(task.kind) && ["running", "queued"].includes(task.status)
    && Number(task.total) > 0 && generationOutputCount(task) >= Number(task.total)
    ? "正在校验" : taskPhaseLabel(task, task.completed || 0, task.total || 0);
  if (!["generation", "image2-compile"].includes(task.kind)) return phaseText;
  if (task.kind === "image2-compile" && !["anchors-pending", "anchors", "anchor-generating", "remaining", "generating"].includes(task.phase)) return phaseText;
  const phaseStartedAt = Date.parse(task.phaseStartedAt || "");
  const metrics = [
    generationOutputCount(task) > Number(task.completed || 0)
      ? `已出图 ${generationOutputCount(task)}/${task.total || "-"} 页 · ${Number(task.completed) || 0} 页处理完成${task.failed ? ` · ${task.failed} 页待处理` : ""}`
      : "",
    task.planningDurationMs ? `视觉规划 ${compactDuration(task.planningDurationMs)}` : "",
    Number.isFinite(phaseStartedAt) && ["running", "queued"].includes(task.status)
      ? `出图已用时 ${compactDuration(Math.max(0, Date.now() - phaseStartedAt)) || "0 秒"}` : "",
    Array.isArray(task.qaPageNos) ? `${task.activePageNos?.length || 0} 页生图 · ${task.qaPageNos.length} 页校验或等待校验` : Number(task.concurrency || 1) > 1 ? `${task.concurrency} 页并行` : "按页生成",
    task.averageDurationMs ? `单页平均 ${compactDuration(task.averageDurationMs)}` : "",
    task.estimatedRemainingMs ? `预计剩余 ${compactDuration(task.estimatedRemainingMs)}` : ""
  ].filter(Boolean).join(" · ");
  return metrics ? `${phaseText} · ${metrics}` : phaseText;
}

function renderImage2Progress(completedValue = 0, totalValue = 0) {
  const total = Math.max(0, Number(totalValue) || 0);
  const completed = Math.max(0, Math.min(total || Number(completedValue) || 0, Number(completedValue) || 0));
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  $("image2AnchorCompleted").textContent = `${completed} / ${total || "-"}`;
  $("image2AnchorProgressPercent").textContent = `${percent}%`;
  $("image2AnchorProgressFill").style.width = `${percent}%`;
  $("image2AnchorProgressBar").setAttribute("aria-valuenow", String(percent));
  $("image2AnchorProgressBar").setAttribute("aria-valuetext", `${percent}% · ${completed} / ${total || "-"}`);
  return percent;
}

function renderImage2TaskProgressDock(task = state.task) {
  if (!step4TaskInProgress(task)) return false;
  const fallbackTotal = task.kind === "image2-compile"
    ? 2
    : task.kind === "qa-export" && task.input?.qaScope === "selected"
      ? task.input.pageIds?.length || 0
      : visiblePages().length;
  const total = Number(task.total) || fallbackTotal || 0;
  const isGeneration = ["generation", "image2-compile"].includes(task.kind);
  const completed = Math.min(total || Number(task.completed) || 0, isGeneration ? generationOutputCount(task) : Number(task.completed) || 0);
  const elapsed = taskProgressToastStartedAt
    ? Math.max(0, Math.floor((Date.now() - taskProgressToastStartedAt) / 1000))
    : 0;
  renderImage2Progress(completed, total);
  $("image2AnchorCompletedLabel").textContent = `${isGeneration ? "出图进度" : taskLabel(task)} · 已用时 ${compactDuration(elapsed * 1000) || "0 秒"}`;
  $("image2AnchorActionTitle").textContent = taskProgressTitle(task);
  $("image2AnchorHint").textContent = taskProgressDetail(task);
  const regenerationPageNo = singlePageRegenerationNo(task);
  $("generateRemainingPages").textContent = regenerationPageNo ? `${regenerationPageNo} 生成中` : "任务进行中";
  return true;
}

function renderDirectExportResultDock(task = state.task) {
  if (state.activeStep !== 4 || task?.kind !== "direct-export" || ["queued", "running"].includes(task.status)) return false;
  const total = Number(task.total) || state.deck?.pages?.length || 0;
  renderImage2Progress(task.export?.path ? total : 0, total);
  if (task.export?.path) {
    $("image2AnchorCompletedLabel").textContent = `直接导出 · ${total} 页已打包`;
    $("image2AnchorActionTitle").textContent = "已跳过检查并导出 PPTX";
    const fallbackCount = task.export.usedFallbackPageNos?.length || task.input?.usedFallbackPageNos?.length || 0;
    $("image2AnchorHint").textContent = fallbackCount
      ? `${fallbackCount} 页修复失败，已沿用修复前的可见版本；文件可直接下载。`
      : "未执行质量检查，已按当前页面版本完成打包。";
    $("generateRemainingPages").textContent = "下载 PPTX";
    return true;
  }
  $("image2AnchorCompletedLabel").textContent = "直接导出 · 未完成";
  $("image2AnchorActionTitle").textContent = "直接导出失败";
  $("image2AnchorHint").textContent = task.error || "当前页面无法完成打包，请检查是否仍有页面缺少成图。";
  $("generateRemainingPages").textContent = "检查并导出";
  return true;
}

function renderImage2QaResultDock(task = qaTaskForReview()) {
  if (state.activeStep !== 4 || task?.kind !== "qa-export" || ["queued", "running"].includes(task.status)) return false;
  if (task.status === "failed") {
    $("image2AnchorActionTitle").textContent = task.qa ? "导出未完成" : "检查未完成";
    $("image2AnchorHint").textContent = task.error || "检查或导出未完成，页面图片已保留，请重试。";
    $("image2AnchorCompletedLabel").textContent = "检查导出 · 未完成";
    $("generateRemainingPages").textContent = task.qa ? "重试导出 PPTX" : "重试检查并导出";
    return true;
  }
  if (!task.qa) return false;
  const review = qaDecisionState(task.qa);
  const total = Number(task.qa.total) || state.deck?.pages?.length || 0;
  renderImage2Progress(total, total);
  $("image2AnchorCompletedLabel").textContent = "页面一致性检查已完成";
  if (task.export?.path) {
    $("image2AnchorActionTitle").textContent = "检查完成，PPTX 已导出";
    $("image2AnchorHint").textContent = "检查结果和导出文件均已保留，可直接下载。";
    $("generateRemainingPages").textContent = "下载 PPTX";
    return true;
  }
  if (review.unresolved.length) {
    $("image2AnchorActionTitle").textContent = `发现 ${review.groups.length} 个问题页`;
    $("image2AnchorHint").textContent = `还有 ${review.unresolved.length} 页待选择“修复”或“不修复”。`;
    $("generateRemainingPages").textContent = `${review.unresolved.length} 页待确认`;
    return true;
  }
  if (review.fixGroups.length) {
    $("image2AnchorActionTitle").textContent = `已选择 ${review.fixGroups.length} 页待修复`;
    $("image2AnchorHint").textContent = "所有问题页都已完成选择；确认后只重新生成已选择修复的页面。";
    $("generateRemainingPages").textContent = `开始修复 ${review.fixGroups.length} 页`;
    return true;
  }
  $("image2AnchorActionTitle").textContent = review.groups.length ? "问题页已全部确认" : "页面一致性检查通过";
  $("image2AnchorHint").textContent = review.groups.length ? "已选择不修复的页面将按当前版本导出。" : "未发现阻断问题，可以导出 PPTX。";
  $("generateRemainingPages").textContent = "导出 PPTX";
  return true;
}

function renderQaBatchRegenerationResultDock(task = state.task) {
  if (state.activeStep !== 4 || task?.kind !== "generation" || task?.operation !== "qa-batch-regeneration") return false;
  const total = Number(task.total) || Number(task.input?.pageIds?.length) || 0;
  if (["paused", "failed", "cancelled"].includes(task.status)) {
    const completed = Number(task.completed) || 0;
    renderImage2Progress(completed, total);
    $("image2AnchorCompletedLabel").textContent = `批量修复 · ${completed} / ${total} 页完成`;
    $("image2AnchorActionTitle").textContent = task.status === "failed" ? "所选页面修复失败" : "所选页面修复已中断";
    $("image2AnchorHint").textContent = task.error || task.recovery?.message || "原修复任务已停止，修复前图片已保留。";
    $("generateRemainingPages").textContent = `重新发起 ${total - completed} 页修复`;
    return true;
  }
  if (task.status !== "completed") return false;
  renderImage2Progress(total, total);
  $("image2AnchorCompletedLabel").textContent = `批量修复 · ${total} 页已完成`;
  $("image2AnchorActionTitle").textContent = "已完成所选页面修复";
  $("image2AnchorHint").textContent = `只需复检本次新生成的 ${total} 页，已检查过的页面不会重复执行。`;
  $("generateRemainingPages").textContent = `检查新生成的 ${total} 页`;
  return true;
}

function renderSinglePageRegenerationResultDock(task = state.task) {
  const regenerationPageNo = singlePageRegenerationNo(task);
  if (state.activeStep !== 4 || task?.kind !== "generation" || task?.status !== "completed" || !regenerationPageNo) return false;
  renderImage2Progress(1, 1);
  $("image2AnchorCompletedLabel").textContent = "单页重新生成 · 已完成";
  $("image2AnchorActionTitle").textContent = `${regenerationPageNo} 已重新生成`;
  $("image2AnchorHint").textContent = `只需检查本次新生成的 ${regenerationPageNo}，已检查过的页面不会重复执行。`;
  $("generateRemainingPages").textContent = "检查新生成的 1 页";
  return true;
}

function renderReferenceGenerationProgress(task) {
  const panel = $("referenceGenerationProgress");
  const id = task?.input?.referenceBundleId;
  panel.hidden = !id;
  if (!id) return;
  const phases = ["reference-parsing", "reference-analyzing", "visual-compiling", "anchor-generating"];
  const index = task.status === "completed" ? 4 : ["anchors", "anchors-pending"].includes(task.phase) ? 3 : Math.max(0, phases.indexOf(task.phase));
  const list = $("referenceGenerationStages"); list.replaceChildren();
  ["解析参考", "分析风格与排版", "规划样张", "生成封面与正文样张", "确认样张"].forEach((label, step) => {
    const item = document.createElement("li"); item.textContent = label; item.dataset.state = step < index ? "done" : step === index ? "current" : "pending"; list.append(item);
  });
  $("referenceGenerationStatus").textContent = task.status === "running" && task.phase === "reference-analyzing" ? task.phaseMessage || "正在分析参考的配色、字体和排版" : "";
  $("referenceGenerationError").textContent = task.status === "failed" ? task.error || task.message || "参考处理失败，文件已保留，可重试。" : "";
  $("retryReferenceGeneration").hidden = task.status !== "failed";
}

function image2GenerationFailure(task = taskForActiveStep()) {
  if (["queued", "running", "cancelling"].includes(task?.status)) return null;
  const failedTask = ["generation", "image2-compile"].includes(task?.kind) && task.status === "failed";
  const error = state.generationStartError || (failedTask ? task.error || task.message || "生成任务失败，请重试。" : "");
  if (!error) return null;
  const compileFailed = failedTask && task.kind === "image2-compile"
    && !["anchors", "anchor-generating", "anchors-pending", "generating", "remaining"].includes(task.phase);
  return { error, compileFailed, contentNeedsAdjustment: compileFailed && /超过.*(?:容量|项)|请调整拆页|精简文案/.test(error) };
}

function renderImage2GenerationFailure(task) {
  const panel = $("image2AnchorPanel");
  let notice = $("image2GenerationFailure");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "image2GenerationFailure";
    notice.className = "image2-failure-note";
    notice.setAttribute("role", "alert");
    panel.insertBefore(notice, $("image2AnchorCards"));
  }
  const failure = image2GenerationFailure(task);
  notice.hidden = !failure;
  notice.innerHTML = failure ? `<strong>${failure.compileFailed ? "视觉规划失败，尚未开始生图" : "生成任务未完成"}</strong><p>${escapeHtml(failure.error)}</p>` : "";
}

function renderImage2GenerationFailureDock(task) {
  const failure = image2GenerationFailure(task);
  if (!failure?.compileFailed) return false;
  $("image2AnchorActionTitle").textContent = "视觉规划失败，尚未开始生图";
  $("image2AnchorHint").textContent = failure.contentNeedsAdjustment
    ? "请返回确认内容，调整超出容量的页面后再生成；原文和当前文案均已保留。"
    : "失败原因已显示在上方，可重新发起视觉规划。";
  $("generateRemainingPages").textContent = failure.contentNeedsAdjustment ? "返回调整文案" : "重试视觉规划";
  return true;
}

function renderImage2Anchors() {
  const panel = $("image2AnchorPanel");
  if (!panel || panel.hidden) return;
  const task = taskForActiveStep();
  renderImage2GenerationFailure(task);
  renderReferenceGenerationProgress(task);
  $("image2AnchorCards").hidden = Boolean(task?.input?.referenceBundleId && ["queued", "reference-parsing", "reference-analyzing", "visual-compiling"].includes(task.phase));
  $("image2AnchorActionDock").setAttribute("aria-busy", String(step4TaskInProgress(task)));
  const anchors = image2Anchors();
  const pages = visiblePages(task);
  const coverPage = image2AnchorPage("cover", pages) || pages.find((page) => page.pageNo === "P01");
  const contentPage = image2AnchorPage("content", pages) || pages.find((page) => !sameImage2Page(page, coverPage));
  const repairStateOptions = { excludedPageNos: [coverPage?.pageNo, contentPage?.pageNo].filter(Boolean) };
  const repairCounts = batchRepairCounts(task, pages, repairStateOptions);
  const activePage = pages.find((page) => ["preparing", "generating"].includes(page.generationStatus));
  if (activePage) state.selectedPageNo = activePage.pageNo;
  const completed = pages.filter((page) => Boolean(pageImagePath(page))).length;
  const coverConfirmed = anchors.cover?.status === "confirmed";
  const contentConfirmed = anchors.content?.status === "confirmed";
  const confirmedCount = Number(coverConfirmed) + Number(contentConfirmed);
  const remainingCount = Math.max(pages.length - completed, 0);
  const completionRate = renderImage2Progress(completed, pages.length);
  $("image2AnchorProgress").textContent = `${confirmedCount} / 2 锚点已确认`;
  $("image2AnchorCompletedLabel").textContent = `已出图 ${completed} 页 · ${completionRate}%`;

  const anchorPages = [coverPage, contentPage].filter((page, index, list) => page
    && list.findIndex((candidate) => sameImage2Page(candidate, page)) === index);
  const pendingPages = pages.filter((page) => !anchorPages.some((anchorPage) => sameImage2Page(page, anchorPage)));
  const generatedPageCount = pendingPages.filter((page) => Boolean(pageImagePath(page))).length;
  const auditFailedPageCount = pendingPages.filter((page) => page.failureStage === "quality-check" && Boolean(pageImagePath(page))).length;
  const passedPageCount = Math.max(0, generatedPageCount - auditFailedPageCount);
  const pendingPageCount = Math.max(pendingPages.length - generatedPageCount, 0);
  const generationPaused = task?.status === "paused";
  const generationRunning = ["generation", "image2-compile"].includes(task?.kind) && ["running", "queued"].includes(task?.status);
  const generationFailure = image2GenerationFailure(task);
  const pageGroupTitle = generationFailure ? "页面生成未完成" : repairCounts.total
    ? "页面修复状态"
    : generationPaused ? "页面生成已暂停"
    : generationRunning ? "页面生成进度"
    : pendingPageCount === 0
    ? "已生成页面"
    : generatedPageCount > 0 ? "页面生成进度" : "待生成页面";
  const pageGroupDescription = generationFailure ? "任务已停止，请查看上方失败原因后继续。" : repairCounts.total
    ? `本次修复 ${repairCounts.total} 页：${repairCounts.generating} 页修复中，${repairCounts.queued} 页排队中，${repairCounts.completed} 页已完成${repairCounts.stopped ? `，${repairCounts.stopped} 页已中断` : ""}${repairCounts.failed ? `，${repairCounts.failed} 页失败` : ""}。`
    : generationPaused
    ? `已有 ${passedPageCount} 页通过校验，${auditFailedPageCount} 页图片已保留、校验未通过或未完成，${pendingPageCount} 页尚未生成。`
    : generationRunning
    ? "图片会陆续显示，排队、生成和校验状态以各页标记为准。"
    : pendingPageCount === 0
    ? auditFailedPageCount > 0
      ? `页面图片已生成，其中 ${auditFailedPageCount} 页校验未通过或未完成，请查看对应页面。`
      : "页面图片已生成，可逐页查看大图或输入提示词重新生成。"
    : generatedPageCount > 0
      ? `本轮已结束，已保留 ${generatedPageCount} 页图片，${pendingPageCount} 页尚未出图。当前没有生成任务在运行。`
      : "当前没有生成任务在运行。确认视觉母版后，可开始生成。";
  const pageRoleLabels = {
    cover: "封面",
    directory: "目录页",
    chapter: "章节页",
    data: "数据页",
    content: "内容页",
    process: "流程页",
    conclusion: "结论页"
  };
  const renderReviewCard = (page, { isAnchor = false } = {}) => {
    const isCover = sameImage2Page(page, coverPage) || page.pageNo === "P01";
    const isContent = sameImage2Page(page, contentPage);
    const imagePath = pageImagePath(page);
    const anchorKind = isCover ? "cover" : (isContent ? "content" : "");
    const anchor = anchorKind ? (anchors[anchorKind] || {}) : {};
    const repair = batchRepairState(task, page, repairStateOptions);
    const liveTaskState = image2CardLiveTaskState(task, page, pages);
    const status = (generationFailure?.compileFailed && !imagePath ? "尚未开始生图" : "") || repair?.label || (liveTaskState === "preparing"
      ? "准备中"
      : liveTaskState === "generating" ? "生成中"
        : liveTaskState === "queued" ? "排队中"
          : (anchorKind ? anchorStatusLabel(anchor, page) : image2PageStatus(page)));
    const rawRole = page.pageRole || page.designSpec?.pageRole || "content";
    const role = isCover ? "封面锚点" : (isContent ? "正文视觉母版" : (pageRoleLabels[rawRole] || rawRole || "内容页"));
    const cardPreparing = liveTaskState === "preparing" || (!liveTaskState && page.generationStatus === "preparing");
    const active = state.selectedPageNo === page.pageNo || repair?.key === "generating" || cardPreparing || liveTaskState === "generating" || (!liveTaskState && page.generationStatus === "generating" && !image2WorkStageLabel(page));
    const regenerateTarget = anchorKind || `page:${page.pageNo || page.id || ""}`;
    const busy = state.anchorBusy === regenerateTarget;
    const mutationBusy = image2MutationInProgress();
    const confirmed = anchorKind && anchor.status === "confirmed";
    const cardGenerating = (repair?.key === "generating" && !image2WorkStageLabel(page)) || liveTaskState === "generating" || (!liveTaskState && page.generationStatus === "generating" && !image2WorkStageLabel(page));
    const cardBusy = cardPreparing || cardGenerating || Boolean(image2WorkStageLabel(page));
    const pageNo = page.pageNo || page.id || "当前页";
    const busyLabel = cardPreparing
      ? `正在准备 ${pageNo}`
      : repair ? `正在修复 ${pageNo}` : `正在生成 ${pageNo}`;
    const failed = page.generationStatus === "failed" || status.includes("失败");
    const failure = failed ? image2FailurePresentation(page) : null;
    const statusKey = repair?.key || (confirmed ? "confirmed" : cardPreparing ? "preparing" : cardGenerating ? "generating" : liveTaskState === "queued" ? "queued" : failed ? "failed" : image2WorkStageLabel(page) ? "auditing" : imagePath ? "generated" : "pending");
    return `<article class="image2-review-card ${isAnchor ? "anchor-review" : "pending-review"} ${active ? "active" : ""} ${imagePath ? "complete" : ""} ${confirmed ? "confirmed" : ""} ${isCover ? "cover-anchor" : ""} ${isContent ? "content-anchor" : ""}" data-image2-page="${escapeHtml(page.pageNo || page.id || "")}"${repair ? ` data-repair-state="${repair.key}"` : ""}>
      <div class="image2-review-head"><div><span>${escapeHtml(page.pageNo || "-")}</span><em>${escapeHtml(role)}</em></div><strong data-status="${statusKey}">${escapeHtml(status)}</strong></div>
      <div class="image2-review-preview">
        ${imagePath
          ? `<img src="${artifactUrl(imagePath)}" alt="${escapeHtml(page.title || "页面")}预览" />`
          : `<div class="anchor-placeholder"><strong>${escapeHtml(status)}</strong></div>`}
        ${cardPreparing || cardGenerating ? `<div class="image2-card-generating ${cardPreparing ? "preparing" : ""}" role="status" aria-label="${escapeHtml(busyLabel)}"><span class="inline-spinner" aria-hidden="true"></span><strong>${escapeHtml(busyLabel)}</strong></div>` : ""}
      </div>
      ${failure ? `<div class="image2-failure-note" role="alert"><strong>失败原因</strong><p>${escapeHtml(failure.summary)}</p>${failure.detail && failure.detail !== failure.summary ? `<details><summary>查看详细原因</summary><p>${escapeHtml(failure.detail)}</p></details>` : ""}</div>` : ""}
      ${imagePath || failure ? `<div class="image2-review-actions">
        ${anchorKind && anchor.status !== "confirmed" ? `<button class="button primary compact" data-anchor-confirm="${anchorKind}" type="button" ${mutationBusy || busy || cardBusy ? "disabled" : ""}>确认${anchorKind === "cover" ? "封面" : "正文"}锚点</button>` : ""}
        <button class="button secondary compact" data-image2-regenerate="${escapeHtml(regenerateTarget)}" type="button" aria-label="输入提示词并重新生成${escapeHtml(page.pageNo || "当前页面")}" ${mutationBusy || busy || cardBusy ? "disabled" : ""}>重新生成</button>
        ${imagePath ? `<button class="button secondary compact" type="button" data-image-preview="${escapeHtml(artifactUrl(imagePath))}" data-image-preview-page="${escapeHtml(pageNo)}">查看大图</button>` : ""}
      </div>` : ""}
    </article>`;
  };
  $("image2AnchorCards").innerHTML = `<section class="image2-review-section">
      <div class="image2-review-section-heading"><h3>视觉锚点 <span>(${anchorPages.length})</span></h3><p>先确认这两页，再批量生成整套页面。</p></div>
      <div class="image2-anchor-grid">${anchorPages.map((page) => renderReviewCard(page, { isAnchor: true })).join("")}</div>
    </section>
    ${pendingPages.length ? `<section class="image2-review-section">
      <div class="image2-review-section-heading"><h3>${pageGroupTitle} <span>(${pendingPages.length})</span></h3><p>${pageGroupDescription}</p></div>
      <div class="image2-pending-grid">${pendingPages.map((page) => renderReviewCard(page)).join("")}</div>
    </section>` : ""}`;
  document.querySelectorAll("[data-image2-page]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedPageNo = card.dataset.image2Page;
      renderImage2Anchors();
    });
  });
  document.querySelectorAll(".image2-failure-note details").forEach((details) => {
    details.addEventListener("click", (event) => event.stopPropagation());
  });
  document.querySelectorAll("[data-anchor-confirm]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void confirmImage2Anchor(button.dataset.anchorConfirm);
    });
  });
  document.querySelectorAll("[data-image-preview]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openImagePreview(button.dataset.imagePreview, button.dataset.imagePreviewPage);
    });
  });
  document.querySelectorAll("[data-image2-regenerate]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openImage2RegenerateDialog(button.dataset.image2Regenerate);
    });
  });
  renderQaDecisionPanel();
  if (!renderImage2TaskProgressDock(task) && !renderImage2GenerationFailureDock(task) && !renderDirectExportResultDock(task) && !renderSinglePageRegenerationResultDock(task) && !renderQaBatchRegenerationResultDock(task) && !renderImage2QaResultDock(task)) {
    const missingAnchorKind = missingImage2AnchorKind();
    const missingAnchorPage = missingAnchorKind ? image2AnchorPage(missingAnchorKind) : null;
    const missingAnchorGenerating = missingAnchorPage?.generationStatus === "generating";
    if (auditFailedPageCount > 0) $("image2AnchorCompletedLabel").textContent = `已出图 ${completed} 页 · ${auditFailedPageCount} 页待处理`;
    $("image2AnchorActionTitle").textContent = task?.status === "cancelled" ? "生成已停止" : image2AnchorsConfirmed()
      ? (auditFailedPageCount ? `${auditFailedPageCount} 页校验未通过或未完成` : remainingCount ? "封面与正文视觉母版已确认" : "整套页面已生成")
      : missingAnchorKind
        ? (missingAnchorGenerating ? `正在生成${missingAnchorKind === "cover" ? "封面" : "正文"}锚点` : `${missingAnchorKind === "cover" ? "封面" : "正文"}锚点尚未生成`)
        : (["failed", "completed", "cancelled"].includes(task?.status) ? "生成已结束，等待确认视觉锚点" : "等待确认视觉锚点");
    $("image2AnchorHint").textContent = task?.status === "cancelled" ? "已生成图片已保留，可继续生成剩余页面。" : image2AnchorsConfirmed()
      ? (auditFailedPageCount ? "图片已保留，请查看各页原因并完成复查。" : remainingCount
        ? `后续 ${remainingCount} 页将继承当前视觉规范。`
        : "可以继续检查质量并导出 PPTX。")
      : missingAnchorKind
        ? (missingAnchorGenerating
          ? `${missingAnchorPage?.pageNo || "当前页"} 完成后即可确认，不会重新生成已完成的锚点。`
          : `只补生成 ${missingAnchorPage?.pageNo || "缺失页"}，不会重做已完成的锚点。`)
        : `当前没有生成任务在运行。请先处理${!coverConfirmed ? "封面" : ""}${!coverConfirmed && !contentConfirmed ? "与" : ""}${!contentConfirmed ? "正文" : ""}锚点，再继续。`;
    $("generateRemainingPages").textContent = image2AnchorsConfirmed()
      ? (remainingCount ? `生成剩余 ${remainingCount} 页` : "检查并导出")
      : missingAnchorKind
        ? (missingAnchorGenerating ? `${missingAnchorPage?.pageNo || "锚点"} 生成中` : `生成${missingAnchorKind === "cover" ? "封面" : "正文"}锚点`)
        : "确认锚点后生成剩余页面";
  }
  updateActions();
}

async function confirmImage2Anchor(kind) {
  if (!state.selectedProject || !kind || image2MutationInProgress()) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.anchorBusy = kind;
  renderImage2Anchors();
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/image2/anchors/${encodeURIComponent(kind)}/confirm`, { method: "POST" });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck || result;
    await loadDeck(context.projectSlug);
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(`${kind === "cover" ? "封面" : "正文"}锚点已确认`, "success");
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.anchorBusy = "";
      configurePageWorkspace(4);
    }
  }
}

async function generateMissingImage2Anchor(kind) {
  if (!state.selectedProject || !kind || image2MutationInProgress()) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.anchorBusy = `generate:${kind}`;
  state.generationStartError = "";
  renderImage2Anchors();
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/image2/anchors/${encodeURIComponent(kind)}/generate-missing`, { method: "POST" });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck || state.deck;
    state.task = result.task;
    state.anchorBusy = "";
    renderTask();
    subscribe(context.projectSlug, result.task.taskId);
    await loadTaskHistory(context.projectSlug, { hydrateLatest: false });
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(`正在只补生成 ${result.pageNo || (kind === "cover" ? "封面" : "正文视觉母版")}，已完成页面不会重做`, "success");
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    state.generationStartError = error.message;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.anchorBusy = "";
      renderImage2Anchors();
    }
  }
}

function openImagePreview(source, pageNo = "") {
  let dialog = document.getElementById("pageImagePreview");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "pageImagePreview";
    dialog.setAttribute("aria-labelledby", "pageImagePreviewTitle");
    dialog.innerHTML = `<style>
      #pageImagePreview { width:calc(100vw - 32px); max-width:1600px; height:calc(100dvh - 32px); max-height:calc(100dvh - 32px); padding:0; border:1px solid #d8e0ed; border-radius:14px; overflow:hidden; background:#f4f6fa; color:#182235; }
      #pageImagePreview::backdrop { background:rgb(15 23 42 / 65%); }
      #pageImagePreview .image-preview-header { display:flex; align-items:center; gap:12px; padding:12px 16px; background:#fff; border-bottom:1px solid #d8e0ed; }
      #pageImagePreview h2 { margin:0; flex:1; font-size:18px; }
      #pageImagePreview .image-preview-stage { position:relative; height:calc(100% - 66px); overflow:auto; padding:12px; box-sizing:border-box; text-align:center; }
      #pageImagePreview img { display:block; width:100%; height:100%; object-fit:contain; cursor:zoom-in; }
      #pageImagePreview img[data-actual="true"] { width:auto; height:auto; max-width:none; max-height:none; margin:auto; cursor:zoom-out; }
      #pageImagePreview [role="status"] { margin:8px; }
      #pageImagePreview [hidden] { display:none; }
    </style>
    <header class="image-preview-header"><h2 id="pageImagePreviewTitle">查看大图</h2><button type="button" class="button secondary compact" data-image-size disabled>原尺寸</button><button type="button" class="button secondary compact" data-image-close aria-label="关闭大图">关闭</button></header>
    <div class="image-preview-stage"><p role="status">正在加载图片…</p><img alt="页面大图" hidden /></div>`;
    document.body.append(dialog);
    const img = dialog.querySelector("img");
    const status = dialog.querySelector('[role="status"]');
    const size = dialog.querySelector("[data-image-size]");
    const toggle = () => {
      if (!img.naturalWidth || img.hidden) return;
      const actual = img.dataset.actual !== "true";
      img.dataset.actual = String(actual);
      size.textContent = actual ? "适应窗口" : "原尺寸";
    };
    size.addEventListener("click", toggle);
    img.addEventListener("click", toggle);
    img.addEventListener("load", () => { img.hidden = false; status.hidden = true; size.disabled = false; });
    img.addEventListener("error", () => { img.hidden = true; status.hidden = false; status.textContent = "图片暂时无法加载，请关闭后重试。"; size.disabled = true; });
    dialog.querySelector("[data-image-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => { img.removeAttribute("src"); });
  }
  const img = dialog.querySelector("img");
  const status = dialog.querySelector('[role="status"]');
  dialog.querySelector("h2").textContent = pageNo ? `${pageNo} · 查看大图` : "查看大图";
  dialog.querySelector("[data-image-size]").textContent = "原尺寸";
  dialog.querySelector("[data-image-size]").disabled = true;
  img.hidden = true; img.dataset.actual = "false"; img.alt = `${pageNo || "页面"}大图`;
  status.hidden = false; status.textContent = "正在加载图片…";
  if (!dialog.open) dialog.showModal();
  img.src = source;
}

function openImage2RegenerateDialog(target, initialFeedback = "") {
  target = String(target || "");
  const isAnchor = ["cover", "content"].includes(target);
  const isQaSelection = target.startsWith("qa-page:");
  if (!isQaSelection && image2MutationInProgress()) return;
  const pageNo = isQaSelection ? target.slice(8) : target.startsWith("page:") ? target.slice(5) : "";
  if (!isAnchor && !pageNo) return;
  const dialog = $("anchorRegenerateDialog");
  if (!dialog) return;
  $("anchorRegenerateKind").value = target;
  $("anchorRegenerateTitle").textContent = isAnchor
    ? (target === "cover" ? "重新生成封面锚点" : "重新生成正文视觉母版")
    : isQaSelection ? `选择修复 ${pageNo}` : `重新生成 ${pageNo}`;
  const feedback = String(initialFeedback || "").slice(0, 500);
  $("anchorRegenerateFeedback").value = feedback;
  $("anchorRegenerateFeedback").setAttribute("aria-invalid", "false");
  $("anchorRegenerateError").hidden = true;
  $("anchorRegenerateCount").textContent = `${feedback.length} / 500`;
  $("anchorRegenerateSubmit").textContent = isQaSelection ? "保存修复选择" : "按提示词重新生成";
  $("anchorRegenerateSubmit").disabled = feedback.trim().length < 2;
  dialog.showModal();
  window.setTimeout(() => $("anchorRegenerateFeedback").focus(), 0);
}

async function ignoreQaIssueGroup(key) {
  const qaTask = qaTaskForReview();
  if (!state.selectedProject || !qaTask?.taskId || state.qaActionBusy) return;
  const hardBlocked = (qaTask.qa?.issues || []).some((issue) => issue.hardBlock === true && (issue.pageNo || "deck") === key);
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.qaActionBusy = `ignore:${key}`;
  renderQaDecisionPanel();
  try {
    const { task } = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/tasks/${encodeURIComponent(qaTask.taskId)}/qa-decisions`, {
      method: "POST",
      body: JSON.stringify({ key, decision: "ignore" })
    });
    if (!workspaceContextIsCurrent(context)) return;
    rememberQaTask(task);
    if (state.task?.taskId === task.taskId) state.task = task;
    showNotice(key === "deck"
      ? "已确认保留当前整套页面"
      : hardBlocked
        ? `${key} 已选择跳过，将保留当前版本；仍可继续选择并批量修复其他页面`
        : `${key} 已确认不修复，可按当前页面导出`, "success");
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.qaActionBusy = "";
      renderTask();
      updateActions();
    }
  }
}

async function selectQaIssueFix(pageNo, feedback) {
  const qaTask = qaTaskForReview();
  if (!state.selectedProject || !qaTask?.taskId || !pageNo || state.qaActionBusy) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.qaActionBusy = `fix:${pageNo}`;
  renderQaDecisionPanel();
  try {
    const { task } = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/tasks/${encodeURIComponent(qaTask.taskId)}/qa-decisions`, {
      method: "POST",
      body: JSON.stringify({ key: pageNo, decision: "fix", feedback })
    });
    if (!workspaceContextIsCurrent(context)) return;
    rememberQaTask(task);
    if (state.task?.taskId === task.taskId) state.task = task;
    showNotice(`${pageNo} 已加入待修复列表，请继续选择其他问题页`, "success");
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.qaActionBusy = "";
      renderTask();
      updateActions();
    }
  }
}

async function startSelectedQaFixes() {
  const qaTask = qaTaskForReview();
  if (!state.selectedProject || !qaTask?.taskId || state.qaActionBusy) return;
  const review = qaDecisionState(qaTask.qa || {});
  if (!review.canStartFixes) {
    showNotice(`还有 ${review.unresolved.length} 个问题页未选择修复或不修复`, "warning");
    renderQaDecisionPanel();
    return;
  }
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.qaActionBusy = "generate-fixes";
  setTaskStatus(`正在创建 ${review.fixGroups.length} 页修复任务`, "running");
  updateActions();
  try {
    const retryTask = state.task?.operation === "qa-batch-regeneration"
      && ["paused", "failed", "cancelled"].includes(state.task.status) ? state.task : null;
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/tasks/${encodeURIComponent(qaTask.taskId)}/qa-fixes`, {
      method: "POST",
      body: JSON.stringify(retryTask ? { retryTaskId: retryTask.taskId } : {})
    });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck || state.deck;
    state.task = result.task;
    subscribe(context.projectSlug, result.task.taskId);
    await loadTaskHistory(context.projectSlug, { hydrateLatest: false });
    if (!workspaceContextIsCurrent(context)) return;
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.qaActionBusy = "";
      updateActions();
    }
  }
}

async function exportReviewedQaTask() {
  const qaTask = qaTaskForReview();
  if (!state.selectedProject || !qaTask?.taskId || state.qaActionBusy) return;
  const review = qaDecisionState(qaTask.qa || {});
  if (!review.canExport) {
    showNotice(`还有 ${review.unresolved.length} 个问题页未选择修复或不修复`, "warning");
    renderQaDecisionPanel();
    return;
  }
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.qaActionBusy = "export";
  setTaskStatus("正在导出 PPTX", "running");
  updateActions();
  try {
    const { task } = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/tasks/${encodeURIComponent(qaTask.taskId)}/export`, { method: "POST" });
    if (!workspaceContextIsCurrent(context)) return;
    state.task = task;
    rememberQaTask(task);
    subscribe(context.projectSlug, task.taskId);
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.qaActionBusy = "";
      updateActions();
    }
  }
}

async function startDirectExport() {
  if (!state.selectedProject || state.qaActionBusy || step4TaskInProgress()) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.qaActionBusy = "direct-export";
  setTaskStatus("正在直接导出 PPTX", "running");
  showNotice("正在按当前可见页面直接打包，已跳过全部质量检查。", "warning");
  updateActions();
  try {
    const { task } = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/export-direct`, { method: "POST" });
    if (!workspaceContextIsCurrent(context)) return;
    state.task = task;
    subscribe(context.projectSlug, task.taskId);
    await loadTaskHistory(context.projectSlug, { hydrateLatest: false });
    if (!workspaceContextIsCurrent(context)) return;
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.qaActionBusy = "";
      updateActions();
    }
  }
}

async function regenerateImage2Anchor(kind, feedback) {
  if (!state.selectedProject || !kind || image2MutationInProgress()) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.anchorBusy = kind;
  renderImage2Anchors();
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/image2/anchors/${encodeURIComponent(kind)}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck || state.deck;
    state.task = result.task;
    subscribe(context.projectSlug, result.task.taskId);
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.anchorBusy = "";
      renderImage2Anchors();
    }
  }
}

async function regenerateImage2Page(pageNo, feedback) {
  const busyTarget = `page:${pageNo}`;
  if (!state.selectedProject || !pageNo || image2MutationInProgress()) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  state.anchorBusy = busyTarget;
  renderImage2Anchors();
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/image2/pages/${encodeURIComponent(pageNo)}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ feedback })
    });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck || state.deck;
    state.task = result.task;
    subscribe(context.projectSlug, result.task.taskId);
    renderTask();
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.anchorBusy = "";
      renderImage2Anchors();
    }
  }
}

function activeStylePack() {
  const custom = customReferencePack();
  if (custom && state.pendingStyleId === custom.id) return custom;
  const pendingPack = stylePacks.find((pack) => pack.id === state.pendingStyleId);
  if (pendingPack) return pendingPack;
  if (custom && state.deck?.styleProfile?.id === custom.id) return custom;
  const savedPack = stylePacks.find((pack) => pack.id === state.deck?.styleProfile?.id);
  return savedPack || null;
}

function customReferencePack() {
  const reference = referenceUpload.get();
  if (!reference?.profileId) return null;
  return { id: reference.profileId, name: "我的参考风格", custom: true, referenceBundleId: reference.id, referenceVersion: reference.version };
}

function openReferenceDialog() {
  $("referenceDialogNotice").textContent = "";
  if (!$("referenceDialog").open) $("referenceDialog").showModal();
}

function referenceControlsBusy() {
  if (referenceUpload.isBusy() || state.taskStartBusy) return true;
  const tasks = new Map((state.tasks || []).map((task) => [task.taskId, task]));
  // The live snapshot supersedes an older running entry in task history.
  if (state.task) tasks.set(state.task.taskId, state.task);
  return [...tasks.values()].some((task) => (!task.projectSlug || task.projectSlug === state.selectedProject?.slug)
    && ["running", "queued"].includes(task.status));
}

function updateReferenceControls() {
  const busy = referenceControlsBusy();
  $("customStyleOption").querySelectorAll("button").forEach((button) => { button.disabled = busy; });
}

function renderCustomStyleOption() {
  const root = $("customStyleOption");
  const reference = referenceUpload.get();
  const busy = referenceControlsBusy();
  root.hidden = false;
  root.replaceChildren();
  const pack = customReferencePack();
  const selected = Boolean(pack && activeStylePack()?.id === pack.id);
  root.classList.toggle("selected", selected);
  const preview = document.createElement("button"); preview.type = "button";
  preview.className = reference ? "reference-card-preview" : "reference-card-placeholder";
  preview.disabled = busy;
  preview.setAttribute("aria-label", reference ? "选择我的参考风格" : "上传图片、PPT 或 PDF");
  if (!reference) {
    const plus = document.createElement("span"); plus.textContent = referenceUpload.isUploading() ? "上传中…" : "+"; plus.setAttribute("aria-hidden", "true");
    preview.append(plus);
    preview.addEventListener("click", () => referenceUpload.chooseFiles());
  } else {
    renderReferencePreview(preview, reference, resourceUrl);
    preview.addEventListener("click", () => { state.pendingStyleId = pack.id; renderStylePanel(); updateActions(); });
  }
  const heading = document.createElement("div"); heading.className = "custom-style-heading";
  const title = document.createElement("h3"); title.textContent = "我的参考风格"; heading.append(title);
  if (reference) { const status = document.createElement("span"); status.className = "selection-state"; status.textContent = selected ? "已选中" : "已上传"; heading.append(status); }
  const description = document.createElement("p"); description.textContent = reference
    ? (reference.files || []).map((file) => file.name).join("、") || reference.name
    : "点击上方区域上传图片、PPT 或 PDF，参考它的配色、字体和排版。";
  root.append(preview, heading, description);
  if (reference) {
    const actions = document.createElement("div"); actions.className = "custom-style-actions";
    for (const [label, action] of [["更换", () => referenceUpload.chooseFiles()], ["移除", () => $("referenceRemove").click()], ["参考设置（选填）", openReferenceDialog]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = label; button.disabled = busy; button.addEventListener("click", action); actions.append(button);
    }
    const hint = document.createElement("p"); hint.textContent = referenceUpload.isDirty() ? "参考设置尚未保存" : "已上传。下一步将分析参考并生成样张。";
    root.append(actions, hint);
  }
}

function styleMasterSlideUrl(pack, slideIndex) {
  return resourceUrl(`/api/v2/style-previews/${encodeURIComponent(pack.previewId)}/slides/${slideIndex + 1}`);
}

function renderStyleMasterSlides(pack, roles = masterPageRoles) {
  const normalizedRoles = (pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? [{ id: "reference", label: "风格参考" }] : roles.length ? roles : masterPageRoles;
  const selectedIndex = Math.max(0, Math.min(normalizedRoles.length - 1, state.stylePreviewSlideIndex));
  state.stylePreviewSlideIndex = selectedIndex;
  const preview = $("styleMasterPreview");
  preview.src = styleMasterSlideUrl(pack, selectedIndex);
  preview.alt = `${pack.name} ${normalizedRoles[selectedIndex].label}${(pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? "" : "母版预览"}`;
  $("styleMasterRole").textContent = `${String(selectedIndex + 1).padStart(2, "0")} · ${normalizedRoles[selectedIndex].label}`;

  const slides = $("styleMasterSlides");
  slides.replaceChildren();
  normalizedRoles.forEach((role, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `style-master-thumb ${index === selectedIndex ? "selected" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
    button.setAttribute("aria-label", `查看${role.label}母版`);
    const image = document.createElement("img");
    image.loading = "lazy";
    image.src = styleMasterSlideUrl(pack, index);
    image.alt = "";
    const label = document.createElement("span");
    label.textContent = `${String(index + 1).padStart(2, "0")} ${role.label}`;
    button.append(image, label);
    button.addEventListener("click", () => {
      state.stylePreviewSlideIndex = index;
      renderStyleMasterSlides(pack, normalizedRoles);
    });
    slides.append(button);
  });
}

function renderStyleMasterRules(meta) {
  const masterPack = meta?.masterPack;
  const routeLabel = "整页视觉一致性母版";
  $("styleMasterVersion").textContent = masterPack
    ? `${masterPack.label} · v${masterPack.version}`
    : `${routeLabel} · v${masterPackVersion}`;
  const rules = $("styleMasterRules");
  rules.replaceChildren();
  // Display a compact summary; the full contract and per-style generation rules
  // remain in the server payload and are not changed by this presentation layer.
  const contract = masterPack?.contract ? {
    layoutSystem: "整页视觉图；构图按内容变化，配色与材质整套统一。",
    titleAnchor: "正文标题的组件、字高、位置和颜色固定；封面独立构图。",
    typography: "标题、正文、数字与页脚统一层级；长文只换行，不改文案、不缩字。",
    spacing: "固定安全边距与信息密度；底部结论按内容需要使用。",
    anchor: "先确认封面和首张正文，再沿用整套视觉规范。"
  } : {};
  Object.entries(masterContractLabels).forEach(([key, label]) => {
    if (!contract[key]) return;
    const row = document.createElement("div");
    row.className = "style-master-rule";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = contract[key];
    row.append(term, description);
    rules.append(row);
  });
}

async function openStyleMasterDialog(pack) {
  state.pendingStyleId = pack.id;
  state.stylePreviewPackId = pack.id;
  state.stylePreviewSlideIndex = 0;
  renderStylePanel();
  updateActions();

  const dialog = $("styleMasterDialog");
  $("styleMasterEyebrow").textContent = (pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? "AI 整页视觉 · 风格参考与页面规则" : "AI 整页视觉 · 6 页母版";
  $("styleMasterTitle").textContent = pack.name;
  $("styleMasterDescription").textContent = (pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? `${pack.description}。参考图用于配色、字体与排版，生成内容以当前 PPT 文案为准。` : `${pack.description}。样张内容统一使用腾讯 2026 Q1 财报。${pack.sampleNote || ""}`;
  $("useStyleMaster").dataset.styleId = pack.id;
  renderStyleMasterRules(null);
  renderStyleMasterSlides(pack);
  if (!dialog.open) dialog.showModal();

  try {
    const meta = styleMasterMetaCache.get(pack.id)
      || await api(`/api/v2/style-previews/${encodeURIComponent(pack.previewId)}/meta`);
    styleMasterMetaCache.set(pack.id, meta);
    if (state.stylePreviewPackId !== pack.id) return;
    renderStyleMasterRules(meta);
    renderStyleMasterSlides(pack, meta.roles || masterPageRoles);
  } catch (error) {
    if (state.stylePreviewPackId === pack.id) {
      $("styleMasterVersion").textContent = "母版规则读取失败";
      showNotice(error.message, "warning");
    }
  }
}

function closeStyleMasterDialog() {
  const dialog = $("styleMasterDialog");
  if (dialog.open) dialog.close();
}

function selectedNarrative() {
  return narrativeOptions.find((option) => option.id === state.narrativeMode) || narrativeOptions[0];
}

function selectedContentDetail() {
  return contentDetailOptions.find((option) => option.id === state.contentDetailMode) || contentDetailOptions[0];
}

function renderNarratives() {
  const node = $("narrativeOptions");
  node.replaceChildren();
  narrativeOptions.forEach((option) => {
    const button = document.createElement("button");
    const selected = option.id === state.narrativeMode;
    button.type = "button";
    button.className = `narrative-option ${selected ? "selected" : ""}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", selected ? "true" : "false");
    button.innerHTML = `<span class="radio-dot"></span><strong>${escapeHtml(option.name)}</strong><span class="narrative-flow">${escapeHtml(option.flow)}</span>`;
    button.addEventListener("click", () => {
      state.narrativeMode = option.id;
      renderNarratives();
      updateSplitButtonText();
      updateActions();
    });
    node.append(button);
  });
  $("narrativeRecommendation").textContent = `当前：${selectedNarrative().name}`;
}

function renderContentDetails() {
  const node = $("contentDetailOptions");
  node.replaceChildren();
  contentDetailOptions.forEach((option) => {
    const button = document.createElement("button");
    const selected = option.id === state.contentDetailMode;
    button.type = "button";
    button.className = `content-detail-option ${selected ? "selected" : ""}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", selected ? "true" : "false");
    button.innerHTML = `<span class="radio-dot"></span><span><strong>${escapeHtml(option.name)}</strong><small>${escapeHtml(option.description)}</small></span>`;
    button.addEventListener("click", () => {
      state.contentDetailMode = option.id;
      renderContentDetails();
      updateSplitButtonText();
      updateActions();
    });
    node.append(button);
  });
}

function updateSplitButtonText() {
  const count = Number($("targetPageCount").value) || 0;
  const narrative = selectedNarrative();
  const contentDetail = selectedContentDetail();
  if (!state.document?.text) {
    $("splitDocument").textContent = "请先上传文档";
    return;
  }
  $("splitDocument").textContent = count
    ? `用 AI 按“${narrative.name} · ${contentDetail.name}”拆成 ${count} 页`
    : `用 AI 按“${narrative.name} · ${contentDetail.name}”分析并拆页`;
}

function setDocumentState(text, mode = "neutral") {
  const node = $("documentState");
  node.textContent = text;
  node.dataset.mode = mode;
}

function renderDocumentBrief() {
  const node = $("documentBrief");
  if (!state.document) {
    node.className = "document-brief empty-state";
    node.innerHTML = "<strong>从一份文档开始</strong><span>支持 Markdown、Word、PPTX、PDF</span>";
    return;
  }
  const stats = state.document.stats || {};
  const name = state.document.source?.name || state.document.name || "已上传文档";
  node.className = "document-brief";
  node.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${stats.characters || 0} 字符 · ${stats.lines || 0} 行 · ${stats.headings || 0} 个标题</span>`;
  $("chooseDocument").textContent = "更换文档";
}

async function analyzePageCount() {
  const documentRecord = state.document;
  if (!documentRecord?.text || !documentRecord.source?.path) return null;
  const runId = state.pageCountAnalysisRun + 1;
  state.pageCountAnalysisRun = runId;
  state.pageCountAnalysisController?.abort();
  const controller = new AbortController();
  state.pageCountAnalysisController = controller;
  showPageCountAnalysisOverlay();
  try {
    const { recommendation } = await api("/api/v2/documents/recommend-page-count", {
      method: "POST",
      body: JSON.stringify({ sourcePath: documentRecord.source.path, text: documentRecord.text, stats: documentRecord.stats || {}, narrativeMode: state.narrativeMode }),
      signal: controller.signal
    });
    if (runId !== state.pageCountAnalysisRun) return null;
    state.recommendation = recommendation || null;
    const count = Number(recommendation?.pageCount);
    if (!Number.isInteger(count) || count < 3 || count > 60) throw new Error("AI 未返回有效的建议页数，请重试，或手动填写 3–60 页");
    $("targetPageCount").value = count;
    finishPageCountAnalysisOverlay({
      mode: "success",
      title: `AI 建议制作 ${count} 页`,
      detail: "已结合内容结构、信息密度与章节边界完成分析"
    });
    return count;
  } catch (error) {
    if (error.name === "AbortError" || runId !== state.pageCountAnalysisRun) return null;
    finishPageCountAnalysisOverlay({
      mode: "error",
      title: "页数分析未完成",
      detail: "可重新分析，或手动填写期望页数",
      delay: 2400
    });
    throw error;
  } finally {
    if (runId === state.pageCountAnalysisRun) {
      state.pageCountAnalysisController = null;
      updateSplitButtonText();
      updateActions();
    }
  }
}

async function uploadDocument(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    setDocumentState("文件超过 20 MB", "failed");
    $("uploadHint").textContent = "请上传不超过 20 MB 的文档。";
    return;
  }
  const loadEpoch = advanceWorkspaceEpoch();
  cancelPageCountAnalysis();
  stopTaskStatusPolling();
  state.eventSource?.close();
  state.eventSource = null;
  state.documentSplitBusy = false;
  state.taskStartBusy = "";
  state.tasks = [];
  state.contentExpandedPageNo = "";
  state.contentEditPageNo = "";
  state.contentStructureMode = false;
  exportPreviewController.dispose();
  forgetLastProject();
  showNotice("");
  state.document = null;
  state.recommendation = null;
  state.contentDetailMode = "focus";
  state.selectedProject = null;
  void referenceUpload.load(null);
  referenceProjectSlug = "";
  state.task = null;
  state.qaReviewTask = null;
  state.deck = null;
  state.pendingStyleId = "";
  state.selectedPageNo = "";
  state.mergeSourcePageNo = "";
  state.pendingDeletePageNo = "";
  $("targetPageCount").value = "";
  $("targetPageCount").disabled = true;
  $("pageCountRecommendation").textContent = "可选；留空将在拆页时由 AI 分析";
  $("uploadHint").textContent = `正在读取 ${file.name}`;
  setDocumentState("正在读取文档", "running");
  renderDocumentBrief();
  renderTaskHistory([]);
  renderContentDetails();
  renderTask();
  updateSplitButtonText();
  updateActions();
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const { document: uploaded } = await api("/api/v2/documents/upload", { method: "POST", body: form });
    if (loadEpoch !== workspaceLoadEpoch) return;
    state.document = uploaded;
    renderDocumentBrief();
    $("targetPageCount").disabled = false;
    $("uploadHint").textContent = "文档保存在本机；开始拆页后，相关内容会发送给所选模型服务。";
    setDocumentState("内容已读取", "connected");
    updateSplitButtonText();
    updateActions();
  } catch (error) {
    if (loadEpoch !== workspaceLoadEpoch) return;
    setDocumentState("读取失败", "failed");
    $("uploadHint").textContent = error.message;
    renderDocumentBrief();
  }
}

async function startDocumentSplit() {
  const documentRecord = state.document;
  if (!documentRecord?.text || !documentRecord.source?.path || state.documentSplitBusy) return;
  const input = String($("targetPageCount").value).trim();
  let targetPageCount = input ? Number(input) : null;
  if (input && (!Number.isInteger(targetPageCount) || targetPageCount < 3 || targetPageCount > 60)) {
    showNotice("期望页数请输入 3–60 的整数；留空可由 AI 自动分析。", "error");
    $("targetPageCount").focus();
    return;
  }
  const loadEpoch = workspaceLoadEpoch;
  const isCurrent = () => loadEpoch === workspaceLoadEpoch && state.document === documentRecord;
  let phase = input ? "creating" : "analyzing";
  state.documentSplitBusy = true;
  state.taskStartBusy = "split";
  setActiveStep(2, { force: true });
  updateActions();
  try {
    if (!input) targetPageCount = await analyzePageCount();
    if (!isCurrent() || targetPageCount == null) return;
    phase = "creating";
    const { task, project } = await api("/api/v2/tasks/split/from-document", {
      method: "POST",
      body: JSON.stringify({
        sourcePath: documentRecord.source.path,
        text: documentRecord.text,
        stats: documentRecord.stats || {},
        narrativeMode: state.narrativeMode,
        contentDetailMode: state.contentDetailMode,
        referenceBundleId: referenceUpload.get()?.id || null,
        targetPageCount
      })
    });
    if (!isCurrent()) return;
    cancelPageCountAnalysis();
    state.selectedProject = project;
    referenceUpload.clearDraft();
    rememberProject(project);
    state.task = task;
    state.tasks = [];
    state.deck = null;
    state.pendingStyleId = "";
    state.selectedPageNo = "";
    setDocumentState("内容已读取", "connected");
    renderTask();
    subscribe(project.slug, task.taskId);
    await Promise.all([loadProjects(), loadDeck(project.slug), loadTaskHistory(project.slug, { hydrateLatest: false })]);
  } catch (error) {
    if (!isCurrent() || error.name === "AbortError") return;
    cancelPageCountAnalysis();
    setDocumentState("内容已读取", "connected");
    setActiveStep(1, { force: true });
    showNotice(phase === "analyzing"
      ? `页数分析未完成：${error.message}。可点击“开始拆页”重试，或手动填写期望页数。`
      : `拆页任务未能启动：${error.message}。请重试。`, "error");
  } finally {
    if (isCurrent()) {
      state.documentSplitBusy = false;
      state.taskStartBusy = "";
      renderTask();
      updateActions();
    }
  }
}

function taskLabel(task) {
  if (task?.kind === "image2-compile") {
    const styleName = stylePacks.find((pack) => pack.id === task?.input?.styleId)?.name || task?.input?.styleId || "";
    return styleName ? `Image2 视觉计划 · ${styleName}` : "Image2 视觉计划";
  }
  if (task?.kind === "generation") {
    const pageNo = singlePageTaskNo(task);
    const operation = task?.operation || task?.input?.operation || "";
    if (pageNo && operation === "missing-anchor-generation") return `生成 ${pageNo} 锚点`;
    if (pageNo && operation === "anchor-regeneration") return `重新生成 ${pageNo} 锚点`;
    if (pageNo && operation === "page-regeneration") return `重新生成 ${pageNo}`;
    return "页面生成";
  }
  if (task?.kind === "qa-export") return "检查导出";
  if (task?.kind === "direct-export") return "直接导出";
  return "拆页文案";
}

function singlePageTaskNo(task = {}) {
  const requested = Array.isArray(task?.input?.pageIds) ? task.input.pageIds.filter(Boolean) : [];
  if (requested.length === 1) return String(requested[0]);
  if (task?.activePageNos?.length === 1) return String(task.activePageNos[0]);
  return "";
}

function singlePageRegenerationNo(task = {}) {
  const operation = task?.operation || task?.input?.operation || "";
  if (!["page-regeneration", "anchor-regeneration"].includes(operation)) return "";
  return singlePageTaskNo(task) || String(task?.currentPage || "");
}

function taskStateLabel(task) {
  if (task?.status === "cancelled") return "已取消";
  if (task?.phase === "cancelling") return "正在取消";
  if (task?.status === "completed") return "已完成";
  if (task?.status === "failed") return task?.kind === "direct-export" ? "导出失败" : "生成失败";
  if (task?.status === "paused") return "待继续";
  return "进行中";
}

function taskPhaseLabel(task = {}, completed = 0, total = 0) {
  if (task.kind === "split") return splitStatus(task, { connectionIssue: splitConnectionIssue }).detail;
  if (task.phase === "cancelling") return "取消请求已保存，正在等待模型进程停止";
  if (task.status === "cancelled") return "拆页已取消，原文与设置已保留，可继续原任务";
  if (task.status === "completed") {
    if (task.kind === "image2-compile" || task.phase === "anchor-ready") return "双锚点已生成，等待确认";
    if (task.kind === "generation") return task.phase === "remaining" ? "剩余页面已生成" : "页面已生成";
    if (task.kind === "qa-export") return "检查与导出已完成";
    if (task.kind === "direct-export") return "已跳过检查并导出";
    return "文案已生成并保存";
  }
  if (task.phaseMessage) return task.phaseMessage;
  const phase = String(task.phase || "");
  if (phase === "starting") return "正在创建任务";
  if (phase === "visual-compiling") return "AI 正在编译整套 Image2 视觉计划";
  if (phase === "anchors-pending" || phase === "anchors") return `正在生成封面与正文视觉母版，已完成 ${completed}/${total || 2}`;
  if (["remaining", "generating"].includes(phase)) return `正在生成剩余页面，已完成 ${completed}/${total || "-"}`;
  if (phase === "direct-export") return "正在跳过检查并打包 PPTX";
  if (phase === "planning") return "AI 正在梳理整套讲述结构";
  if (phase === "pages") return "结构已通过，正在整理整套页面文案";
  if (phase === "validating") return "正在校验页数、讲述顺序和版式容量";
  if (phase === "repairing") return "发现整套结构冲突，正在自动修复";
  if (phase === "saving") return "结构校验已通过，正在保存项目";
  if (/^正在生成\s+P\d+/i.test(phase)) return `${phase}，已完成 ${completed}/${total || "-"} 页`;
  return phase || "正在准备";
}

function compactDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (!totalSeconds) return "";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function updateTaskProgressToastElapsed() {
  if (!taskProgressToastStartedAt) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - taskProgressToastStartedAt) / 1000));
  $("taskProgressToastElapsed").textContent = `已用时 ${elapsed} 秒`;
  if (state.activeStep === 2) renderStepActionDock();
  const splitTime = document.querySelector(".split-time-summary");
  if (splitTime) splitTime.textContent = splitElapsedLabel(taskForActiveStep());
  if (state.activeStep === 4) renderImage2TaskProgressDock();
}

function stopTaskProgressToastTimer() {
  window.clearInterval(taskProgressToastTimer);
  taskProgressToastTimer = null;
  taskProgressToastStartedAt = 0;
  taskProgressToastKey = "";
}

function renderTaskProgressToast() {
  const toast = $("taskProgressToast");
  const anchorActionDock = $("image2AnchorActionDock");
  const task = taskForActiveStep();
  const running = ["queued", "running"].includes(task?.status);
  const dockProgress = running && state.activeStep === 2 && task?.kind === "split";
  const step4DockProgress = step4TaskInProgress(task);
  toast.hidden = true;
  if (anchorActionDock) {
    anchorActionDock.hidden = false;
    anchorActionDock.setAttribute("aria-hidden", "false");
  }
  if (!step4DockProgress && !dockProgress) {
    stopTaskProgressToastTimer();
    return;
  }
  const nextTaskKey = `${task.id || task.taskId || task.createdAt || state.selectedProject || "split"}:${task.attemptStartedAt || ""}`;
  if (taskProgressToastKey !== nextTaskKey) {
    stopTaskProgressToastTimer();
    taskProgressToastKey = nextTaskKey;
    const taskStartedAt = Date.parse(task.kind === "split" ? task.attemptStartedAt || "" : task.startedAt || task.createdAt || "");
    taskProgressToastStartedAt = Number.isFinite(taskStartedAt) ? taskStartedAt : Date.now();
    updateTaskProgressToastElapsed();
    taskProgressToastTimer = window.setInterval(updateTaskProgressToastElapsed, 1000);
  }
  if (dockProgress) {
    renderStepActionDock();
    return;
  }
  renderImage2TaskProgressDock(task);
}

function taskForActiveStep() {
  if (state.activeStep === 4 && state.anchorBusy?.startsWith("generate:")) {
    const kind = state.anchorBusy.slice("generate:".length);
    const page = image2AnchorPage(kind, state.deck?.pages || []);
    const pageNo = page?.pageNo || (kind === "cover" ? "P01" : "P02");
    return { kind: "generation", status: "queued", phase: "starting", total: 1, completed: 0,
      operation: "missing-anchor-generation", currentPage: pageNo, generationPageNos: [pageNo],
      pages: [{ id: page?.id || pageNo, pageNo, generationStatus: "preparing" }], input: { pageIds: [pageNo] } };
  }
  const anchors = image2Anchors();
  const optimisticTask = startingTaskForStep({
    taskStartBusy: state.taskStartBusy,
    activeTask: state.task,
    step: state.activeStep,
    targetPageCount: Number($("targetPageCount")?.value) || Number(state.deck?.styleProfile?.targetPageCount) || Number(state.deck?.pages?.length) || 0,
    anchorPageIds: [anchors.cover?.pageId, anchors.content?.pageId]
  });
  return optimisticTask || taskForStep({ activeTask: state.task, tasks: state.tasks, step: state.activeStep });
}

function updateSplitTaskPages(pages = []) {
  const splitTask = taskForStep({ activeTask: state.task, tasks: state.tasks, step: 2 });
  if (!splitTask) return;
  splitTask.pages = pages;
  splitTask.total = pages.length;
  splitTask.completed = pages.length;
}

function pageImagePath(page = {}) {
  page ||= {};
  return page.imagePath
    || page.finalImage?.path
    || page.finalImage?.source
    || page.regenerationPreviewImage?.path
    || page.regenerationPreviewImage?.source
    || "";
}

function visiblePages(task = taskForActiveStep()) {
  const pages = visiblePagesForState({
    task,
    deckPages: state.deck?.pages || [],
    imagePath: pageImagePath
  });
  // Uncommitted split pages own their draft titles. Committed pages use the
  // same blueprint title as the editor, without migrating legacy project data.
  if (task?.kind === "split" && task.status !== "completed") return pages;
  const committed = new Map((state.deck?.pages || []).map((page) => [page.pageNo || page.id, page]));
  return pages.map((page) => typeof committed.get(page.pageNo)?.copyBlueprint?.title === "string"
    ? { ...page, title: committed.get(page.pageNo).copyBlueprint.title }
    : page);
}

function displayTextFor(page = {}) {
  if (typeof page.displayText === "string") return page.displayText;
  if (Array.isArray(page.blocks)) {
    const titleRoles = new Set(["headline", "title", "subtitle", "标题", "副标题"]);
    return page.blocks
      .filter((block) => !titleRoles.has(String(block?.role || "").trim().toLowerCase()))
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function pageStatus(page, task = taskForActiveStep()) {
  if (page.generationStatus === "cancelled") return { label: pageImagePath(page) ? "图片已保留，已停止" : "已停止", mode: "paused" };
  if (page.generationStatus === "failed") {
    return { label: image2FailurePresentation(page).label, mode: "failed" };
  }
  if (task?.status === "paused" && ["writing", "generating"].includes(page.generationStatus)) return { label: "待继续", mode: "paused" };
  if (image2WorkStageLabel(page)) return { label: image2WorkStageLabel(page), mode: "running" };
  if (page.generationStatus === "writing") return { label: "文案生成中", mode: "running" };
  if (page.generationStatus === "generating") return { label: "图片生成中", mode: "running" };
  if (task?.kind === "generation" && ["queued", "running"].includes(task.status)) {
    if (page.generationStatus === "generated" && pageImagePath(page)) return { label: "图片已生成", mode: "completed" };
    return { label: "等待生图", mode: "neutral" };
  }
  if (pageImagePath(page)) return { label: "可预览", mode: "completed" };
  if (page.title) return { label: "文案已生成", mode: "completed" };
  return { label: "等待生成", mode: "neutral" };
}

function qaReportMarkup(qa = {}) {
  const issues = visibleQaIssues(qa);
  if (!issues.length) {
    return qa.status === "ready"
      ? '<section class="qa-report ready"><strong>质量检查通过</strong><span>已满足导出条件。</span></section>'
      : "";
  }
  const highCount = issues.filter((issue) => issue.severity === "high").length;
  return `<section class="qa-report ${highCount ? "blocked" : "ready"}">
    <div class="qa-report-head"><strong>${highCount ? `${highCount} 个高风险问题待处理` : `${issues.length} 条改进建议`}</strong><span>修复后重新检查</span></div>
    <div class="qa-issue-list">${issues.slice(0, 8).map((issue) => `<article class="qa-issue ${issue.severity === "high" ? "high" : "medium"}">
      <div class="qa-issue-title"><span>${escapeHtml(issue.pageNo || "整套")}</span><strong>${escapeHtml(issue.message)}</strong></div>
      ${issue.suggestion ? `<small>${escapeHtml(issue.suggestion)}</small>` : ""}
    </article>`).join("")}</div>
  </section>`;
}

function visibleQaIssues(qa = {}) {
  const issues = (Array.isArray(qa.issues) ? qa.issues : [])
    .filter((issue) => !/^image2-visual-audit-score-p\d+$/i.test(String(issue.id || "")));
  const contentDetailMode = state.deck?.styleProfile?.contentDetailMode || state.contentDetailMode;
  if (contentDetailMode !== "detailed") return issues;
  return issues.filter((issue) => issue.id !== "dense-image-only-text");
}

function isVisualAuditScoreIssue(issue = {}) {
  return String(issue.id || "") === "image2-visual-audit-score";
}

function qaScoreScope(qa = {}) {
  const scoped = qa.scope === "selected" || qa.scope?.mode === "selected";
  const total = Number(qa.total || qa.summary?.totalPages || state.deck?.pages?.length || 0);
  return {
    scoped,
    metricLabel: scoped ? "本次复检评分" : "整套视觉评分",
    rangeLabel: scoped ? `本次新生成的 ${total} 页` : `整套 ${total} 页`
  };
}

function qaDecisionGroups(qa = {}) {
  const issues = visibleQaIssues(qa);
  const decisionIssues = issues.filter((issue) => issue.requiresDecision !== false);
  const pageGroups = new Map();
  decisionIssues.forEach((issue) => {
    const pageNo = String(issue.pageNo || "").trim();
    if (!pageNo) return;
    if (!pageGroups.has(pageNo)) pageGroups.set(pageNo, []);
    pageGroups.get(pageNo).push(issue);
  });
  if (pageGroups.size) return [...pageGroups.entries()].map(([key, groupedIssues]) => ({ key, pageNo: key, issues: groupedIssues }));
  return decisionIssues.length ? [{ key: "deck", pageNo: "", issues: decisionIssues }] : [];
}

function qaDecisionState(qa = {}) {
  const groups = qaDecisionGroups(qa);
  const decisions = qa.decisions && typeof qa.decisions === "object" ? qa.decisions : {};
  const unresolved = groups.filter((group) => {
    const decision = decisions[group.key]?.decision;
    return !["fix", "ignore"].includes(decision);
  });
  const fixGroups = groups.filter((group) => decisions[group.key]?.decision === "fix");
  const ignoreGroups = groups.filter((group) => decisions[group.key]?.decision === "ignore");
  return {
    groups,
    decisions,
    unresolved,
    fixGroups,
    ignoreGroups,
    canStartFixes: unresolved.length === 0 && fixGroups.length > 0,
    canExport: unresolved.length === 0 && fixGroups.length === 0
  };
}

function qaTaskForReview() {
  if (state.task?.kind === "qa-export") return state.task.qa ? state.task : null;
  if (state.task?.operation === "qa-batch-regeneration" && state.task.input?.parentTaskId) {
    const parentId = state.task.input.parentTaskId;
    return [state.qaReviewTask, ...state.tasks].find((task) => task?.taskId === parentId && task.qa) || null;
  }
  if (state.qaReviewTask?.qa) return state.qaReviewTask;
  return state.tasks.find((task) => task.kind === "qa-export" && task.qa) || null;
}

function rememberQaTask(task) {
  if (!task?.taskId || task.kind !== "qa-export" || !task.qa) return;
  state.qaReviewTask = task;
  const index = state.tasks.findIndex((candidate) => candidate.taskId === task.taskId);
  if (index >= 0) state.tasks[index] = task;
}

function qaFixPrompt(group = {}) {
  const details = (group.issues || []).map((issue) => issue.suggestion || issue.message).filter(Boolean);
  const hasVisualMasterBlock = (group.issues || []).some((issue) => issue.hardBlock === true);
  const prefix = hasVisualMasterBlock
    ? "只修复与正文视觉母版不一致的维度：严格对齐背景材质、版心与安全边距、标题位置和字号、标题分隔线、主辅配色、图标与组件语言、底部结论区及密度范围；长标题只能换行或精简，禁止缩小字号。"
    : "修复本页与整套 PPT 的视觉一致性问题。";
  return `${prefix}${details.join("；")}。保持当前页面事实、已选风格和其他已确认内容不变。`.slice(0, 500);
}

function renderQaDecisionPanel(task = qaTaskForReview()) {
  const panel = $("qaDecisionPanel");
  if (!panel) return;
  const qa = task?.kind === "qa-export" ? task.qa : null;
  if (!qa) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const review = qaDecisionState(qa);
  const issues = visibleQaIssues(qa);
  const globalIssues = issues.filter((issue) => !String(issue.pageNo || "").trim() && !isVisualAuditScoreIssue(issue));
  const visualScore = qa.summary?.visualAuditScore;
  const scoreScope = qaScoreScope(qa);
  const selectedCount = review.groups.length - review.unresolved.length;
  const exportedPath = task.export?.path || "";
  $("qaDecisionProgress").textContent = exportedPath
    ? "已检查并导出"
    : review.groups.length
      ? `${selectedCount} / ${review.groups.length} 页已选择`
      : "检查通过";
  $("qaDecisionDescription").textContent = review.groups.length
    ? "先为所有问题页选择“修复”或“不修复”；选择完成后，再一次开始生成待修复页面。"
    : "本次检查未发现阻断导出的一致性问题。";
  const repairTask = state.task?.operation === "qa-batch-regeneration"
    && state.task.input?.parentTaskId === task.taskId ? state.task : null;
  if (repairTask) {
    $("qaDecisionProgress").textContent = repairTask.status === "completed" ? "修复完成，待复检"
      : ["queued", "running"].includes(repairTask.status) ? "AI 修复进行中" : "修复未完成";
    $("qaDecisionDescription").textContent = ["queued", "running"].includes(repairTask.status)
      ? "已将所选页面和修改要求提交给 AI，正在重新生成页面。"
      : repairTask.status === "completed"
        ? "以下保留修复前的检查结果，请检查本次新生成的页面。"
        : `以下保留修复前的检查结果。${repairTask.error || repairTask.recovery?.message || "修复已中断，原图片已保留。"}重新发起会再次调用 AI。`;
  }
  $("qaDecisionSummary").innerHTML = `<div class="qa-summary-metric"><span>检查页数</span><strong>${escapeHtml(String(qa.total || state.deck?.pages?.length || 0))}</strong></div>
    <div class="qa-summary-metric ${visualScore != null && Number(visualScore) < 90 ? "attention" : "ready"}"><span>${scoreScope.metricLabel}</span><strong>${visualScore == null ? "未评分" : `${escapeHtml(String(visualScore))} 分`}</strong><small>${visualScore == null ? "未执行成图视觉审计" : "90 分为导出线"}</small></div>
    <div class="qa-summary-metric ${review.unresolved.length ? "attention" : "ready"}"><span>待确认问题页</span><strong>${review.unresolved.length}</strong></div>
    ${visualScore == null ? "" : `<p class="qa-score-note"><strong>评分是什么：</strong>AI 已逐页查看并横向比较${escapeHtml(scoreScope.rangeLabel)}，按标题尺度与位置、配色材质、组件语言、页面密度、文字完整性和构图多样性给出 100 分制视觉审计分；它不是页面进度，也不是问题数量的平均分。</p>`}
    ${globalIssues.length ? `<p class="qa-global-note"><strong>整套提醒：</strong>${globalIssues.map((issue) => escapeHtml(issue.message)).join("；")}</p>` : ""}`;
  if (!review.groups.length) {
    $("qaDecisionCards").innerHTML = `<article class="qa-decision-empty"><strong>页面一致性检查通过</strong><span>标题层级、视觉规范、可读性和整套成图检查均未发现阻断问题。</span>${exportedPath ? `<a class="button primary" href="${artifactUrl(exportedPath)}" download>下载 PPTX</a>` : ""}</article>`;
    return;
  }
  $("qaDecisionCards").innerHTML = review.groups.map((group) => {
    const decision = review.decisions[group.key]?.decision || "";
    const page = group.pageNo ? (state.deck?.pages || []).find((candidate) => candidate.pageNo === group.pageNo) : null;
    const pageIssues = group.pageNo
      ? issues.filter((issue) => issue.pageNo === group.pageNo)
      : group.issues;
    const imagePath = pageImagePath(page);
    const highCount = group.issues.filter((issue) => issue.severity === "high").length;
    const hardBlocked = group.issues.some((issue) => issue.hardBlock === true);
    const title = group.pageNo ? `${group.pageNo} ${page?.title || group.issues[0]?.title || "问题页"}` : "整套视觉一致性";
    const decisionClass = decision === "fix" ? "selected-fix" : decision === "ignore" ? "ignored" : "unresolved";
    const decisionLabel = decision === "fix" ? "已选择修复" : decision === "ignore" ? "已确认不修复" : hardBlocked ? "正文视觉母版硬门槛" : `${highCount ? `${highCount} 个高风险` : `${group.issues.length} 条建议`}`;
    return `<article class="qa-decision-card ${decisionClass}" data-qa-key="${escapeHtml(group.key)}">
      <div class="qa-decision-preview">${imagePath ? `<img src="${artifactUrl(imagePath)}" alt="${escapeHtml(title)}" />` : `<span>${escapeHtml(group.pageNo || "整套")}</span>`}</div>
      <div class="qa-decision-copy">
        <div class="qa-decision-card-head"><div><span>${escapeHtml(group.pageNo || "整套")}</span><strong>${escapeHtml(title.replace(/^P\d+\s*/, ""))}</strong></div><em>${decisionLabel}</em></div>
        <ul>${pageIssues.map((issue) => `<li><strong>${escapeHtml(issue.message)}</strong>${issue.suggestion ? `<span>${escapeHtml(issue.suggestion)}</span>` : ""}</li>`).join("")}</ul>
        <div class="qa-decision-actions">
          ${group.pageNo ? `<button class="button primary compact" data-qa-fix="${escapeHtml(group.pageNo)}" type="button" ${state.qaActionBusy ? "disabled" : ""}>${decision === "fix" ? "编辑修复要求" : "选择修复"}</button>` : `<button class="button secondary compact" data-qa-recheck type="button" ${state.qaActionBusy ? "disabled" : ""}>重新检查</button>`}
          <button class="button secondary compact" data-qa-ignore="${escapeHtml(group.key)}" type="button" ${decision === "ignore" || state.qaActionBusy ? "disabled" : ""}>${decision === "ignore" ? "已选择跳过" : hardBlocked ? "跳过本页，保留当前版本" : "不修复，保留当前页"}</button>
        </div>
      </div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-qa-fix]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = review.groups.find((candidate) => candidate.pageNo === button.dataset.qaFix);
      const savedFeedback = review.decisions[group?.key]?.feedback || "";
      openImage2RegenerateDialog(`qa-page:${button.dataset.qaFix}`, savedFeedback || qaFixPrompt(group));
    });
  });
  document.querySelectorAll("[data-qa-ignore]").forEach((button) => {
    button.addEventListener("click", () => { void ignoreQaIssueGroup(button.dataset.qaIgnore); });
  });
  document.querySelectorAll("[data-qa-recheck]").forEach((button) => {
    button.addEventListener("click", () => { void startTask("qa-export"); });
  });
}

function renderTaskSummary(task = taskForActiveStep()) {
  const node = $("taskSummary");
  exportPreviewController.bind(state.activeStep === 4 && task?.export?.path ? { projectSlug: state.selectedProject?.slug, taskId: task.taskId, preview: task.export.preview } : null);
  const pages = visiblePages(task);
  if (state.activeStep === 2 && task?.kind === "split" && ["queued", "running"].includes(task.status)) {
    node.hidden = true;
    return;
  }
  node.hidden = state.activeStep === 2 && (!task || task.status === "completed");
  if (node.hidden) return;
  if (!task) {
    node.className = "task-summary empty-state";
    node.textContent = pages.length ? `${pages.length} 页内容已恢复。` : "当前步骤尚未开始。";
    return;
  }
  const configuration = splitDisplayConfiguration({ task, deck: state.deck });
  const total = configuration.source === "task" ? configuration.pageCount || "-" : Number(task.total) || pages.length || "-";
  const completed = Number(task.completed) || 0;
  const exportedPath = task.export?.path || "";
  const phase = task.qa
    ? (task.qa.status === "ready" ? "质量检查已通过" : "请按检查单修复后重试")
    : task.status === "completed"
      ? taskPhaseLabel(task, completed, total)
      : task.error || task.recovery?.message || taskPhaseLabel(task, completed, total);
  node.className = "task-summary";
  node.innerHTML = `<div class="task-summary-main"><strong>${escapeHtml(taskLabel(task))}</strong><span>${escapeHtml(taskStateLabel(task))}</span></div>
    <div class="task-progress"><strong>${completed}</strong> / ${total} 页</div>
    <div class="task-phase">${escapeHtml(phase)}</div>
    ${qaReportMarkup(task.qa)}
    <div class="task-summary-actions">
      ${task.status === "paused" && !splitLifecycleControl(task) ? `<button id="resumeTask" class="button primary" type="button">${task.kind === "generation" ? "继续生成" : task.kind === "split" ? "重新拆页" : "重新检查"}</button>` : ""}
      ${task.kind === "split" && ["failed", "cancelled"].includes(task.status) ? '<button id="retrySplit" class="button secondary" type="button">重新拆页</button>' : ""}
      ${task.kind === "qa-export" && task.status === "failed" ? '<button id="retryQa" class="button secondary" type="button">重新检查</button>' : ""}
      ${exportedPath ? `<a class="button primary export-download" href="${artifactUrl(exportedPath)}" download>下载 PPTX</a>` : ""}
      ${exportedPath ? exportPreviewMarkup(task.export?.preview, { ...exportPreviewController.snapshot(), artifactUrl }) : ""}
    </div>`;
  $("resumeTask")?.addEventListener("click", () => { void startTask(task.kind); });
  $("retrySplit")?.addEventListener("click", () => { void startTask("split"); });
  $("retryQa")?.addEventListener("click", () => { void startTask("qa-export"); });
  $("retryExportPreview")?.addEventListener("click", () => { void exportPreviewController.retry(); });
}

const splitProgressHistory = new Map();
function splitProgressMarkup(task) {
  const key = JSON.stringify([state.selectedProject?.slug, task.taskId || "starting", task.attemptStartedAt]);
  const entries = splitProgressHistory.get(key) || [];
  const message = splitStatus(task).detail;
  if (entries.at(-1)?.message !== message) {
    const timestamp = task.updatedAt || task.createdAt;
    const date = timestamp ? new Date(timestamp) : null;
    entries.push({ message, time: date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false }) : "" });
    splitProgressHistory.set(key, entries.slice(-3));
    if (splitProgressHistory.size > 20) splitProgressHistory.delete(splitProgressHistory.keys().next().value);
  }
  return `<ol class="split-progress-log" aria-label="最近拆页进度">${(splitProgressHistory.get(key) || []).map((entry) => `<li>${entry.time ? `<time>${escapeHtml(entry.time)}</time>` : ""}<span>${escapeHtml(entry.message)}</span></li>`).join("")}</ol>`;
}

function splitStageMarkup(task) {
  const status = splitStatus(task, { connectionIssue: splitConnectionIssue });
  return `<ol class="split-stage-steps" aria-label="拆页执行阶段">${SPLIT_STAGES.map((label, index) => `<li${status.stage === index + 1 ? ' aria-current="step"' : ""}>${index + 1}. ${label}</li>`).join("")}</ol><p class="split-time-summary">${escapeHtml(splitElapsedLabel(task))}</p>`;
}

function renderTask() {
  const task = taskForActiveStep();
  projectHistoryDialog.refreshBusy();
  renderTaskProgressToast();
  renderTaskSummary(task);
  renderStepActionDock();
  if (state.activeStep === 4) renderImage2Anchors();
  const pages = visiblePages(task);
  $("finishContentStructure").hidden = state.activeStep !== 2 || !state.contentStructureMode;
  rememberCopyDraft();
  const editorPanel = document.querySelector(".page-editor-panel");
  document.querySelector(".page-workspace").append(editorPanel);
  editorPanel.hidden = state.activeStep === 2;
  pageStream.replaceChildren();
  if (!pages.length) {
    const analyzing = state.activeStep === 2 && pageCountAnalysisDockState?.mode === "running";
    const splitFailed = task?.kind === "split" && ["failed", "paused", "cancelled"].includes(task?.status);
    const splitGenerating = task?.kind === "split" && ["queued", "running"].includes(task.status);
    pageStream.innerHTML = analyzing
      ? `<div class="stream-waiting split-generating-state" role="status"><span class="inline-spinner" aria-hidden="true"></span><strong>正在分析新文档的建议页数</strong><span>分析完成后会自动开始拆页，并在这里展示新文档的文案。</span></div>`
      : splitGenerating
      ? `<div class="stream-waiting split-generating-state" role="status" aria-label="AI 正在生成整套拆页文案"><span class="inline-spinner" aria-hidden="true"></span><strong>${escapeHtml(splitStatus(task, { connectionIssue: splitConnectionIssue }).title)}</strong><span>整套文案生成后，一次显示全部页面。</span>${splitStageMarkup(task)}${splitProgressMarkup(task)}</div>`
      : `<div class="stream-waiting">${splitFailed
        ? (splitLifecycleControl(task)?.action === "resume" ? "原文与任务检查点已保留，点击“继续拆页”恢复原任务，或选择重新拆页。" : "本次没有生成可用的页面文案，请点击上方“重新拆页”。")
        : state.task?.kind === "generation" ? "正在准备第一张页面预览。" : "整套文案生成完成后，将在这里一次展示全部页面。"}</div>`;
    $("pageNo").textContent = "-";
    if (splitGenerating) {
      $("pageDetail").className = "page-detail";
      $("pageDetail").innerHTML = `<div class="copy-generating-state" role="status" aria-label="AI 正在生成拆页文案"><span class="inline-spinner" aria-hidden="true"></span><strong>AI 正在生成拆页文案</strong><p>正在梳理页面结构、标题和展示文字；任务创建后会继续显示实时进度。</p></div>`;
      setTaskStatus("生成中", "running");
    } else {
      if (splitFailed) setTaskStatus(taskStateLabel(task), task.status === "failed" ? "failed" : "neutral");
      $("pageDetail").className = "page-detail empty-state";
      $("pageDetail").textContent = splitFailed
        ? `原文档、讲述结构、详略模式和 ${splitDisplayConfiguration({ task, deck: state.deck }).pageCount || "目标"} 页设置均已保留。`
        : "生成期间可继续停留在本页；完成后会自动显示全部页面文案。";
    }
    return;
  }
  if (!pages.some((page) => page.pageNo === state.selectedPageNo)) state.selectedPageNo = pages[0].pageNo;
  if (!pages.some((page) => page.pageNo === state.mergeSourcePageNo)) state.mergeSourcePageNo = "";
  if (!pages.some((page) => page.pageNo === state.pendingDeletePageNo)) state.pendingDeletePageNo = "";
  const canMutateStructure = state.activeStep === 2 && contentCanEdit() && state.contentStructureMode;
  if (canMutateStructure && state.mergeSourcePageNo) {
    const hint = document.createElement("div");
    hint.className = "merge-hint";
    hint.innerHTML = `<span>已选择 <strong>${escapeHtml(state.mergeSourcePageNo)}</strong> 作为来源页，点击另一页“合并到此页”。</span><button type="button">取消</button>`;
    hint.querySelector("button").addEventListener("click", () => {
      state.mergeSourcePageNo = "";
      renderTask();
    });
    pageStream.append(hint);
  }
  pages.forEach((page) => {
    const status = pageStatus(page, task);
    const card = document.createElement("article");
    card.className = `page-card ${state.selectedPageNo === page.pageNo ? "selected" : ""} ${state.mergeSourcePageNo === page.pageNo ? "merge-source" : ""}`;
    const showStatus = state.activeStep !== 2 && !canMutateStructure && task?.status !== "completed";
    card.innerHTML = `<button class="page-card-select" type="button"><span class="page-card-number">${escapeHtml(page.pageNo)}</span><span class="page-card-copy"><strong>${escapeHtml(page.title || "正在生成页面")}</strong>${state.activeStep === 2 ? `<span class="content-page-summary">${escapeHtml(contentSummary(page))}</span>` : ""}</span>${state.activeStep === 2 ? `<span class="content-expand-label">${copyEditorDrafts.has(JSON.stringify([state.selectedProject?.slug, page.pageNo])) ? "未保存 · " : ""}${state.contentExpandedPageNo === page.pageNo ? "收起" : "查看内容"}</span>` : ""}${showStatus ? `<span class="page-card-status ${status.mode}">${escapeHtml(status.label)}</span>` : ""}</button><div class="page-card-actions"></div>`;
    if (state.activeStep === 2) {
      card.querySelector(".page-card-select").setAttribute("aria-expanded", String(state.contentExpandedPageNo === page.pageNo));
      card.classList.toggle("selected", state.contentExpandedPageNo === page.pageNo);
    }
    card.querySelector(".page-card-select").addEventListener("click", () => {
      if (state.contentSaveBusy) return;
      rememberCopyDraft();
      if (state.activeStep === 2) state.contentExpandedPageNo = state.contentExpandedPageNo === page.pageNo ? "" : page.pageNo;
      state.selectedPageNo = page.pageNo;
      renderTask();
    });
    const actions = card.querySelector(".page-card-actions");
    if (canMutateStructure) {
      if (state.pendingDeletePageNo === page.pageNo) {
        actions.innerHTML = '<button class="page-action danger solid" type="button">确认删除</button><button class="page-action" type="button">取消</button>';
        actions.children[0].addEventListener("click", () => { void deleteOutlinePage(page.pageNo); });
        actions.children[1].addEventListener("click", () => {
          state.pendingDeletePageNo = "";
          renderTask();
        });
      } else if (state.mergeSourcePageNo && state.mergeSourcePageNo !== page.pageNo) {
        actions.innerHTML = '<button class="page-action primary solid" type="button">合并到此页</button>';
        actions.firstElementChild.addEventListener("click", () => { void mergeOutlinePages(state.mergeSourcePageNo, page.pageNo); });
      } else if (state.mergeSourcePageNo === page.pageNo) {
        actions.innerHTML = '<button class="page-action" type="button">取消合并</button>';
        actions.firstElementChild.addEventListener("click", () => {
          state.mergeSourcePageNo = "";
          renderTask();
        });
      } else {
        actions.innerHTML = '<button class="page-action" type="button" title="选择为合并来源页">合并</button><button class="page-action danger" type="button" title="删除本页">删除</button>';
        actions.children[0].addEventListener("click", () => {
          state.pendingDeletePageNo = "";
          state.mergeSourcePageNo = page.pageNo;
          renderTask();
        });
        actions.children[1].disabled = pages.length <= 1;
        actions.children[1].addEventListener("click", () => {
          state.mergeSourcePageNo = "";
          state.pendingDeletePageNo = page.pageNo;
          renderTask();
        });
      }
    }
    [...actions.querySelectorAll("button")].forEach((action) => { action.disabled ||= state.pageMutationBusy; });
    pageStream.append(card);
    if (state.activeStep === 2 && state.contentExpandedPageNo === page.pageNo) {
      editorPanel.hidden = false;
      card.append(editorPanel);
    }
  });
  if (state.activeStep !== 2 || state.contentExpandedPageNo) renderPageDetail(pages.find((page) => page.pageNo === state.selectedPageNo) || pages[0]);
  const mode = task?.status === "failed" ? "failed" : task?.status === "completed" ? "completed" : "running";
  setTaskStatus(task ? taskStateLabel(task) : `${pages.length} 页`, mode);
}

async function deleteOutlinePage(pageNo) {
  if (state.contentSaveBusy || hasContentDrafts()) return showNotice("请先保存或放弃未保存的修改。", "warning");
  if (!state.selectedProject || state.pageMutationBusy) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  const expectedRevision = state.deck?.storageRevision ?? state.deck?.revision;
  const page = state.deck?.pages?.find(page => (page.pageNo || page.id) === pageNo);
  const expectedPageId = page?.id || page?.pageNo;
  if (!Number.isSafeInteger(expectedRevision) || !expectedPageId) return showNotice('请重新载入项目后再删除。', 'warning');
  state.pageMutationBusy = true;
  renderTask();
  setTaskStatus(`正在删除 ${pageNo}`, "running");
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/pages/${encodeURIComponent(pageNo)}/delete`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, expectedPageId })
    });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck;
    updateSplitTaskPages(result.pages);
    state.selectedPageNo = result.selectedPageNo || result.pages[0]?.pageNo || "";
    state.pendingDeletePageNo = "";
    state.mergeSourcePageNo = "";
    showNotice(result.message, "success");
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.pageMutationBusy = false;
      renderTask();
    }
  }
}

async function mergeOutlinePages(sourcePageNo, targetPageNo) {
  if (state.contentSaveBusy || hasContentDrafts()) return showNotice("请先保存或放弃未保存的修改。", "warning");
  if (!state.selectedProject || state.pageMutationBusy || sourcePageNo === targetPageNo) return;
  const context = { projectSlug: state.selectedProject.slug, epoch: workspaceLoadEpoch };
  const expectedRevision = state.deck?.storageRevision ?? state.deck?.revision;
  const sourcePage = state.deck?.pages?.find(page => (page.pageNo || page.id) === sourcePageNo);
  const targetPage = state.deck?.pages?.find(page => (page.pageNo || page.id) === targetPageNo);
  const expectedSourcePageId = sourcePage?.id || sourcePage?.pageNo;
  const expectedTargetPageId = targetPage?.id || targetPage?.pageNo;
  if (!Number.isSafeInteger(expectedRevision) || !expectedSourcePageId || !expectedTargetPageId) return showNotice('请重新载入项目后再合并。', 'warning');
  state.pageMutationBusy = true;
  renderTask();
  setTaskStatus(`AI 正在合并 ${sourcePageNo} → ${targetPageNo}`, "running");
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/pages/actions/merge`, {
      method: "POST",
      body: JSON.stringify({ sourcePageNo, targetPageNo, expectedRevision, expectedSourcePageId, expectedTargetPageId })
    });
    if (!workspaceContextIsCurrent(context)) return;
    state.deck = result.deck;
    updateSplitTaskPages(result.pages);
    state.selectedPageNo = result.mergedPageNo || result.pages[0]?.pageNo || "";
    state.pendingDeletePageNo = "";
    state.mergeSourcePageNo = "";
    showNotice(result.message, "success");
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      state.pageMutationBusy = false;
      renderTask();
    }
  }
}

let activeCopyEditor = null;
let activeCopyRevision = 0;
let activeCopyKey = "";
const copyEditorDrafts = new Map();

function contentCanEdit() {
  return Boolean(state.deck?.pages?.length) && !splitTaskInProgress() && !step4TaskInProgress();
}
function rememberCopyDraft() {
  const node = $("pageDetail");
  if (node?.dataset.copyDirty !== "true" || !activeCopyKey) return;
  const draft = activeCopyEditor ? { copyBlueprint: activeCopyEditor.read() } : $("pageBodyInput") ? { title: $("pageTitleInput").value, bodyText: $("pageBodyInput").value } : $("pageTitleInput") ? {
    title: $("pageTitleInput").value, subtitle: $("pageSubtitleInput").value, displayText: $("pageDisplayInput").value
  } : null;
  if (draft) copyEditorDrafts.set(activeCopyKey, { ...draft, revision: activeCopyRevision });
}
function hasContentDrafts() {
  rememberCopyDraft();
  return [...copyEditorDrafts.keys()].some((key) => JSON.parse(key)[0] === state.selectedProject?.slug);
}


function copyEditorFields(page, displayText, rows) {
  const sourcePage = (state.deck?.pages || []).find((entry) => (entry.pageNo || entry.id) === page.pageNo) || page;
  if (state.activeStep === 2 && (sourcePage.pageRole || sourcePage.narrativeRole || sourcePage.copyBlueprint?.pageLogic || sourcePage.image2Plan?.masterRole || sourcePage.masterRole || sourcePage.designSpec?.layoutKind) === "cover") {
    // Keep other authored cover text intact; title and subtitle have explicit ownership.
    return `<label><span>标题</span><input id="pageTitleInput" value="${escapeHtml(sourcePage.copyBlueprint?.title ?? page.title ?? "")}" /></label>
      <label><span>副标题</span><input id="pageSubtitleInput" placeholder="用一句话补充本次主题" value="${escapeHtml(sourcePage.copyBlueprint?.subtitle ?? page.subtitle ?? "")}" /></label>
      <textarea id="pageDisplayInput" hidden>${escapeHtml(displayText)}</textarea>`;
  }
  if (state.activeStep === 2) {
    const draft = plainTextDraft(sourcePage);
    return `<label><span>标题</span><input id="pageTitleInput" value="${escapeHtml(draft.title)}" /></label>
      <label><span>正文</span><textarea id="pageBodyInput" class="plain-copy-body" rows="16">${escapeHtml(draft.bodyText)}</textarea></label>`;
  }
  if (sourcePage.copyBlueprint?.modules) return '<div id="structuredCopyEditor"></div>';
  return `<label><span>主标题</span><input id="pageTitleInput" value="${escapeHtml(page.title || "")}" /></label>
    <label><span>副标题</span><input id="pageSubtitleInput" value="${escapeHtml(page.subtitle || "")}" /></label>
    <label><span>展示文字</span><textarea id="pageDisplayInput" rows="${rows}">${escapeHtml(displayText)}</textarea></label>`;
}

function bindCopyEditor(page) {
  const host = $("structuredCopyEditor");
  const sourcePage = (state.deck?.pages || []).find((entry) => (entry.pageNo || entry.id) === page.pageNo) || page;
  activeCopyKey = JSON.stringify([state.selectedProject?.slug, page.pageNo]);
  const cached = copyEditorDrafts.get(activeCopyKey);
  activeCopyRevision = cached?.revision ?? Number(state.deck?.storageRevision ?? state.deck?.revision ?? 0);
  activeCopyEditor = host && sourcePage.copyBlueprint ? mountCopyBlueprintEditor(host, cached?.copyBlueprint || sourcePage.copyBlueprint, {
    sourceGrounding: cached ? { ...state.deck?.contentOutline?.sourceGrounding, status: "editor-draft", valid: false, checks: [] } : state.deck?.contentOutline?.sourceGrounding,
    sourceDocument: state.deck?.contentOutline?.sourceDocument,
    pageNo: page.pageNo,
    compact: state.activeStep === 2,
    onDirty: (dirty) => { $("pageDetail").dataset.copyDirty = String(dirty || Boolean(cached)); }
  }) : null;
  if (cached) {
    $("pageDetail").dataset.copyDirty = "true";
    if (!activeCopyEditor && $("pageTitleInput")) {
      $("pageTitleInput").value = cached.title ?? page.title ?? "";
      if ($("pageBodyInput")) {
        const draft = cached.copyBlueprint ? plainTextDraft({ copyBlueprint: cached.copyBlueprint }) : cached;
        $("pageTitleInput").value = draft.title ?? plainTextDraft(sourcePage).title;
        $("pageBodyInput").value = draft.bodyText ?? plainTextDraft(sourcePage).bodyText;
      } else {
        $("pageSubtitleInput").value = cached.subtitle ?? page.subtitle ?? "";
        $("pageDisplayInput").value = cached.displayText ?? displayTextFor(page);
      }
    }
  }
  $("pageCopyForm")?.addEventListener("input", () => { if (!activeCopyEditor) $("pageDetail").dataset.copyDirty = "true"; });
}

function renderPageDetail(page) {
  if (!page) return;
  const node = $("pageDetail");
  const pageChanged = node.dataset.pageNo !== page.pageNo || node.dataset.projectSlug !== String(state.selectedProject?.slug || "");
  if (!pageChanged && state.contentSaveBusy) return;
  if (!pageChanged && node.dataset.editorStep === String(state.activeStep) && node.dataset.copyDirty === "true") return;
  if (activeCopyEditor && node.dataset.copyDirty === "true") copyEditorDrafts.set(activeCopyKey, { copyBlueprint: activeCopyEditor.read(), revision: activeCopyRevision });
  node.dataset.pageNo = page.pageNo;
  node.dataset.projectSlug = String(state.selectedProject?.slug || "");
  node.dataset.editorStep = String(state.activeStep);
  node.dataset.copyDirty = "false";
  const imagePath = pageImagePath(page);
  const displayText = displayTextFor(page);
  $("pageNo").textContent = page.pageNo;
  node.className = "page-detail";

  if (state.activeStep === 2) {
    const canEdit = contentCanEdit();
    const key = JSON.stringify([state.selectedProject?.slug, page.pageNo]);
    const editing = canEdit && (state.contentEditPageNo === page.pageNo || copyEditorDrafts.has(key));
    activeCopyEditor = null;
    if (editing) {
      node.innerHTML = `<form id="pageCopyForm" class="page-copy-form split-copy-form">
        ${copyEditorFields(page, displayText, 9)}
        <div class="editor-actions"><button class="button primary" type="submit">保存修改</button><button id="discardContentEdit" class="button secondary" type="button">放弃修改</button><span>保存后用于制作；已有图片需要重新生成。</span></div>
      </form>`;
      $("pageCopyForm").addEventListener("submit", (event) => { event.preventDefault(); void savePageCopy(page.pageNo); });
      bindCopyEditor(page);
      $("discardContentEdit").addEventListener("click", () => {
        copyEditorDrafts.delete(key);
        node.dataset.copyDirty = "false";
        activeCopyEditor = null;
        state.contentEditPageNo = "";
        renderTask();
      });
    } else {
      node.innerHTML = `${contentPreview(page, displayText)}<div class="content-page-tools"><button id="editContentPage" class="button secondary" type="button" ${canEdit ? "" : "disabled"}>修改文字</button><button id="rewriteContentPage" class="button secondary" type="button" ${canEdit ? "" : "disabled"}>让 AI 修改</button>${!canEdit ? '<span>当前任务结束后可修改</span>' : ""}</div>`;
      $("editContentPage").addEventListener("click", () => { state.contentEditPageNo = page.pageNo; renderTask(); $("pageTitleInput")?.focus(); });
      $("rewriteContentPage").addEventListener("click", () => openContentRewrite(page));
    }
    if (pageChanged) node.scrollTop = 0;
    return;
  }

  const previousStylePath = !imagePath ? page.previousStyleImage?.path || page.previousStyleImage?.source : "";
  const previewPath = imagePath || previousStylePath;
  node.innerHTML = `<div class="review-editor">
    <div class="slide-preview-wrap">
      ${previousStylePath ? '<p class="reference-stale-preview">旧风格预览 · 新参考确认后需重新生成</p>' : ""}
      ${previewPath
        ? `<img class="generated-preview" src="${artifactUrl(previewPath)}" alt="${escapeHtml(page.title || page.pageNo)} 页面预览" />`
        : `<div class="preview-placeholder"><strong>${escapeHtml(page.title || "等待生成预览")}</strong><span>${page.generationStatus === "generating" ? "AI 正在生成当前页" : "保存文案后可生成页面预览"}</span></div>`}
    </div>
    <form id="pageCopyForm" class="page-copy-form">
      ${copyEditorFields(page, displayText, 7)}
      <div class="editor-actions"><button class="button primary" type="submit">保存本页文案</button><span>修改后请重新生成本页图片</span></div>
    </form>
  </div>`;
  $("pageCopyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void savePageCopy(page.pageNo);
  });
  bindCopyEditor(page);
  if (pageChanged) node.scrollTop = 0;
}

let contentRewriteContext = null;
let contentRewriteController = null;

function openContentRewrite(page) {
  if (hasContentDrafts()) return showNotice("请先保存或放弃未保存的修改，再让 AI 修改。", "warning");
  contentRewriteContext = { projectSlug: state.selectedProject.slug, pageNo: page.pageNo, revision: Number(state.deck.storageRevision ?? state.deck.revision ?? 0), candidate: null };
  $("contentRewriteTitle").textContent = `让 AI 修改 ${page.pageNo}`;
  $("contentRewriteInstruction").value = "";
  $("contentRewriteStatus").textContent = "先生成建议稿，采用后才会保存。";
  $("contentRewriteCandidate").hidden = true;
  $("contentRewriteActions").hidden = true;
  $("requestContentRewrite").disabled = false;
  $("requestContentRewrite").textContent = "生成修改建议";
  $("applyContentRewrite").disabled = false;
  $("closeContentRewrite").disabled = false;
  $("discardContentRewrite").disabled = false;
  $("contentRewriteDialog").showModal();
  $("contentRewriteInstruction").focus();
}
function closeContentRewrite() {
  contentRewriteController?.abort();
  contentRewriteContext = null;
  $("contentRewriteDialog").close();
}
async function requestContentRewrite() {
  const context = contentRewriteContext;
  const instruction = $("contentRewriteInstruction").value.trim();
  if (!context || !instruction) return;
  contentRewriteController?.abort();
  const controller = new AbortController();
  contentRewriteController = controller;
  context.candidate = null;
  $("requestContentRewrite").disabled = true;
  $("requestContentRewrite").textContent = "正在修改…";
  $("contentRewriteCandidate").hidden = true;
  $("contentRewriteActions").hidden = true;
  $("contentRewriteStatus").textContent = "正在按你的要求生成建议，原文保持不变。";
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/pages/${encodeURIComponent(context.pageNo)}/rewrite-preview`, {
      method: "POST", body: JSON.stringify({ instruction, expectedRevision: context.revision }), signal: controller.signal
    });
    if (contentRewriteContext !== context || controller.signal.aborted) return;
    if (!result.copyBlueprint || result.pageNo !== context.pageNo || Number(result.expectedRevision) !== context.revision) throw new Error("修改建议与当前页面不匹配，请重新生成。");
    context.candidate = result.copyBlueprint;
    $("contentRewriteCandidate").innerHTML = contentPreview({ copyBlueprint: result.copyBlueprint });
    $("contentRewriteCandidate").hidden = false;
    $("contentRewriteActions").hidden = false;
    $("contentRewriteStatus").textContent = "建议稿已生成，检查内容后可采用并保存。";
  } catch (error) {
    if (contentRewriteContext === context && error.name !== "AbortError") $("contentRewriteStatus").textContent = error.message;
  } finally {
    if (contentRewriteContext === context) {
      $("requestContentRewrite").disabled = false;
      $("requestContentRewrite").textContent = "重新生成建议";
    }
  }
}
async function applyContentRewrite() {
  const context = contentRewriteContext;
  if (!context?.candidate) return;
  $("applyContentRewrite").disabled = true;
  $("requestContentRewrite").disabled = true;
  $("closeContentRewrite").disabled = true;
  $("discardContentRewrite").disabled = true;
  $("contentRewriteStatus").textContent = "正在保存…";
  try {
    const result = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/pages/${encodeURIComponent(context.pageNo)}`, {
      method: "POST", body: JSON.stringify({ copyEditMode: "structured", copyBlueprint: context.candidate, expectedRevision: context.revision })
    });
    if (state.selectedProject?.slug === context.projectSlug) {
      state.deck = result.deck;
      state.contentEditPageNo = "";
      $("pageDetail").dataset.copyDirty = "false";
      activeCopyEditor = null;
      renderTask();
    }
    closeContentRewrite();
    showNotice(`${context.pageNo} 修改已保存`, "success");
  } catch (error) {
    $("contentRewriteStatus").textContent = error.message;
  } finally {
    $("applyContentRewrite").disabled = false;
    $("requestContentRewrite").disabled = false;
    $("closeContentRewrite").disabled = false;
    $("discardContentRewrite").disabled = false;
  }
}

async function savePageCopy(pageNo) {
  if (!state.selectedProject || state.contentSaveBusy) return;
  state.contentSaveBusy = true;
  const previousDeck = state.deck;
  const formControls = [...($("pageCopyForm")?.querySelectorAll("input, textarea, button") || [])];
  formControls.forEach((control) => { control.disabled = true; });
  const savingProjectSlug = state.selectedProject.slug;
  const savingCopyKey = activeCopyKey;
  const submit = $("pageCopyForm")?.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = true;
    submit.textContent = "正在保存";
  }
  try {
    const { deck } = await api(`/api/v2/projects/${encodeURIComponent(savingProjectSlug)}/pages/${encodeURIComponent(pageNo)}`, {
      method: "POST",
      body: JSON.stringify({
        ...(activeCopyEditor ? { copyEditMode: "structured", copyBlueprint: activeCopyEditor.read() } : $("pageBodyInput") ? {
          copyEditMode: "plain", title: $("pageTitleInput").value, bodyText: $("pageBodyInput").value
        } : {
          title: $("pageTitleInput").value,
          subtitle: $("pageSubtitleInput").value,
          displayText: $("pageDisplayInput").value
        }),
        expectedRevision: activeCopyRevision
      })
    });
    copyEditorDrafts.delete(savingCopyKey);
    for (const [key, draft] of copyEditorDrafts) {
      const [slug, number] = JSON.parse(key);
      if (slug !== savingProjectSlug || draft.revision !== Number(previousDeck.storageRevision ?? previousDeck.revision ?? 0)) continue;
      const before = previousDeck.pages.find((p) => (p.pageNo || p.id) === number);
      const after = deck.pages.find((p) => (p.pageNo || p.id) === number);
      if (JSON.stringify(before) === JSON.stringify(after)) draft.revision = Number(deck.storageRevision ?? deck.revision ?? 0);
    }
    if (state.selectedProject?.slug !== savingProjectSlug) {
      showNotice(`${pageNo} 文案已保存到原项目`, "success");
      return;
    }
    state.deck = deck;
    state.contentEditPageNo = "";
    if (activeCopyKey === savingCopyKey) {
      $("pageDetail").dataset.copyDirty = "false";
      activeCopyEditor = null;
    }
    showNotice(`${pageNo} 文案已保存`, "success");
    state.contentSaveBusy = false;
    renderTask();
    return true;
  } catch (error) {
    showNotice(error.message, "error");
    if (submit) {
      submit.disabled = false;
      submit.textContent = state.activeStep === 2 ? "保存修改" : "保存本页文案";
    }
  } finally {
    state.contentSaveBusy = false;
    formControls.forEach((control) => { control.disabled = false; });
  }
}

function absorbEvent(event) {
  if (!state.task) return;
  const wasSettled = isTaskSettled(state.task);
  state.task = reduceTaskLifecycle(state.task, event);
  state.task = reduceTaskDomain(state.task, event);
  const payload = event.payload || {};
  if (!wasSettled && state.task.status === "cancelled" && ["generation", "image2-compile"].includes(state.task.kind) && state.selectedProject?.slug) void loadDeck(state.selectedProject.slug);
  if (event.type === "split.completed") {
    state.selectedPageNo = state.task.pages?.[0]?.pageNo || state.selectedPageNo;
    const resultProjectSlug = payload.projectSlug || state.selectedProject?.slug || "";
    if (resultProjectSlug && state.selectedProject?.slug !== resultProjectSlug) {
      state.selectedProject = {
        ...state.selectedProject,
        slug: resultProjectSlug,
        title: payload.deck?.title || state.selectedProject?.title || "未命名演示文稿"
      };
    }
    if (resultProjectSlug) void loadDeck(resultProjectSlug);
  }
  if (isTaskDomainEvent(event)) {
    if (!state.selectedPageNo && event.type.startsWith("generation.page.")) state.selectedPageNo = payload.pageNo || "";
    if (!state.selectedPageNo && event.type.startsWith("split.page.")) state.selectedPageNo = payload.page?.pageNo || payload.pageNo || "";
    if (["image2.compile.completed", "generation.completed"].includes(event.type) && state.selectedProject?.slug) {
      void loadDeck(state.selectedProject.slug).then(() => {
        if (event.type === "generation.completed" && state.activeStep === 4) configurePageWorkspace(4);
      });
    }
  }
  if (["qa.completed", "qa.issue.decision"].includes(event.type)) rememberQaTask(state.task);
  renderTask();
  updateActions();
}

function generationStopAvailable(task = null) {
  return state.activeStep === 4 && ["generation", "image2-compile"].includes(task?.kind)
    && ["queued", "running"].includes(task?.status) && Boolean(task.batchId);
}

async function stopImageGeneration() {
  const task = taskForActiveStep();
  const projectSlug = state.selectedProject?.slug;
  if (!projectSlug || !generationStopAvailable(task) || generationControlBusy || task.phase === "cancelling") return;
  generationControlBusy = true;
  updateActions();
  try {
    const { task: updated } = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(task.taskId)}/cancel`, { method: "POST" });
    if (state.selectedProject?.slug !== projectSlug || state.task?.taskId !== task.taskId) return;
    state.task = updated;
    state.tasks = state.tasks.map((entry) => entry.taskId === updated.taskId ? updated : entry);
    if (isTaskSettled(updated)) {
      stopTaskStatusPolling();
      await loadDeck(projectSlug);
    } else subscribe(projectSlug, updated.taskId);
    showNotice(updated.status === "completed" ? "任务已完成，图片已保留" : updated.status === "cancelled" ? "生成已停止，已生成图片已保留" : "正在停止后台生成，已生成图片会保留", "neutral");
  } catch (error) { showNotice(error.message, "error"); }
  finally { generationControlBusy = false; renderTask(); updateActions(); }
}

function stopTaskStatusPolling() { taskObserver.stop(); }
function startTaskStatusPolling(projectSlug, taskId) { return taskObserver.start(projectSlug, taskId); }
function subscribe(projectSlug, taskId) {
  splitConnectionIssue = false;
  state.eventSource?.close();
  state.eventSource = startTaskStatusPolling(projectSlug, taskId);
}

let splitControlBusy = false;
async function controlSplitTask() {
  const task = taskForActiveStep();
  const control = splitLifecycleControl(task, splitControlBusy);
  const projectSlug = state.selectedProject?.slug;
  if (!projectSlug || !control || control.disabled) return;
  splitControlBusy = true;
  renderStepActionDock();
  try {
    const { task: updated } = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(task.taskId)}/${control.action}`, { method: "POST" });
    if (state.selectedProject?.slug !== projectSlug) return;
    state.task = updated;
    state.tasks = state.tasks.map((entry) => entry.taskId === updated.taskId ? updated : entry);
    if (isTaskSettled(updated)) stopTaskStatusPolling();
    else subscribe(projectSlug, updated.taskId);
    showNotice(control.action === "cancel"
      ? updated.status === "completed" ? "任务已完成，已提交的文案结果已保留"
        : updated.status === "cancelled" ? "拆页已取消，原文与检查点已保留，可继续原任务"
        : "取消请求已保存，正在确认模型停止状态"
      : "已继续原拆页任务，将复用可用的文案检查点", "neutral");
    renderTask();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    splitControlBusy = false;
    updateActions();
    renderStepActionDock();
  }
}

async function hydrateTask(projectSlug, taskId, { navigate = false } = {}) {
  const loadEpoch = workspaceLoadEpoch;
  const { task } = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(taskId)}`);
  if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug || !tasksAfterHistoryRestore([task], state.deck).length) return;
  state.task = task;
  rememberQaTask(task);
  state.selectedPageNo = task.pages?.[0]?.pageNo || state.deck?.pages?.[0]?.pageNo || "";
  if (navigate) setActiveStep(task.kind === "split" ? 2 : 4, { force: true });
  else renderTask();
}

function advanceWorkspaceEpoch() {
  workspaceLoadEpoch++;
  state.anchorBusy = "";
  state.generationStartError = "";
  state.qaActionBusy = "";
  state.pageMutationBusy = false;
  return workspaceLoadEpoch;
}

function workspaceContextIsCurrent(context) {
  return context.epoch === workspaceLoadEpoch && context.projectSlug === state.selectedProject?.slug;
}

async function startTask(kind, options = {}, context = { projectSlug: state.selectedProject?.slug, epoch: workspaceLoadEpoch }) {
  if (!workspaceContextIsCurrent(context)) return;
  if (state.taskStartBusy) return;
  const project = state.selectedProject;
  if (!project) {
    showNotice("请先选择项目。", "warning");
    return;
  }
  if (["image2-compile", "generation", "qa-export"].includes(kind) && !hasConfirmedStyle() && !(kind === "image2-compile" && options.referenceBundleId)) {
    setActiveStep(3, { force: true });
    showNotice("风格尚未成功锁定，请重新选择后再试。", "warning");
    return;
  }
  const endpoints = {
    split: "/api/v2/tasks/split/from-project",
    "image2-compile": "/api/v2/tasks/image2-compile/from-project",
    generation: "/api/v2/tasks/generate/from-project",
    "qa-export": "/api/v2/tasks/qa-export/from-project"
  };
  state.taskStartBusy = kind;
  state.generationStartError = "";
  setActiveStep(kind === "split" ? 2 : 4, { force: true });
  setTaskStatus("正在创建任务", "running");
  updateActions();
  try {
    const { task, reused, message } = await api(endpoints[kind], {
      method: "POST",
      body: JSON.stringify({
        projectSlug: project.slug,
        ...(kind === "split" ? {
          targetPageCount: Number($("targetPageCount").value),
          contentDetailMode: state.contentDetailMode,
          narrativeMode: state.narrativeMode
        } : {}),
        scope: options.scope || "image-needed",
        phase: options.phase || "full",
        pageIds: options.pageIds || [],
        referenceBundleId: options.referenceBundleId,
        referenceVersion: options.referenceVersion
      })
    });
    if (!workspaceContextIsCurrent(context)) return;
    if (reused) showNotice(message || "正在继续已有拆页任务，使用该任务原有设置", "info");
    await hydrateTask(project.slug, task.taskId);
    if (!workspaceContextIsCurrent(context)) return;
    subscribe(project.slug, task.taskId);
    await loadTaskHistory(project.slug, { hydrateLatest: false });
  } catch (error) {
    if (!workspaceContextIsCurrent(context)) return;
    setTaskStatus("无法启动", "failed");
    if (["image2-compile", "generation"].includes(kind)) state.generationStartError = error.message;
    showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      if (state.taskStartBusy === kind) state.taskStartBusy = "";
      renderTask();
      updateActions();
    }
  }
}

async function loadDeck(projectSlug) {
  if (!projectSlug) return;
  const loadEpoch = workspaceLoadEpoch;
  try {
    const { deck } = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/deck`);
    if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
    state.deck = deck || null;
    const referenceId = state.deck && Object.hasOwn(state.deck, "styleReference")
      ? state.deck.styleReference?.bundleId || null : state.deck?.styleProfile?.referenceBundleId || null;
    if (referenceProjectSlug !== projectSlug || referenceUpload.get()?.id !== referenceId || (state.task?.input?.referenceBundleId === referenceId && isTaskSettled(state.task))) {
      referenceProjectSlug = projectSlug;
      await referenceUpload.load(referenceId);
      if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
    }
    state.narrativeMode = state.deck?.styleProfile?.narrativeMode || state.narrativeMode;
    state.contentDetailMode = state.deck?.styleProfile?.contentDetailMode || "focus";
    if (state.deck?.styleProfile?.targetPageCount) {
      $("targetPageCount").value = state.deck.styleProfile.targetPageCount;
      $("targetPageCount").disabled = false;
    }
    state.pendingStyleId = state.deck?.styleProfile?.id || "";
    if (!hasConfirmedStyle() && customReferencePack()) state.pendingStyleId = customReferencePack().id;
    if (state.activeStep === 4) configurePageWorkspace(4);
  } catch {
    if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
    state.deck = null;
    state.pendingStyleId = "";
  }
  renderStylePanel();
  renderNarratives();
  renderContentDetails();
  updateSplitButtonText();
  renderSplitConfigurationSummary();
  renderTask();
  updateActions();
}

function renderStylePanel() {
  const options = $("styleOptions");
  if (!options) return;
  options.replaceChildren($("customStyleOption"));
  renderCustomStyleOption();
  const savedStyleId = state.deck?.styleProfile?.id || "";
  const selectedPack = activeStylePack();
  const selectedId = selectedPack?.id || "";
  const styleAction = currentStyleGenerationAction(selectedPack);
  if (styleAction.mode === "running") {
    $("styleSavedState").textContent = `正在生成：${selectedPack?.name || selectedId}`;
  } else if (selectedId && selectedId !== savedStyleId) {
    $("styleSavedState").textContent = `待确认：${selectedPack?.name || selectedId}`;
  } else if (selectedId && hasConfirmedStyle()) {
    $("styleSavedState").textContent = `已锁定：${state.deck.styleProfile.name || savedStyleId}`;
  } else {
    $("styleSavedState").textContent = "请选择风格";
  }
  $("confirmStyleGenerate").textContent = styleAction.label;
  const template = $("styleTemplate");
  stylePacks.forEach((pack) => {
    const fragment = template.content.cloneNode(true);
    const button = fragment.querySelector(".style-option");
    button.classList.toggle("selected", pack.id === selectedId);
    const image = button.querySelector(".style-preview");
    image.src = styleMasterSlideUrl(pack, 0);
    image.alt = `${pack.name} 封面预览`;
    button.querySelector(".style-master-count").textContent = (pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? "风格包 · 6 类页面" : "6 页母版";
    if ((pack.sourceImageNumber && pack.masterPreviewCount !== 6)) {
      button.querySelector(".style-option-meta em").textContent = "参考图 + 页面规则";
      button.querySelector(".style-option-meta > span").textContent = "查看风格";
    }
    button.querySelector("strong").textContent = pack.name;
    button.querySelector("small").textContent = pack.description;
    button.setAttribute("aria-label", `查看并选择${pack.name}${(pack.sourceImageNumber && pack.masterPreviewCount !== 6) ? "风格包" : "六页母版"}`);
    button.addEventListener("click", () => {
      void openStyleMasterDialog(pack);
    });
    options.append(button);
  });
}

async function saveStylePack(pack, context = { projectSlug: state.selectedProject?.slug, epoch: workspaceLoadEpoch }) {
  if (!state.selectedProject) throw new Error("请先选择项目");
  if (!workspaceContextIsCurrent(context)) return false;
  $("styleSavedState").textContent = "正在锁定母版";
  const { deck } = await api(`/api/v2/projects/${encodeURIComponent(context.projectSlug)}/style`, {
    method: "POST",
    body: JSON.stringify({
      styleProfile: {
        id: pack.id,
        name: pack.name,
        promptBase: pack.promptBase,
        primary: pack.primary,
        referenceBundleId: pack.referenceBundleId,
        referenceVersion: pack.referenceVersion
      }
    })
  });
  if (!workspaceContextIsCurrent(context)) return false;
  state.deck = deck;
  state.pendingStyleId = pack.id;
  renderStylePanel();
  updateActions();
  return true;
}

async function confirmStyleAndGenerate() {
  const context = { projectSlug: state.selectedProject?.slug, epoch: workspaceLoadEpoch };
  const pack = activeStylePack();
  if (!pack) {
    showNotice("请先选择一个风格母版。", "warning");
    return;
  }
  const button = $("confirmStyleGenerate");
  const action = currentStyleGenerationAction(pack);
  button.disabled = true;
  button.textContent = action.busyLabel;
  renderStepActionDock();
  try {
    if (["resume", "running"].includes(action.mode)) {
      setActiveStep(4, { force: true });
      return;
    }
    if (!pack.custom && !await saveStylePack(pack, context)) return;
    if (!workspaceContextIsCurrent(context)) return;
    setActiveStep(4, { force: true });
    await startTask("image2-compile", pack.custom ? { referenceBundleId: pack.referenceBundleId, referenceVersion: pack.referenceVersion } : {}, context);
  } catch (error) {
    if (workspaceContextIsCurrent(context)) showNotice(error.message, "error");
  } finally {
    if (workspaceContextIsCurrent(context)) {
      button.textContent = currentStyleGenerationAction(pack).label;
      updateActions();
    }
  }
}

function openDrawer() {
  $("projectDrawer").classList.add("open");
  $("projectDrawer").setAttribute("aria-hidden", "false");
  $("drawerBackdrop").hidden = false;
  document.body.classList.add("drawer-open");
}

function closeDrawer() {
  $("projectDrawer").classList.remove("open");
  $("projectDrawer").setAttribute("aria-hidden", "true");
  $("drawerBackdrop").hidden = true;
  document.body.classList.remove("drawer-open");
}

function renderProjects(projects = []) {
  projectList.replaceChildren();
  $("clearAllProjects").disabled = !projects.length || state.projectDeletionBusy;
  const query = state.projectQuery.trim().toLocaleLowerCase("zh-CN");
  const filtered = query
    ? projects.filter((project) => `${project.title || ""} ${project.style || ""}`.toLocaleLowerCase("zh-CN").includes(query))
    : projects;
  $("projectCount").textContent = query ? `${filtered.length} / ${projects.length}` : `${projects.length}`;
  if (!filtered.length) {
    projectList.innerHTML = '<div class="empty-state">没有匹配的项目。</div>';
    $("projectListFooter").hidden = true;
    return;
  }
  let visible = filtered;
  if (!query && !state.projectsExpanded && filtered.length > collapsedProjectLimit) {
    visible = visibleProjectsWithSelection(filtered, state.selectedProject?.slug, collapsedProjectLimit);
  }
  const template = $("projectTemplate");
  visible.forEach((project) => {
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector(".project-row");
    row.classList.toggle("selected", project.slug === state.selectedProject?.slug);
    fragment.querySelector(".project-title").textContent = project.title || "未命名演示文稿";
    fragment.querySelector(".project-meta").textContent = `${project.pages || 0} 页 · ${project.style || "未确认风格"}`;
    fragment.querySelector(".select-project").addEventListener("click", () => { void selectProject(project); });
    fragment.querySelector(".history-project").disabled = state.projectDeletionBusy;
    fragment.querySelector(".history-project").addEventListener("click", () => projectHistoryDialog.open(project));
    fragment.querySelector(".delete-project").disabled = state.projectDeletionBusy;
    fragment.querySelector(".delete-project").addEventListener("click", () => openProjectDeleteDialog({ mode: "single", project }));
    projectList.append(fragment);
  });
  const footer = $("projectListFooter");
  footer.replaceChildren();
  footer.hidden = filtered.length <= collapsedProjectLimit || Boolean(query);
  if (!footer.hidden) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary project-list-toggle";
    button.textContent = state.projectsExpanded ? "收起" : `查看全部 ${filtered.length} 个项目`;
    button.addEventListener("click", () => {
      state.projectsExpanded = !state.projectsExpanded;
      renderProjects(projects);
    });
    footer.append(button);
  }
}

function openProjectDeleteDialog({ mode, project = null }) {
  if (state.projectDeletionBusy) return;
  const count = window.__projects?.length || 0;
  if (mode === "all" && !count) return;
  state.projectDeletion = { mode, project };
  const isAll = mode === "all";
  $("projectDeleteTitle").textContent = isAll ? `清空全部 ${count} 个项目？` : `删除“${project?.title || "未命名项目"}”？`;
  $("projectDeleteDescription").textContent = isAll
    ? "全部项目、生成文件、上传源文件和项目归档将移入本地回收目录，任务审计记录保留。运行中的项目不能清空；目前恢复需从回收目录手动处理。"
    : "该项目及生成文件将移入本地回收目录，上传源文件和任务审计记录保留。运行中的项目不能删除；目前恢复需从回收目录手动处理。";
  $("confirmProjectDelete").textContent = isAll ? "确认清空全部" : "确认删除";
  $("projectDeleteDialog").showModal();
}

function closeProjectDeleteDialog() {
  if (state.projectDeletionBusy) return;
  state.projectDeletion = null;
  $("projectDeleteDialog").close();
}

function resetWorkspaceAfterProjectDeletion() {
  advanceWorkspaceEpoch();
  cancelPageCountAnalysis();
  state.eventSource?.close();
  state.eventSource = null;
  state.selectedProject = null;
  void referenceUpload.load(null);
  referenceProjectSlug = "";
  state.task = null;
  state.qaReviewTask = null;
  state.tasks = [];
  state.deck = null;
  state.document = null;
  state.recommendation = null;
  state.pendingStyleId = "";
  state.selectedPageNo = "";
  state.mergeSourcePageNo = "";
  state.pendingDeletePageNo = "";
  forgetLastProject();
  $("chooseDocument").textContent = "选择文档";
  $("uploadHint").textContent = "文件保存在本机，最大 20 MB；使用 AI 时，相关内容会发送给所选模型服务。";
  $("targetPageCount").value = "";
  $("targetPageCount").disabled = true;
  setDocumentState("等待上传");
  renderDocumentBrief();
  renderTaskHistory([]);
  updateSplitButtonText();
  setActiveStep(1, { force: true });
}

async function confirmProjectDeletion() {
  const pending = state.projectDeletion;
  if (!pending || state.projectDeletionBusy) return;
  state.projectDeletionBusy = true;
  $("confirmProjectDelete").disabled = true;
  $("cancelProjectDelete").disabled = true;
  renderProjects(window.__projects || []);
  try {
    const isAll = pending.mode === "all";
    await api(isAll ? "/api/v2/projects" : `/api/v2/projects/${encodeURIComponent(pending.project.slug)}`, {
      method: "DELETE",
      ...(isAll ? { body: JSON.stringify({ confirm: "DELETE_ALL_PROJECTS" }) } : {})
    });
    if (isAll || state.selectedProject?.slug === pending.project.slug) resetWorkspaceAfterProjectDeletion();
    state.projectDeletion = null;
    $("projectDeleteDialog").close();
    const projects = await loadProjects();
    if (!projects.length) renderTaskHistory([]);
    showNotice(isAll ? "全部项目已移入本地回收目录，审计记录已保留" : "项目已移入本地回收目录，源文件与审计记录已保留", "success");
  } catch (error) {
    showNotice(`删除失败：${error.message}`, "error");
  } finally {
    state.projectDeletionBusy = false;
    $("confirmProjectDelete").disabled = false;
    $("cancelProjectDelete").disabled = false;
    renderProjects(window.__projects || []);
  }
}

function applyHistoryRestoration({ deck }, project) {
  advanceWorkspaceEpoch();
  cancelPageCountAnalysis();
  stopTaskStatusPolling();
  state.eventSource?.close(); state.eventSource = null;
  exportPreviewController.dispose();
  state.task = null; state.tasks = []; state.qaReviewTask = null; state.taskStartBusy = "";
  state.selectedProject = { ...project, title: deck.title || project.title, pages: deck.pages?.length || 0 };
  state.deck = deck;
  state.document = null; state.recommendation = null;
  state.selectedPageNo = deck.pages?.[0]?.pageNo || "";
  state.mergeSourcePageNo = ""; state.pendingDeletePageNo = "";
  state.pendingStyleId = deck.styleProfile?.id || "";
  state.narrativeMode = deck.styleProfile?.narrativeMode || "narrative";
  state.contentDetailMode = deck.styleProfile?.contentDetailMode || "focus";
  for (const key of copyEditorDrafts.keys()) if (JSON.parse(key)[0] === project.slug) copyEditorDrafts.delete(key);
  activeCopyEditor = null; activeCopyKey = ""; activeCopyRevision = 0;
  $("pageDetail").dataset.copyDirty = "false";
  $("targetPageCount").value = deck.styleProfile?.targetPageCount || deck.pages?.length || "";
  $("targetPageCount").disabled = false;
  rememberProject(state.selectedProject);
  window.__projects = (window.__projects || []).map((entry) => entry.slug === project.slug ? state.selectedProject : entry);
  renderProjects(window.__projects); renderTaskHistory([]);
  renderStylePanel(); renderNarratives(); renderContentDetails(); renderDocumentBrief();
  setActiveStep(2, { force: true }); closeDrawer();
  showNotice("历史文案与配置已恢复为新版本。请检查文案，再重新确认风格、生成并验收；旧导出不代表当前版本已完成。", "success");
}

function renderTaskHistory(tasks = state.tasks) {
  const history = $("taskHistory");
  history.replaceChildren();
  if (!state.selectedProject) {
    history.className = "task-history empty-state";
    history.textContent = "选择项目后显示任务记录。";
    return;
  }
  if (!tasks.length) {
    history.className = "task-history empty-state";
    history.textContent = state.deck?.historyRestore ? "恢复前任务记录仍保留为审计，不作为当前版本完成依据。" : "这个项目还没有 V2 任务记录。";
    return;
  }
  history.className = "task-history";
  tasks.forEach((task) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-history-button ${task.taskId === state.task?.taskId ? "selected" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(taskLabel(task))}</strong><span>${escapeHtml(taskStateLabel(task))} · ${task.completed || 0}/${task.total || "-"}</span>`;
    button.addEventListener("click", async () => {
      await hydrateTask(state.selectedProject.slug, task.taskId, { navigate: true });
      if (["queued", "running"].includes(task.status)) subscribe(state.selectedProject.slug, task.taskId);
      closeDrawer();
      renderTaskHistory();
    });
    history.append(button);
  });
}

async function loadTaskHistory(projectSlug, { hydrateLatest = true } = {}) {
  const loadEpoch = workspaceLoadEpoch;
  try {
    const { tasks } = await api(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks?limit=10`);
    if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
    state.tasks = tasksAfterHistoryRestore(tasks || [], state.deck);
    const latestQaTask = state.tasks.find((task) => task.kind === "qa-export" && task.qa);
    if (latestQaTask && (!state.qaReviewTask || state.qaReviewTask.taskId !== latestQaTask.taskId)) state.qaReviewTask = latestQaTask;
    if (hydrateLatest && state.tasks[0]) {
      const latestTask = state.tasks[0];
      await hydrateTask(projectSlug, latestTask.taskId);
      if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
      if (["queued", "running"].includes(latestTask.status)) subscribe(projectSlug, latestTask.taskId);
    }
    renderTaskHistory();
  } catch (error) {
    if (loadEpoch !== workspaceLoadEpoch || state.selectedProject?.slug !== projectSlug) return;
    $("taskHistory").className = "task-history empty-state error";
    $("taskHistory").textContent = `无法恢复任务：${error.message}`;
  }
}

async function selectProject(project) {
  advanceWorkspaceEpoch();
  cancelPageCountAnalysis();
  state.documentSplitBusy = false;
  state.taskStartBusy = "";
  state.document = null;
  state.recommendation = null;
  stopTaskStatusPolling();
  state.selectedProject = project;
  await referenceUpload.load(null);
  rememberProject(project);
  state.task = null;
  state.tasks = [];
  state.qaReviewTask = null;
  state.deck = null;
  state.pendingStyleId = "";
  state.selectedPageNo = "";
  state.mergeSourcePageNo = "";
  state.pendingDeletePageNo = "";
  state.eventSource?.close();
  state.eventSource = null;
  renderProjects(window.__projects || []);
  // The persisted restore boundary must be known before considering old tasks.
  await loadDeck(project.slug);
  if (state.selectedProject?.slug !== project.slug) return;
  await loadTaskHistory(project.slug);
  const latestKind = state.task?.kind;
  const inferredStep = latestKind === "split" && ["queued", "running", "paused"].includes(state.task?.status)
    ? 2
    : ["generation", "qa-export", "direct-export"].includes(latestKind) || hasConfirmedStyle()
      ? 4
      : state.deck?.historyRestore && !state.tasks.length ? 2 : state.deck?.pages?.length ? 3 : 1;
  setActiveStep(inferredStep, { force: true });
  closeDrawer();
}

async function loadProjects() {
  try {
    const payload = await api("/api/v2/projects");
    window.__projects = payload.projects || [];
    renderProjects(window.__projects);
    return window.__projects;
  } catch (error) {
    projectList.innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
    return [];
  }
}

async function restoreLastProject(projects = []) {
  const loadEpoch = workspaceLoadEpoch;
  const storedSlug = readLastProjectSlug();
  let project = findRestorableProject(projects, storedSlug);
  if (storedSlug && !project) {
    forgetLastProject();
  }
  if (!project) {
    try {
      const { deck } = await api("/api/v2/deck/latest");
      project = findProjectForDeck(projects, deck);
    } catch {
      // A missing latest-deck fallback should not block the project list.
    }
  }
  if (!project || loadEpoch !== workspaceLoadEpoch) return false;
  try {
    await selectProject(project);
    return true;
  } catch (error) {
    forgetLastProject();
    state.selectedProject = null;
    renderProjects(projects);
    showNotice(`上次项目恢复失败：${error.message}`, "warning");
    return false;
  }
}

async function refreshEngineConnection() {
  try {
    const health = await api("/api/v2/health");
    setEngineStatus(health.v1 === "connected" ? "本地引擎已连接" : "本地引擎不可用", health.v1 === "connected" ? "connected" : "failed");
  } catch {
    setEngineStatus("本地引擎未连接", "failed");
  }
}

async function bootstrap() {
  const loadEpoch = workspaceLoadEpoch;
  await refreshEngineConnection();
  renderNarratives();
  renderContentDetails();
  renderTaskHistory([]);
  setActiveStep(1, { force: true });
  await loadDataMigrationStatus();
  const projects = await loadProjects();
  if (loadEpoch !== workspaceLoadEpoch) return;
  await restoreLastProject(projects);
  if (!state.selectedProject) await referenceUpload.restoreDraft();
}

document.querySelectorAll(".step-button").forEach((button) => {
  button.addEventListener("click", () => setActiveStep(Number(button.dataset.step)));
});
$("openProjects").addEventListener("click", openDrawer);
$("closeProjects").addEventListener("click", closeDrawer);
$("drawerBackdrop").addEventListener("click", closeDrawer);
$("refreshProjects").addEventListener("click", () => { void loadProjects(); });
$("runDataMigration").addEventListener("click", () => { void runDataMigration(); });
$("clearAllProjects").addEventListener("click", () => openProjectDeleteDialog({ mode: "all" }));
$("cancelProjectDelete").addEventListener("click", closeProjectDeleteDialog);
$("confirmProjectDelete").addEventListener("click", () => { void confirmProjectDeletion(); });
$("projectDeleteDialog").addEventListener("click", (event) => {
  if (event.target === $("projectDeleteDialog")) closeProjectDeleteDialog();
});
$("projectSearch").addEventListener("input", (event) => {
  state.projectQuery = event.target.value;
  renderProjects(window.__projects || []);
});
$("chooseDocument").addEventListener("click", () => $("documentFile").click());
$("documentFile").addEventListener("change", (event) => { void uploadDocument(event.target.files?.[0]); });
$("targetPageCount").addEventListener("input", () => {
  updateSplitButtonText();
  updateActions();
});
$("splitDocument").addEventListener("click", () => { void startDocumentSplit(); });
$("startSplit").addEventListener("click", () => { void startTask("split"); });
$("contentRewriteForm").addEventListener("submit", (event) => { event.preventDefault(); void requestContentRewrite(); });
$("closeContentRewrite").addEventListener("click", closeContentRewrite);
$("discardContentRewrite").addEventListener("click", closeContentRewrite);
$("applyContentRewrite").addEventListener("click", () => { void applyContentRewrite(); });
$("contentRewriteDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!$("closeContentRewrite").disabled) closeContentRewrite(); });
document.querySelectorAll("[data-content-preset]").forEach((button) => button.addEventListener("click", () => { $("contentRewriteInstruction").value = button.dataset.contentPreset; $("contentRewriteInstruction").focus(); }));
$("adjustContent").addEventListener("click", () => {
  if (hasContentDrafts()) return showNotice("请先保存或放弃未保存的修改。", "warning");
  $("manageContentPages").disabled = !contentCanEdit();
  $("restartContent").disabled = $("startSplit").disabled || !contentCanEdit();
  $("contentSettingsFields").hidden = true;
  $("contentAdjustDialog").showModal();
});
$("closeContentAdjust").addEventListener("click", () => $("contentAdjustDialog").close());
$("changeContentSettings").addEventListener("click", () => {
  $("contentPageCount").value = Number($("targetPageCount").value) || state.deck.pages.length;
  $("contentDetailChoice").value = state.contentDetailMode;
  $("contentNarrativeChoice").innerHTML = narrativeOptions.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join("");
  $("contentNarrativeChoice").value = state.narrativeMode;
  $("contentSettingsFields").hidden = false;
  $("contentPageCount").focus();
});
$("applyContentSettings").addEventListener("click", () => {
  if (!contentCanEdit() || !$("contentPageCount").reportValidity()) return;
  $("targetPageCount").value = $("contentPageCount").value;
  state.contentDetailMode = $("contentDetailChoice").value;
  state.narrativeMode = $("contentNarrativeChoice").value;
  renderNarratives(); renderContentDetails();
  $("contentAdjustDialog").close();
  state.contentExpandedPageNo = ""; state.contentEditPageNo = "";
  void startTask("split");
});
$("finishContentStructure").addEventListener("click", () => { state.contentStructureMode = false; state.mergeSourcePageNo = ""; state.pendingDeletePageNo = ""; renderTask(); });
$("manageContentPages").addEventListener("click", () => { state.contentStructureMode = !state.contentStructureMode; $("contentAdjustDialog").close(); renderTask(); });
$("restartContent").addEventListener("click", () => { $("contentAdjustDialog").close(); state.contentExpandedPageNo = ""; state.contentEditPageNo = ""; void startTask("split"); });
$("controlSplit").addEventListener("click", () => { void controlSplitTask(); });
$("goStyle").addEventListener("click", () => setActiveStep(3));
$("startGeneration").addEventListener("click", () => { void startTask("generation"); });
$("startQaExport").addEventListener("click", () => { void startTask("qa-export"); });
$("stopGeneration").addEventListener("click", () => { void stopImageGeneration(); });
$("confirmStyleGenerate").addEventListener("click", () => { void confirmStyleAndGenerate(); });
$("stepDockPrimary").addEventListener("click", (event) => {
  const targetStep = Number(event.currentTarget.dataset.targetStep || 0);
  if (targetStep) {
    setActiveStep(targetStep, { force: targetStep === 4 });
    return;
  }
  const source = $(event.currentTarget.dataset.sourceAction);
  if (source && !source.disabled) source.click();
});
$("stepDockSecondary").addEventListener("click", (event) => {
  const targetStep = Number(event.currentTarget.dataset.targetStep || 0);
  if (targetStep) {
    setActiveStep(targetStep);
    return;
  }
  const source = $(event.currentTarget.dataset.sourceAction);
  if (source && !source.disabled) source.click();
});
$("generateRemainingPages").addEventListener("click", () => {
  if (image2MutationInProgress()) return;
  const failure = image2GenerationFailure(taskForActiveStep());
  if (failure?.compileFailed) {
    if (failure.contentNeedsAdjustment) setActiveStep(2, { force: true });
    else void startTask("image2-compile", state.task?.input?.referenceBundleId ? {
      referenceBundleId: state.task.input.referenceBundleId, referenceVersion: state.task.input.referenceVersion
    } : {});
    return;
  }
  if (!image2AnchorsConfirmed()) {
    const missingAnchorKind = missingImage2AnchorKind();
    if (canGenerateMissingImage2Anchor(missingAnchorKind)) {
      void generateMissingImage2Anchor(missingAnchorKind);
      return;
    }
    showNotice("请先确认封面与正文视觉母版", "error");
    return;
  }
  if (state.task?.kind === "direct-export" && state.task?.export?.path) {
    downloadArtifact(state.task.export.path);
    return;
  }
  if (state.task?.kind === "generation" && state.task?.status === "completed" && state.task?.operation === "qa-batch-regeneration") {
    void startTask("qa-export", { pageIds: state.task.input?.pageIds || state.task.activePageNos || [] });
    return;
  }
  if (state.task?.operation === "qa-batch-regeneration" && ["paused", "failed", "cancelled"].includes(state.task.status)) {
    void startSelectedQaFixes();
    return;
  }
  const regeneratedPageNo = singlePageRegenerationNo(state.task);
  if (state.task?.kind === "generation" && state.task?.status === "completed" && regeneratedPageNo) {
    void startTask("qa-export", { pageIds: [regeneratedPageNo] });
    return;
  }
  const qaTask = qaTaskForReview();
  if (state.task?.kind === "qa-export" && qaTask?.qa) {
    if (qaTask.export?.path) {
      downloadArtifact(qaTask.export.path);
      return;
    }
    const review = qaDecisionState(qaTask.qa);
    if (review.fixGroups.length) void startSelectedQaFixes();
    else void exportReviewedQaTask();
    return;
  }
  const missingPageIds = missingImagePageIdsForState({
    task: taskForActiveStep(),
    deckPages: state.deck?.pages || [],
    imagePath: pageImagePath
  });
  void startTask(missingPageIds.length ? "generation" : "qa-export", missingPageIds.length
    ? { phase: "remaining", pageIds: missingPageIds }
    : {});
});
$("directExportPptx").addEventListener("click", () => { void startDirectExport(); });
$("adjustImage2Anchors").addEventListener("click", () => {
  if (image2MutationInProgress()) return;
  const panel = $("image2AnchorPanel");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => panel.querySelector("[data-anchor-confirm], [data-image2-regenerate]")?.focus({ preventScroll: true }), 350);
});
$("anchorRegenerateForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const target = $("anchorRegenerateKind").value;
  if (!target.startsWith("qa-page:") && image2MutationInProgress()) {
    showNotice("当前项目仍在生成或校验，请等待结束后再修改页面；已保留你的修改提示词", "error");
    return;
  }
  const feedback = $("anchorRegenerateFeedback").value.trim();
  if (feedback.length < 2) {
    $("anchorRegenerateFeedback").setAttribute("aria-invalid", "true");
    $("anchorRegenerateError").hidden = false;
    $("anchorRegenerateFeedback").focus();
    return;
  }
  $("anchorRegenerateDialog").close();
  if (target.startsWith("qa-page:")) {
    void selectQaIssueFix(target.slice(8), feedback);
  } else if (target.startsWith("page:")) {
    void regenerateImage2Page(target.slice(5), feedback);
  } else {
    void regenerateImage2Anchor(target, feedback);
  }
});
$("anchorRegenerateFeedback").addEventListener("input", (event) => {
  const value = event.currentTarget.value;
  const valid = value.trim().length >= 2;
  event.currentTarget.setAttribute("aria-invalid", valid ? "false" : "true");
  $("anchorRegenerateError").hidden = true;
  $("anchorRegenerateCount").textContent = `${value.length} / 500`;
  $("anchorRegenerateSubmit").disabled = !valid || (!$("anchorRegenerateKind").value.startsWith("qa-page:") && image2MutationInProgress());
});
$("anchorRegenerateCancel").addEventListener("click", () => $("anchorRegenerateDialog").close());
$("closeStyleMaster").addEventListener("click", closeStyleMasterDialog);
$("styleMasterDialog").addEventListener("click", (event) => {
  if (event.target === $("styleMasterDialog")) closeStyleMasterDialog();
});
$("useStyleMaster").addEventListener("click", () => {
  const pack = stylePacks.find((item) => item.id === $("useStyleMaster").dataset.styleId);
  if (!pack) return;
  state.pendingStyleId = pack.id;
  closeStyleMasterDialog();
  renderStylePanel();
  updateActions();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("installApp").hidden = false;
});
$("installApp").addEventListener("click", async () => {
  if (!installPrompt) { document.getElementById('localInstallHelp')?.showModal(); return; }
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  if ($("installApp")) $("installApp").hidden = !document.getElementById('localInstallHint');
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  if ($("installApp")) $("installApp").hidden = true;
  document.getElementById('localInstallHint')?.remove();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").then((registration) => registration?.update?.()).catch(() => {
      // Desktop/privacy contexts may disable offline caching; network-backed
      // editing and task controls must remain usable without a service worker.
    });
  });
}

void bootstrap();

window.addEventListener("beforeunload", (event) => { if (hasContentDrafts() || state.contentSaveBusy) { event.preventDefault(); event.returnValue = ""; } });
