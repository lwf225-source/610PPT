import { assertCommittedSplit } from "./split-completion.js";
import { splitInputHash } from "../../server/content-candidates.js";

/** Persistent V2 outbox + event projection. Dropping this process/HTTP request
 * never drops or cancels engine work. Polling can reattach from its last cursor.
 */
export class DurableSplitClient {
  constructor({ store, v1, mapEvent, pollMs = 700 }) {
    Object.assign(this, { store, v1, mapEvent, pollMs });
    this.syncing = new Map();
    this.closed = false;
    this.timer = setInterval(() => void this.scan(), pollMs);
    this.timer.unref?.();
    void this.scan();
  }

  async scan() {
    if (this.closed || this.scanning) return;
    this.scanning = true;
    try {
      for (const task of await this.store.listDurableSplitTasks()) {
        if (["queued", "running"].includes(task.status)) await this.sync(task);
      }
    } catch (error) { if (!this.closed) console.warn("Durable split observer:", error.message); }
    finally { this.scanning = false; }
  }

  async enqueue({ projectSlug, deck, document }) {
    const request = structuredClone({ projectSlug, projectId: deck.project?.id || deck.deckId,
      expectedRevision: Number(deck.storageRevision ?? deck.revision ?? 0), sourcePath: deck.sourcePath,
      text: document.text, stats: document.stats || null, pageCountAnalysis: deck.pageCountAnalysis || null,
      styleProfile: deck.styleProfile || {}, typographyScale: deck.typographyScale || {} });
    request.inputHash = splitInputHash(request.text, request.styleProfile, request.typographyScale);
    const task = await this.store.createTask({ projectSlug, kind: "split", request,
      input: { workerProtocol: "durable-split-v1", sourcePath: request.sourcePath, deckId: request.projectId,
        baseRevision: request.expectedRevision, inputHash: request.inputHash,
        targetPageCount: request.styleProfile.targetPageCount || null,
        narrativeMode: request.styleProfile.narrativeMode, contentDetailMode: request.styleProfile.contentDetailMode } });
    // The durable outbox is authoritative even if the engine is unavailable.
    // Return admission immediately; the engine submit is short and idempotent.
    void this.sync(task).catch((error) => console.warn("Durable split outbox:", error.message));
    return task;
  }

  async sync(task) {
    if (this.closed) return;
    if (this.syncing.has(task.taskId)) return this.syncing.get(task.taskId);
    const work = this.syncOnce(task).finally(() => this.syncing.delete(task.taskId));
    this.syncing.set(task.taskId, work);
    return work;
  }

  async syncOnce(task) {
    const { projectSlug, taskId } = task;
    try {
      const latest = await this.store.getTask(projectSlug, taskId);
      if (!latest || !["queued", "running"].includes(latest.status)) return;
      let response;
      try { response = await this.v1.request(`/api/tasks/split/${encodeURIComponent(taskId)}?after=${latest.lastEngineEventId || 0}`, { timeoutMs: 10000 }); }
      catch (error) {
        if (error.statusCode !== 404) throw error;
        if (latest.cancelRequested) {
          await this.store.append(projectSlug, taskId, "task.cancelled", { status: "cancelled", message: "未开始的持久拆页请求已取消" });
          return;
        }
        const input = await this.store.readRequest(projectSlug, taskId);
        if (!input) throw Object.assign(new Error("持久拆页请求快照缺失，不能猜测恢复输入"), { statusCode: 409 });
        await this.v1.request("/api/tasks/split", { method: "POST", body: input, timeoutMs: 10000 });
        response = await this.v1.request(`/api/tasks/split/${encodeURIComponent(taskId)}?after=${latest.lastEngineEventId || 0}`, { timeoutMs: 10000 });
      }
      if (response.task?.taskId !== taskId || response.task.projectSlug !== projectSlug || response.task.inputHash !== task.input.inputHash) {
        throw Object.assign(new Error("持久任务返回了不同来源或项目，已拒绝接管"), { statusCode: 409 });
      }
      if (this.closed) return;
      if (latest.cancelRequested && ["queued", "running"].includes(response.task.status)) {
        try { await this.v1.request(`/api/tasks/split/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {}, timeoutMs: 10000 }); }
        catch (error) { if (error.statusCode !== 409) throw error; }
        response = await this.v1.request(`/api/tasks/split/${encodeURIComponent(taskId)}?after=${latest.lastEngineEventId || 0}`, { timeoutMs: 10000 });
      }
      for (const event of response.events || []) {
        if (event.id <= Number(latest.lastEngineEventId || 0)) continue;
        let mapped;
        if (event.type === "complete") {
          try { assertCommittedSplit(event.deck, { projectSlug, projectId: task.input.deckId, expectedRevision: task.input.baseRevision, targetPageCount: task.input.targetPageCount }); }
          catch (error) { error.statusCode = 422; throw error; }
          mapped = this.mapEvent(event);
        } else if (event.type === "cancelled") mapped = { type: "task.cancelled", payload: { status: "cancelled", message: event.message } };
        else if (["queued", "resumed", "recovered"].includes(event.type)) mapped = { type: "split.phase", payload: { status: "queued", phase: "queued", message: event.message || "持久拆页任务等待执行" } };
        else if (["process.started", "process.exited"].includes(event.type)) mapped = null;
        else if (event.type === "cancelling") mapped = { type: "split.phase", payload: { status: "running", phase: "cancelling", message: "正在停止模型进程，等待引擎确认" } };
        else mapped = this.mapEvent(event);
        await this.store.append(projectSlug, taskId, mapped?.type || "split.engine.cursor", { ...(mapped?.payload || {}), engineEventId: event.id });
      }
    } catch (error) {
      if (this.closed) return;
      if ([400, 409, 422].includes(error.statusCode)) {
        await this.store.append(projectSlug, taskId, "task.failed", { status: "failed", message: error.message });
      } else {
        const current = await this.store.getTask(projectSlug, taskId);
        if (current && ["queued", "running"].includes(current.status) && current.phase !== "engine-reconnecting") {
          await this.store.append(projectSlug, taskId, "split.phase", { phase: "engine-reconnecting", message: "引擎暂未连接，持久任务已保留，连接恢复后自动继续" });
        }
      }
    }
  }

  async cancel(task) {
    if (!["queued", "running"].includes(task.status)) return task;
    await this.store.append(task.projectSlug, task.taskId, "task.cancel.requested", {});
    await this.sync(await this.store.getTask(task.projectSlug, task.taskId));
    return this.store.getTask(task.projectSlug, task.taskId);
  }

  async resume(task) {
    if (["queued", "running", "completed"].includes(task.status)) return task;
    try { await this.v1.request(`/api/tasks/split/${encodeURIComponent(task.taskId)}/resume`, { method: "POST", body: {}, timeoutMs: 10000 }); }
    catch (error) {
      if (error.statusCode !== 404) throw error;
      const input = await this.store.readRequest(task.projectSlug, task.taskId);
      if (!input) throw error;
      await this.v1.request("/api/tasks/split", { method: "POST", body: input, timeoutMs: 10000 });
    }
    await this.store.append(task.projectSlug, task.taskId, "task.started", { status: "running", resumed: true });
    await this.sync(await this.store.getTask(task.projectSlug, task.taskId));
    return this.store.getTask(task.projectSlug, task.taskId);
  }

  close() { this.closed = true; clearInterval(this.timer); }
}
