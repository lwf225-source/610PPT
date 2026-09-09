import { isTaskStatus, isTaskLifecycleEvent } from "./task-lifecycle-contract.js";

// Pure projection shared by persisted replay and browser live events. Transport
// owns event ordering. Completed counts only terminal successful jobs; a visible
// candidate awaiting QA never becomes accepted merely because it has an image.
export const TASK_DOMAIN_EVENTS = Object.freeze([
  "image2.compile.started", "image2.compile.completed",
  "generation.started", "generation.page.started", "generation.progress",
  "generation.page.completed", "generation.page.failed", "generation.completed",
  "generation.reconciled",
  "split.phase", "split.page.started", "split.page.completed", "split.completed",
  "qa.completed", "qa.issue.decision", "export.completed"
]);
export const isTaskDomainEvent = (event) => TASK_DOMAIN_EVENTS.includes(event?.type);

export function reduceTaskDomain(state, event) {
  if (!state || !event) return state;
  const payload = event.payload || {};
  const hasCandidate = ["task.failed", "split.completed"].includes(event.type) && Object.hasOwn(payload, "candidateId");
  const hasEnvelope = Object.hasOwn(event, "id") || Object.hasOwn(event, "createdAt");
  if (!isTaskDomainEvent(event) && !hasEnvelope && !hasCandidate && !Number.isSafeInteger(payload.engineEventId) && !Number.isFinite(payload.total) && !isTaskStatus(payload.status)) return state;
  const next = { ...state };
  if (Object.hasOwn(event, "id")) next.lastEventId = event.id;
  if (Object.hasOwn(event, "createdAt")) next.updatedAt = event.createdAt;
  if (Number.isSafeInteger(payload.engineEventId)) next.lastEngineEventId = payload.engineEventId;
  if (hasCandidate) next.candidateId = payload.candidateId || null;
  if (event.type === "split.phase") {
    next.phase = payload.phase || next.phase;
    next.phaseMessage = payload.message || next.phaseMessage || "";
  }
  if (event.type === "split.page.started") {
    next.currentPage = payload.pageNo || next.currentPage;
    const pages = Array.isArray(next.pages) ? [...next.pages] : [];
    const page = { id: payload.pageNo || "", pageNo: payload.pageNo || "", title: "正在生成本页文案", generationStatus: "writing" };
    const index = pages.findIndex((item) => item.id === page.id || item.pageNo === page.pageNo);
    if (index >= 0 && pages[index].generationStatus === "writing") pages[index] = { ...pages[index], ...page };
    else if (index < 0) pages.push(page);
    next.pages = pages.sort((a, b) => a.pageNo.localeCompare(b.pageNo, "zh-CN"));
  }
  if (event.type === "split.page.completed" && payload.page) {
    // The event-store boundary supplies the same canonical editor summary to
    // the journal, SSE, and legacy replay. No Node/editor formatter runs here.
    const page = payload.page;
    const pages = Array.isArray(next.pages) ? [...next.pages] : [];
    const index = pages.findIndex((item) => item.id === page.id || item.pageNo === page.pageNo);
    if (index >= 0) pages[index] = page;
    else pages.push(page);
    next.pages = pages.sort((a, b) => a.pageNo.localeCompare(b.pageNo, "zh-CN"));
    next.completed = next.pages.filter((item) => item.generationStatus !== "writing").length;
    next.currentPage = page.pageNo;
  }
  if (event.type === "split.completed") {
    next.completed = payload.pageCount ?? next.completed ?? 0;
    next.total = payload.pageCount ?? next.total ?? 0;
    next.deck = payload.deck || next.deck || null;
    next.pages = Array.isArray(payload.pages) ? payload.pages : next.pages;
    next.currentPage = next.pages?.[0]?.pageNo || next.currentPage;
    next.phase = "completed";
    next.phaseMessage = "整套文案已生成";
    delete next.error;
    delete next.recovery;
    // Do not infer task success from page count or this event's name. The
    // committed V1 adapter explicitly supplies status; task.completed remains
    // the lifecycle boundary for legacy and other completion sequences.
  }
  if (event.type === "qa.completed") {
    next.phase = "qa-completed";
    next.qa = { ...payload, decisions: payload.decisions || {} };
    next.deck = payload.deck || next.deck || null;
    next.completed = Number.isFinite(payload.total) ? payload.total : next.total;
  }
  if (event.type === "qa.issue.decision") {
    const decisions = { ...(next.qa?.decisions || {}) };
    decisions[payload.key] = { decision: payload.decision, pageNo: payload.pageNo || "", feedback: payload.feedback || "", decidedAt: payload.decidedAt || event.createdAt };
    next.qa = { ...(next.qa || {}), decisions };
    next.phase = "qa-awaiting-export";
  }
  if (event.type === "export.completed") {
    next.phase = "export-completed";
    next.export = payload;
    next.deck = payload.deck || next.deck || null;
  }
  if (event.type === "image2.compile.started") {
    next.status = "running";
    next.phase = payload.phase || "visual-compiling";
    next.phaseMessage = payload.message || "Codex 正在编译整套视觉计划";
    next.planningStartedAt = event.createdAt || null;
    next.planningDurationMs = 0;
  }
  if (event.type === "image2.compile.completed") {
    next.status = "running";
    next.phase = payload.phase || "anchors-pending";
    next.phaseMessage = "视觉计划已完成，正在生成封面与正文视觉母版";
    next.deck = payload.deck || next.deck || null;
    next.planSignature = payload.planSignature || next.planSignature || "";
    next.anchorPageIds = payload.anchorPageIds || next.anchorPageIds || [];
    const planningStartedAt = Date.parse(next.planningStartedAt || "");
    const planningCompletedAt = Date.parse(event.createdAt || "");
    if (Number.isFinite(planningStartedAt) && Number.isFinite(planningCompletedAt)) {
      next.planningDurationMs = Math.max(0, planningCompletedAt - planningStartedAt);
    }
  }
  if (event.type === "generation.started") {
    next.status = "running";
    next.operation = payload.operation || next.input?.operation || next.operation || "";
    next.generationPhase = payload.phase || next.generationPhase || "full";
    next.batchId = payload.batchId || next.batchId || "";
    next.generationPageNos = Array.isArray(payload.pageNos) ? [...payload.pageNos] : null;
    next.phase = next.generationPhase === "anchors" ? "anchor-generating" : "generating";
    const regenerationPageNo = next.operation === "page-regeneration" ? payload.pageNos?.[0] : "";
    next.phaseMessage = regenerationPageNo
      ? `正在按提示词重新生成 ${regenerationPageNo}`
      : next.operation === "qa-batch-regeneration"
        ? `正在生成已选择修复的 ${payload.pageNos?.length || next.total || ""} 页`
      : next.generationPhase === "anchors"
        ? "正在生成封面与首张正文视觉锚点"
        : "正在生成剩余页面";
    next.total = payload.total || 0;
    next.completed = 0;
    next.generatedCount = 0;
    next.failed = 0;
    next.completedPageNos = [];
    next.failedPages = [];
    next.pages = [];
    next.currentPage = null;
    next.activePageNos = [];
    next.qaPageNos = [];
  }
  if (event.type === "generation.page.started") {
    next.currentPage = payload.pageNo || next.currentPage;
    next.phase = next.generationPhase === "anchors" ? "anchor-generating" : "generating";
    const pages = Array.isArray(next.pages) ? [...next.pages] : [];
    const page = {
      id: payload.pageNo || "",
      pageNo: payload.pageNo || "",
      title: payload.title || "正在生成页面图片",
      pageType: "页面图片",
      generationStatus: "generating"
    };
    const index = pages.findIndex((item) => item.id === page.id || item.pageNo === page.pageNo);
    if (index >= 0) pages[index] = { ...pages[index], ...page };
    else pages.push(page);
    next.pages = pages.sort((a, b) => a.pageNo.localeCompare(b.pageNo, "zh-CN"));
  }
  if (event.type === "generation.progress") {
    // Legacy progress lacks page snapshots; preserve its aggregate counters.
    // New progress also supplies the latest independently published page states.
    next.generatedCount = payload.completed ?? next.generatedCount ?? 0;
    next.failed = payload.failed ?? next.failed ?? 0;
    next.total = payload.total ?? next.total ?? 0;
    next.activePageNos = Array.isArray(payload.activePageNos) ? [...payload.activePageNos] : (next.activePageNos || []);
    next.qaPageNos = Array.isArray(payload.qaPageNos) ? [...payload.qaPageNos] : (next.qaPageNos || []);
    if (Array.isArray(payload.pageStates)) {
      const pages = Array.isArray(next.pages) ? [...next.pages] : [];
      for (const pageState of payload.pageStates) {
        if (!pageState?.pageNo) continue;
        const index = pages.findIndex((page) => page.pageNo === pageState.pageNo);
        const previous = index >= 0 ? pages[index] : {};
        const page = { ...previous, ...pageState, id: pageState.id || previous.id || pageState.pageNo,
          title: pageState.title || previous.title || "未命名页面", pageType: previous.pageType || "页面图片" };
        if (page.generationStatus !== "failed") {
          delete page.error;
          delete page.failureStage;
        }
        if (index >= 0) pages[index] = page;
        else pages.push(page);
      }
      next.pages = pages.sort((left, right) => left.pageNo.localeCompare(right.pageNo, "zh-CN", { numeric: true }));
      next.completedPageNos = next.pages.filter((page) => ["generated", "imported", "dispatched"].includes(page.generationStatus)).map((page) => page.pageNo);
      next.completed = next.completedPageNos.length;
      next.generatedCount = next.completed;
      next.failedPages = next.pages.filter((page) => page.generationStatus === "failed")
        .map((page) => ({ ...page, message: page.error || "页面图片生成失败" }));
      next.failed = next.failedPages.length;
    }
    next.averageDurationMs = Number(payload.averageDurationMs || 0);
    next.estimatedRemainingMs = Number(payload.estimatedRemainingMs || 0);
    next.concurrency = Number(payload.concurrency || 1);
  }
  if (event.type === "generation.page.completed") {
    const publishedPageNos = Array.isArray(next.completedPageNos)
      ? next.completedPageNos
      : (next.pages || []).filter((page) => page.generationStatus === "generated").map((page) => page.pageNo).filter(Boolean);
    const completedPages = new Set(publishedPageNos);
    if (payload.pageNo) completedPages.add(payload.pageNo);
    next.completedPageNos = [...completedPages];
    next.completed = next.completedPageNos.length;
    next.generatedCount = Math.max(Number(next.generatedCount || 0), next.completed);
    next.currentPage = payload.pageNo || next.currentPage;
    const pages = Array.isArray(next.pages) ? [...next.pages] : [];
    const page = {
      id: payload.pageNo || "",
      pageNo: payload.pageNo || "",
      title: payload.title || "未命名页面",
      pageType: "页面图片",
      imagePath: payload.imagePath || null,
      generationStatus: "generated",
      workStage: "complete",
      statusText: "图片已生成"
    };
    const index = pages.findIndex((item) => item.id === page.id || item.pageNo === page.pageNo);
    if (index >= 0) {
      const { error: _error, failureStage: _failureStage, ...existingPage } = pages[index];
      pages[index] = { ...existingPage, ...page };
    }
    else pages.push(page);
    next.pages = pages.sort((a, b) => a.pageNo.localeCompare(b.pageNo, "zh-CN"));
    next.failedPages = (next.failedPages || []).filter((item) => item?.pageNo !== payload.pageNo);
    next.failed = next.failedPages.length;
    next.activePageNos = (next.activePageNos || []).filter((pageNo) => pageNo !== payload.pageNo);
    next.qaPageNos = (next.qaPageNos || []).filter((pageNo) => pageNo !== payload.pageNo);
  }
  if (event.type === "generation.page.failed") {
    const failedPages = Array.isArray(next.failedPages) ? [...next.failedPages] : [];
    const failedPageIndex = failedPages.findIndex((item) => item?.pageNo === payload.pageNo);
    if (failedPageIndex >= 0) failedPages[failedPageIndex] = { ...failedPages[failedPageIndex], ...payload };
    else failedPages.push(payload);
    next.failedPages = failedPages;
    next.failed = failedPages.length;
    next.currentPage = payload.pageNo || next.currentPage;
    const pages = Array.isArray(next.pages) ? [...next.pages] : [];
    const index = pages.findIndex((item) => item.pageNo === payload.pageNo);
    if (index >= 0) pages[index] = {
      ...pages[index],
      imagePath: payload.imagePath || pages[index].imagePath || null,
      generationStatus: "failed",
      workStage: "failed",
      statusText: payload.statusText || "生成失败",
      failureStage: payload.failureStage || "generation",
      error: payload.message || "页面图片生成失败"
    };
    else pages.push({
      id: payload.pageNo || "",
      pageNo: payload.pageNo || "",
      title: payload.title || "未命名页面",
      pageType: "页面图片",
      imagePath: payload.imagePath || null,
      generationStatus: "failed",
      workStage: "failed",
      statusText: payload.statusText || "生成失败",
      failureStage: payload.failureStage || "generation",
      error: payload.message || "页面图片生成失败"
    });
    next.pages = pages.sort((a, b) => a.pageNo.localeCompare(b.pageNo, "zh-CN"));
    next.activePageNos = (next.activePageNos || []).filter((pageNo) => pageNo !== payload.pageNo);
    next.qaPageNos = (next.qaPageNos || []).filter((pageNo) => pageNo !== payload.pageNo);
  }
  if (event.type === "generation.completed") {
    next.activePageNos = [];
    next.qaPageNos = [];
    const persistedCompleted = new Set(next.completedPageNos || []).size;
    next.completed = Math.max(Number(payload.completed ?? next.completed ?? 0), persistedCompleted);
    next.generatedCount = Math.max(Number(next.generatedCount || 0), next.completed);
    next.failed = payload.failed ?? next.failed ?? 0;
    next.total = payload.total ?? next.total ?? 0;
    next.deck = payload.deck || next.deck || null;
    next.generationPhase = payload.phase || next.generationPhase || "full";
    const hasFailures = Number(next.failed || 0) > 0;
    next.phase = hasFailures
      ? "generated-with-errors"
      : next.generationPhase === "anchors" ? "anchor-ready" : "generated";
    const regenerationPageNo = next.operation === "page-regeneration" ? next.input?.pageIds?.[0] : "";
    next.phaseMessage = hasFailures
      ? `${next.failed} 页生成失败，可直接重试失败页`
      : regenerationPageNo
        ? `${regenerationPageNo} 已按提示词重新生成`
      : next.generationPhase === "anchors"
        ? "双锚点已生成，请分别确认"
        : "页面图片已生成";
  }
  if (event.type === "generation.reconciled") {
    next.completed = Number(payload.completed ?? next.completed ?? 0);
    next.generatedCount = Math.max(Number(payload.generatedCount ?? next.generatedCount ?? 0), next.completed);
    next.failed = Number(payload.failed ?? next.failed ?? 0);
  }
  if (Number.isFinite(payload.total)) next.total = payload.total;
  if (!isTaskLifecycleEvent(event) && isTaskStatus(payload.status)) next.status = payload.status;
  if (next.cancelRequested && ["queued", "running"].includes(next.status)) next.phase = "cancelling";
  if (event.createdAt && (next.phase !== state.phase || ["image2.compile.started", "generation.started"].includes(event.type))) {
    next.phaseStartedAt = event.createdAt;
  }
  return next;
}
