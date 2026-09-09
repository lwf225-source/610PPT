function activeSplitTask(task) {
  return Boolean(task?.taskId && task.kind === "split" && ["queued", "running"].includes(task.status));
}

/**
 * One split execution per project, including requests with different settings.
 *
 * start() must resolve { task, completion }: task is the persisted queued/running
 * TaskEventStore record; completion is the full durable enqueue promise, not the
 * HTTP response. The request returns immediately after admission, while its
 * reservation remains until model work and persistence have both settled.
 *
 * findActiveTask runs inside admission before creating any task. It should use
 * the authoritative store (including restart reconciliation), return a queued/
 * running split, or null. Paused/terminal records are intentionally not adopted.
 * This is a single-server gate, not a distributed worker lease.
 */
export function createSplitAdmissionGate({ findActiveTask = async () => null } = {}) {
  const reservations = new Map();
  return {
    async run(projectSlug, start) {
      const key = String(projectSlug || "").trim();
      if (!key) throw new Error("拆页请求缺少项目标识");
      if (typeof start !== "function") throw new TypeError("start must be a function");
      const existing = reservations.get(key);
      if (existing) {
        const admitted = await existing.ready;
        return { ...admitted, reused: true, reason: "project-active" };
      }

      // Reserve synchronously, before any store lookup or task creation can yield.
      const entry = {};
      reservations.set(key, entry);
      const release = () => {
        if (reservations.get(key) === entry) reservations.delete(key);
      };
      entry.ready = (async () => {
        try {
          const active = await findActiveTask(key);
          if (activeSplitTask(active)) {
            // We do not own this task's lifecycle; re-query the store next time.
            release();
            return { task: active, reused: true, reason: "persisted-active" };
          }
          const started = await start();
          if (!activeSplitTask(started?.task) || typeof started?.completion?.then !== "function") {
            throw new Error("拆页准入需要已持久化的任务及完整任务完成 Promise");
          }
          Promise.resolve(started.completion).then(release, release);
          return { task: started.task, reused: false, reason: "started" };
        } catch (error) {
          release();
          throw error;
        }
      })();
      return entry.ready;
    }
  };
}
