export const taskCursor = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// One observation owner per selected task. Neither transport owns business
// completion: the persisted event sequence does. Never regenerate on reconnect.
export function createTaskObserver({ currentTask, currentProject, readSnapshot, applySnapshot, applyEvent,
  isSettled, onSettled = () => {}, onConnectionIssue = () => {}, onConnectionRestored = () => {}, sourceFactory = (url) => new EventSource(url),
  setTimer = setTimeout, clearTimer = clearTimeout, connectedPollMs = 15000, retryPollMs = 3000, timeoutMs = 10000 }) {
  let session = null;
  const valid = (run) => session === run && currentTask()?.taskId === run.taskId && currentProject() === run.projectSlug;
  const cursor = () => taskCursor(currentTask()?.lastEventId) ?? 0;
  const issue = (run) => { run.warned = true; onConnectionIssue(); };
  const restored = (run) => { if (run.warned) { run.warned = false; onConnectionRestored(); } };
  function stop() {
    const run = session; session = null;
    if (!run) return;
    clearTimer(run.timer); run.controller?.abort(); run.source?.close();
  }
  function schedule(run, delay) {
    if (!valid(run) || run.timer !== null) return;
    // Stream reconnects must not keep postponing the fallback poll.
    run.timer = setTimer(() => { run.timer = null; void poll(run); }, delay);
  }
  function resync(run, target = 0) {
    run.missingCursor = Math.max(run.missingCursor || 0, target);
    if (run.controller) run.pollAgain = true;
    else void poll(run);
  }
  function finish(run, notify = true) {
    if (!valid(run) || !isSettled(currentTask())) return false;
    const task = currentTask(); stop();
    if (notify) void Promise.resolve(onSettled(task, run.projectSlug)).catch(() => {});
    return true;
  }
  async function poll(run = session) {
    if (!run || !valid(run) || run.controller) return;
    clearTimer(run.timer); run.timer = null;
    const controller = new AbortController(); run.controller = controller;
    let deadline;
    try {
      const timeout = new Promise((_, reject) => {
        deadline = setTimer(() => { controller.abort(); reject(new Error("任务状态读取超时")); }, timeoutMs);
      });
      const payload = await Promise.race([readSnapshot(run.projectSlug, run.taskId, { signal: controller.signal, after: cursor() }), timeout]);
      if (!valid(run) || controller.signal.aborted) return;
      restored(run);
      const task = payload?.task;
      if (task && task.taskId === run.taskId && task.projectSlug === run.projectSlug) {
        const received = taskCursor(task.lastEventId);
        // Equal cursors represent the same committed state. A slower snapshot
        // must not overwrite newer SSE state or reset the selected page.
        if (received !== null && received > cursor()) applySnapshot(task);
      }
      if (cursor() >= (run.missingCursor || 0)) run.missingCursor = 0;
      finish(run);
    } catch {
      if (valid(run)) issue(run);
    } finally {
      clearTimer(deadline);
      if (run.controller === controller) run.controller = null;
      if (valid(run)) {
        const delay = run.pollAgain ? 0 : run.connected && !run.missingCursor ? connectedPollMs : retryPollMs;
        run.pollAgain = false; schedule(run, delay);
      }
    }
  }
  function start(projectSlug, taskId) {
    stop();
    const run = { projectSlug, taskId, connected: false, controller: null, timer: null, source: null };
    session = run;
    if (!valid(run) || finish(run, false)) return null;
    let source;
    try { source = sourceFactory(`/api/v2/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(taskId)}/events?after=${cursor()}`); }
    catch { issue(run); schedule(run, retryPollMs); return { close() { if (session === run) stop(); } }; }
    run.source = source;
    source.onopen = () => { if (valid(run)) { run.connected = true; resync(run); } };
    source.addEventListener("task-event", (message) => {
      if (!valid(run)) return;
      let event;
      try { event = JSON.parse(message.data); } catch { resync(run); return; }
      const received = taskCursor(event?.id);
      if (received === null || received === 0) { resync(run); return; }
      if (received <= cursor()) return;
      // Never advance across a missing event. Fetch the authoritative snapshot
      // instead of applying a partial stream or replaying a model operation.
      if (received !== cursor() + 1) { resync(run, received); return; }
      applyEvent(event);
      finish(run, false);
    });
    source.onerror = () => { if (valid(run)) { run.connected = false; issue(run); resync(run); } };
    schedule(run, retryPollMs);
    return { close() { if (session === run) stop(); } };
  }
  function resume() {
    if (session && valid(session)) resync(session);
  }
  return { start, stop, resume, poll: () => poll(), active: () => Boolean(session && valid(session)) };
}
