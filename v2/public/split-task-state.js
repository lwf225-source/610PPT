import { taskForStep } from "./task-step.js";

export function splitTaskBusyForState({ taskStartBusy = "", activeTask = null, tasks = [] } = {}) {
  if (taskStartBusy === "split") return true;
  const task = taskForStep({ activeTask, tasks, step: 2 });
  return task?.kind === "split" && ["queued", "running"].includes(task.status);
}

export function splitActionState({ hasProject = false, configurationMatches = false, splitBusy = false } = {}) {
  return {
    restartDisabled: !hasProject || splitBusy,
    confirmDisabled: splitBusy || !configurationMatches
  };
}

export function splitLifecycleControl(task, busy = false) {
  if (task?.kind !== "split" || task.input?.workerProtocol !== "durable-split-v1") return null;
  if (["queued", "running"].includes(task.status)) {
    const cancelling = task.phase === "cancelling" || task.cancelRequested === true;
    return { action: "cancel", label: cancelling ? "正在取消拆页" : "取消拆页", disabled: busy || cancelling };
  }
  if (["failed", "paused", "cancelled"].includes(task.status)) return { action: "resume", label: "继续拆页", disabled: busy };
  return null;
}

export function splitDisplayConfiguration({ task = null, deck = null, narrativeMode = "narrative", contentDetailMode = "focus" } = {}) {
  const taskOwnsConfiguration = task?.kind === "split" && ["queued", "running", "failed", "paused", "cancelled"].includes(task.status);
  const profile = deck?.styleProfile || {};
  return {
    source: taskOwnsConfiguration ? "task" : "deck",
    pageCount: taskOwnsConfiguration
      ? Number(task.input?.targetPageCount) || Number(task.total) || 0
      : (deck?.pages || []).length,
    narrativeMode: (taskOwnsConfiguration ? task.input?.narrativeMode : null) || profile.narrativeMode || narrativeMode,
    contentDetailMode: (taskOwnsConfiguration ? task.input?.contentDetailMode : null) || profile.contentDetailMode || contentDetailMode
  };
}
