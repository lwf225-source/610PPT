const STEP_TASK_KINDS = {
  2: new Set(["split"]),
  4: new Set(["image2-compile", "generation", "qa-export", "direct-export"])
};

export function taskMatchesStep(task, step) {
  const allowedKinds = STEP_TASK_KINDS[Number(step)];
  return Boolean(task?.kind && allowedKinds?.has(task.kind));
}

export function startingTaskForStep({
  taskStartBusy = "",
  activeTask = null,
  step = 1,
  targetPageCount = 0,
  anchorPageIds = []
} = {}) {
  if (!["split", "image2-compile"].includes(taskStartBusy)) return null;
  if (!taskMatchesStep({ kind: taskStartBusy }, step)) return null;
  if (activeTask?.kind === taskStartBusy && ["queued", "running"].includes(activeTask.status)) return null;

  const normalizedAnchorPageIds = anchorPageIds.map(String).filter(Boolean);
  const total = taskStartBusy === "image2-compile"
    ? Math.max(2, normalizedAnchorPageIds.length)
    : Math.max(0, Number(targetPageCount) || 0);
  return {
    taskId: `starting-${taskStartBusy}`,
    kind: taskStartBusy,
    status: "queued",
    phase: "starting",
    completed: 0,
    total,
    pages: [],
    anchorPageIds: normalizedAnchorPageIds,
    input: { targetPageCount: total }
  };
}

export function taskForStep({ activeTask = null, tasks = [], step = 1 } = {}) {
  if (taskMatchesStep(activeTask, step)) return activeTask;
  return (tasks || []).find((task) => taskMatchesStep(task, step)) || null;
}
