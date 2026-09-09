// Browser and persisted V2 task replay share this contract. A paused task is
// settled for observation, but can later start a new attempt on explicit resume.
export const V2_TASK_STATUSES = Object.freeze(["queued", "running", "paused", "cancelled", "completed", "failed"]);
export const TASK_LIFECYCLE_EVENTS = Object.freeze(["task.started", "task.completed", "task.paused", "task.failed", "task.cancel.requested", "task.cancelled"]);
export const isTaskStatus = (value) => V2_TASK_STATUSES.includes(value);
export const isTaskInFlight = (task) => ["queued", "running"].includes(task?.status);
export const isTaskSettled = (task) => ["completed", "failed", "paused", "cancelled"].includes(task?.status);
export const isTaskLifecycleEvent = (event) => TASK_LIFECYCLE_EVENTS.includes(event?.type);

// Pure: does not own cursor/clock, pages, IO, candidate lineage or UI effects.
// The lifecycle event type wins over contradictory payload.status values.
export function reduceTaskLifecycle(state, event) {
  if (!state || !isTaskLifecycleEvent(event)) return state;
  const payload = event.payload || {};
  if (event.type === "task.cancel.requested" && !isTaskInFlight(state)) return state;
  if (event.type === "task.cancelled" && state.status === "completed") return state;
  const next = { ...state };
  switch (event.type) {
    case "task.started":
      if (state.kind === "split" && Number.isFinite(Date.parse(event.createdAt || ""))) next.attemptStartedAt = event.createdAt;
      next.status = "running";
      if (payload.resumed) {
        next.cancelRequested = false;
        if (["cancelled", "cancelling"].includes(next.phase)) { next.phase = "starting"; next.phaseMessage = ""; }
      }
      delete next.error; delete next.recovery;
      break;
    case "task.completed":
      next.status = "completed";
      delete next.error; delete next.recovery;
      break;
    case "task.paused":
      next.status = "paused"; next.phase = "paused";
      next.recovery = { action: payload.action || "restart", message: payload.message || "本地服务已重启，任务已暂停。" };
      break;
    case "task.failed":
      next.status = "failed"; next.error = payload.message || "任务失败";
      break;
    case "task.cancel.requested":
      next.cancelRequested = true; next.phase = "cancelling";
      next.phaseMessage = "取消请求已持久保存，等待引擎停止模型进程";
      break;
    case "task.cancelled":
      next.status = "cancelled"; next.phase = "cancelled"; next.error = null;
      next.deck = payload.deck || next.deck || null;
      next.recovery = { action: payload.action || (next.kind === "split" ? "resume-split" : "continue-generation"), message: payload.message || (next.kind === "split" ? "拆页已取消，可从已有检查点续跑" : "生成已停止，已生成图片已保留") };
      break;
  }
  if (isTaskSettled(next)) { next.activePageNos = []; next.qaPageNos = []; next.currentPage = null; }
  return next;
}
