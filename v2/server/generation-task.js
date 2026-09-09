import { orderedGenerationActions, sortGenerationPageNos } from "./generation-order.js";

function isGenerationBatchFinished(status) {
  return ["completed", "completed-with-errors", "failed"].includes(status);
}

export function generationTaskCanSettle(batch = {}, progress = {}) {
  if (isGenerationBatchFinished(batch.status)) return true;
  if (["cancelling", "interrupted"].includes(batch.status)) return false;
  const total = Math.max(0, Number(progress.total || 0));
  const terminal = Math.max(0, Number(progress.completed || 0)) + Math.max(0, Number(progress.failed || 0));
  const activePageNos = Array.isArray(progress.activePageNos) ? progress.activePageNos.filter(Boolean) : [];
  return total > 0 && terminal >= total && activePageNos.length === 0;
}

export function generationPageNosForTask(started = {}, requestedPageIds = [], phase = "full", includeTerminal = false) {
  const requested = new Set((requestedPageIds || []).map(String).filter(Boolean));
  const jobs = Object.values(started.jobs || {});
  const phaseJobs = jobs.filter((job) => String(job?.phase || "") === String(phase || ""));
  // Reused Image2 batches retain anchor and remaining jobs together. Once phase
  // metadata exists it is authoritative; otherwise keep compatibility with old batches.
  const scopedJobs = phaseJobs.length ? phaseJobs : jobs;
  const queuedPageNos = scopedJobs
    .filter((job) => ["queued", "generating"].includes(job?.status))
    .filter((job) => !requested.size || requested.has(String(job.pageId || "")) || requested.has(String(job.pageNo || "")))
    .map((job) => String(job.pageNo || job.pageId || ""))
    .filter(Boolean);
  const allScopedPageNos = scopedJobs
    .filter((job) => !requested.size || requested.has(String(job.pageId || "")) || requested.has(String(job.pageNo || "")))
    .map((job) => String(job.pageNo || job.pageId || ""))
    .filter(Boolean);
  const fallback = requested.size ? [...requested] : [];
  const candidates = includeTerminal ? allScopedPageNos : queuedPageNos;
  return sortGenerationPageNos(candidates.length ? candidates : fallback);
}

// Only public display state crosses the progress boundary. In particular do not
// spread jobs: they also contain prompts, private reference bindings and audits.
export function generationPageState(job = {}) {
  const qualityGate = job.qualityGate ? Object.fromEntries(
    ["kind", "status", "code", "message"].filter((key) => job.qualityGate[key] != null)
      .map((key) => [key, job.qualityGate[key]])
  ) : null;
  const pageNo = String(job.pageNo || job.pageId || "");
  return {
    id: String(job.pageId || pageNo),
    pageId: String(job.pageId || pageNo),
    pageNo,
    title: job.title || "",
    generationStatus: job.status || "queued",
    workStage: job.workStage || (job.status === "generating" ? "generation" : job.status || "queued"),
    statusText: job.statusText || "",
    imagePath: job.bridgeResult?.imagePath || job.qaCandidate?.result?.imagePath || null,
    qualityGate,
    error: job.error || "",
    failureStage: job.failureStage || "",
    durationMs: Number(job.durationMs || 0),
    attempts: Number(job.attempts || 0),
    auditAttempts: Number(job.auditAttempts || 0)
  };
}

export function generationProgressForTask(batch = {}, jobs = {}, pageNos = []) {
  const allowedPages = new Set((pageNos || []).map(String).filter(Boolean));
  const scopedJobs = Object.values(jobs || {}).filter((job) => (
    !allowedPages.size || allowedPages.has(String(job?.pageNo || job?.pageId || ""))
  ));
  const completedStatuses = new Set(["generated", "imported", "dispatched"]);
  const completed = scopedJobs.filter((job) => completedStatuses.has(job?.status)).length;
  const failedJobs = scopedJobs.filter((job) => job?.status === "failed");
  const total = allowedPages.size || scopedJobs.length || Number(batch.total || 0);
  const pageStates = scopedJobs.map(generationPageState)
    .sort((left, right) => left.pageNo.localeCompare(right.pageNo, "zh-CN", { numeric: true }));
  // Legacy batch.activePageNos can include audit workers and stale terminal
  // pages. The job stage is authoritative about which lane is actually busy.
  const activePageNos = pageStates.filter((page) => page.generationStatus === "generating" && page.workStage === "generation")
    .map((page) => page.pageNo);
  const qaPageNos = pageStates.filter((page) => page.generationStatus === "generating" && ["qa-queued", "auditing", "binding"].includes(page.workStage))
    .map((page) => page.pageNo);
  const durations = scopedJobs
    .map((job) => Number(job?.durationMs || 0))
    .filter((duration) => duration > 0);
  const averageDurationMs = durations.length
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
    : Number(batch.averageDurationMs || 0);
  const concurrency = Math.min(Math.max(1, Number(batch.concurrency || 1)), Math.max(1, total));
  const pending = Math.max(0, total - completed - failedJobs.length);
  return {
    total,
    completed,
    failed: failedJobs.length,
    failedPages: failedJobs.map((job) => ({
      pageId: job.pageId,
      pageNo: job.pageNo,
      error: job.error || "生成失败",
      statusText: job.statusText || "生成失败",
      failureStage: job.failureStage || "generation",
      imagePath: job.bridgeResult?.imagePath || null
    })),
    activePageNos,
    qaPageNos,
    pageStates,
    averageDurationMs,
    estimatedRemainingMs: averageDurationMs && pending ? Math.ceil(pending / concurrency) * averageDurationMs : 0,
    concurrency
  };
}

// HTTP routing supplies the public deck projection; observation itself owns
// no server, filesystem, model process or mutable global dependency registry.
export function createGenerationTaskRunner({ deckSummary } = {}) {
  if (typeof deckSummary !== "function") throw new TypeError("generation task runner requires deckSummary");
  return async function runGenerationTask({ store, v1, projectSlug, taskId, batchId, phase = "full", activePageNos = [],
    observationTimeoutMs = 2 * 60 * 60 * 1000, now = () => performance.now(),
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!Number.isFinite(observationTimeoutMs) || observationTimeoutMs <= 0) throw new Error("生成观察期限必须为正数");
    const deadline = now() + observationTimeoutMs;
    let consecutiveReadErrors = 0;
    const pauseObservation = (message) => store.append(projectSlug, taskId, "task.paused", {
      status: "paused", action: "continue-generation", message
    });
    let emitted = {};
    let progressSignature = "";
    let orderedPageNos = sortGenerationPageNos(activePageNos);
    let allowedPages = new Set(orderedPageNos);
    try {
      while (now() < deadline) {
        let payload;
        try {
          payload = await v1.request(`/api/generation/batches/${encodeURIComponent(batchId)}`, {
            timeoutMs: Math.max(1, Math.ceil(Math.min(15000, deadline - now())))
          });
          consecutiveReadErrors = 0;
        } catch (error) {
          consecutiveReadErrors += 1;
          if (consecutiveReadErrors >= 3 || (error.statusCode >= 400 && error.statusCode < 500)) {
            await pauseObservation("暂时无法确认原生图批次状态，已暂停进度观察；后台任务可能仍在运行，这不代表生成失败。请重新打开项目核对原批次。");
            return;
          }
          // Retry only this read of the same durable batch, never generation/start.
          await sleep(Math.max(0, Math.min(900, deadline - now())));
          continue;
        }
        const batch = payload.batch || {};
        const jobs = payload.jobs || {};
        // 旧版或恢复批次的 start 响应可能只有 batchId，页序要从第一次轮询的任务补齐。
        // 只在初次缺失时推导，后续保持该序列不变，避免状态发布顺序随任务完成顺序漂移。
        if (!orderedPageNos.length) {
          orderedPageNos = sortGenerationPageNos(Object.values(jobs).map((job) => job?.pageNo || job?.pageId));
          allowedPages = new Set(orderedPageNos);
        }
        const visibleJobs = Object.fromEntries(
          Object.entries(jobs).filter(([, job]) => !allowedPages.size || allowedPages.has(String(job?.pageNo || "")))
            .map(([key, job]) => [key, batch.status === "interrupted" && ["queued", "generating"].includes(job.status)
              ? { ...job, status: "cancelled", workStage: "cancelled", statusText: "已停止" } : job])
        );
        const ordered = orderedGenerationActions(visibleJobs, orderedPageNos, emitted);
        emitted = ordered.emitted;
        for (const action of ordered.actions) {
          const job = action.job;
          if (action.type === "started") {
            await store.append(projectSlug, taskId, "generation.page.started", { pageNo: job.pageNo, title: job.title || "" });
          }
          if (action.type === "completed") {
            await store.append(projectSlug, taskId, "generation.page.completed", {
              pageNo: job.pageNo,
              title: job.title || "",
              imagePath: job.bridgeResult?.imagePath || null,
              durationMs: Number(job.durationMs || 0)
            });
          }
          if (action.type === "failed") {
            await store.append(projectSlug, taskId, "generation.page.failed", {
              pageNo: job.pageNo,
              title: job.title || "",
              message: job.error || "页面图片生成失败",
              statusText: job.statusText || "生成失败",
              failureStage: job.failureStage || "generation",
              imagePath: job.bridgeResult?.imagePath || null,
              durationMs: Number(job.durationMs || 0)
            });
          }
        }
        const scopedProgress = generationProgressForTask(batch, visibleJobs, orderedPageNos);
        const nextProgressSignature = [
          scopedProgress.completed,
          scopedProgress.failed,
          scopedProgress.activePageNos.join(","),
          scopedProgress.averageDurationMs,
          scopedProgress.estimatedRemainingMs,
          JSON.stringify(scopedProgress.pageStates)
        ].join("/");
        if (nextProgressSignature !== progressSignature) {
          progressSignature = nextProgressSignature;
          await store.append(projectSlug, taskId, "generation.progress", {
            ...scopedProgress
          });
        }
        if (batch.status === "interrupted") {
          const current = await store.getTask(projectSlug, taskId);
          if (["completed", "cancelled"].includes(current?.status)) return;
          await store.append(projectSlug, taskId, current?.cancelRequested ? "task.cancelled" : "task.paused", {
            action: "continue-generation",
            deck: deckSummary(payload.deck || {}),
            message: current?.cancelRequested
              ? "生成已停止，已返回的页面已保留，可继续生成剩余页面。"
              : batch.interruptionReason || "原生成批次已停止；已返回的页面会保留，可按需继续剩余页面。"
          });
          return;
        }
        if (generationTaskCanSettle(batch, scopedProgress)) {
          await store.append(projectSlug, taskId, "generation.completed", {
            status: scopedProgress.failed > 0 || batch.status === "failed" ? "failed" : "completed",
            total: scopedProgress.total,
            completed: scopedProgress.completed,
            failed: scopedProgress.failed,
            phase: batch.phase || phase,
            deck: deckSummary(payload.deck || {})
          });
          if (scopedProgress.failed > 0 || batch.status === "failed") {
            const failedPages = scopedProgress.failedPages.map((item) => item.pageNo).filter(Boolean);
            const suffix = failedPages.length ? `（${failedPages.join("、")}）` : "";
            await store.append(projectSlug, taskId, "task.failed", {
              status: "failed",
              message: `${scopedProgress.failed || 1} 页图片生成失败${suffix}，可直接重试失败页`
            });
          } else {
            await store.append(projectSlug, taskId, "task.completed", { status: "completed" });
          }
          return;
        }
        await sleep(Math.max(0, Math.min(900, deadline - now())));
      }
      await pauseObservation("本轮进度观察已到期限；原生图批次和已完成页面已保留，后台可能仍在运行。请重新打开项目核对原批次，这不代表生成失败。");
    } catch (error) {
      await store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
    }
  };
}
