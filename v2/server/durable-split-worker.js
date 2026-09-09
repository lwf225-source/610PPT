import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { processIdentity, stopWindowsProcessTree } from '../../shared/process-identity.js';
import { DatabaseSync } from "node:sqlite";
import { splitInputHash } from "../../server/content-candidates.js";
import { withProjectCatalogLease } from "../../server/project-repository.js";

const ACTIVE = new Set(["queued", "running", "committing", "cancelling"]);
const stamp = () => new Date().toISOString();
const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });
const abortError = () => Object.assign(new Error("拆页已取消，已完成的论证地图检查点保留"), { name: "AbortError" });
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function ownerAlive(owner) {
  if (!owner?.pid) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === "EPERM"; }
  const identity = processIdentity(owner.pid);
  // When process identity cannot be checked, fail closed; never steal a live
  // worker solely because its heartbeat is old or the event loop is busy.
  return !identity || identity === owner.process_start;
}
export async function stopRegisteredProcess(child) {
  let exists = true;
  try { process.kill(child.pid, 0); } catch (error) { if (error.code === "ESRCH") exists = false; else throw error; }
  if (!exists) {
    if (child.processGroup) {
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return; throw error; }
      throw conflict("旧模型进程组仍存在但主进程身份不可验证，已停止自动恢复");
    }
    return;
  }
  if (!child.processStart || processIdentity(child.pid) !== child.processStart) throw conflict("旧模型进程身份发生变化，已停止自动恢复");
  if (process.platform === 'win32') {
    stopWindowsProcessTree(child.pid);
    for (let attempt = 0; attempt < 80; attempt++) {
      try { process.kill(child.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw conflict('旧 Windows 模型进程尚未退出，已停止自动恢复以防重复执行');
  }
  const target = child.processGroup ? -child.pid : child.pid;
  const terminated = () => {
    try {
      process.kill(target, 0);
      if (child.processGroup) {
        const rows = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" }).trim().split("\n")
          .map((line) => line.trim().split(/\s+/)).filter(([pgid]) => Number(pgid) === child.pid);
        return rows.length === 0 || rows.every(([, status]) => status?.startsWith("Z"));
      } else {
        const status = execFileSync("ps", ["-p", String(child.pid), "-o", "stat="], { encoding: "utf8" }).trim();
        return status.startsWith("Z");
      }
      return false;
    } catch (error) { return error.code === "ESRCH" || error.status === 1; }
  };
  try { process.kill(target, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let attempt = 0; attempt < 40 && !terminated(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!terminated()) {
    // PID identity was checked immediately before TERM; this same process
    // group remains occupied, so its numeric identity has not been recycled.
    try { process.kill(target, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let attempt = 0; attempt < 40 && !terminated(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!terminated()) throw conflict("旧模型进程尚未退出，已停止自动恢复以防重复执行");
}
function validateInput(input) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(input?.taskId || "") || [".", ".."].includes(input.taskId)) throw conflict("任务标识无效");
  if (!input.projectSlug || !input.projectId || !input.sourcePath || !input.text
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || input.inputHash !== splitInputHash(input.text, input.styleProfile || {}, input.typographyScale || {})) {
    throw conflict("拆页输入缺少项目、版本或来源绑定");
  }
}

/** Durable engine-owned queue. HTTP only admits/observes/cancels persisted work.
 * SQLite transactions atomically commit task state and its ordered event log.
 * A process-identity lease fences independent engine instances and survives
 * SIGKILL. Source/commit reconciliation callbacks remain owned by the engine.
 */
export class DurableSplitWorker {
  constructor({ dataDir, execute, validate = async () => {}, reconcile = async () => null, pollMs = 500, concurrency = 1 }) {
    this.projectsDir = path.resolve(dataDir, "projects");
    this.execute = execute;
    this.validate = validate;
    this.reconcile = reconcile;
    this.pollMs = pollMs;
    this.concurrency = Math.max(1, Math.min(3, Number(concurrency) || 1));
    this.owner = crypto.randomUUID();
    this.processStart = processIdentity(process.pid);
    this.active = new Map();
    this.closed = false;
    this.leader = false;
    this.ticking = false;
    fs.mkdirSync(path.join(dataDir, "durable-split"), { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "durable-split", "tasks.sqlite"));
    this.db.exec("PRAGMA busy_timeout=5000");
    if (this.db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS worker_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, pid INTEGER, process_start TEXT, heartbeat TEXT);
      CREATE TABLE IF NOT EXISTS split_tasks (task_id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, input_json TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS split_events (task_id TEXT NOT NULL, event_id INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(task_id,event_id));`);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  record(taskId) {
    const row = this.db.prepare("SELECT input_json,state_json FROM split_tasks WHERE task_id=?").get(taskId);
    return row ? { input: JSON.parse(row.input_json), state: JSON.parse(row.state_json) } : null;
  }

  allRecords() {
    return this.db.prepare("SELECT input_json,state_json FROM split_tasks").all()
      .map((row) => ({ input: JSON.parse(row.input_json), state: JSON.parse(row.state_json) }));
  }

  get(taskId, after = 0) {
    const record = this.record(taskId);
    if (!record) return null;
    const events = this.db.prepare("SELECT event_json FROM split_events WHERE task_id=? AND event_id>? ORDER BY event_id").all(taskId, Number(after) || 0).map((row) => JSON.parse(row.event_json));
    return { task: record.state, events };
  }

  event(taskId, type, payload = {}, patch = {}) {
    const record = this.record(taskId);
    if (!record) throw Object.assign(new Error("持久拆页任务不存在"), { statusCode: 404 });
    const event = { ...payload, id: record.state.lastEventId + 1, type, createdAt: stamp() };
    const state = { ...record.state, ...patch, lastEventId: event.id, updatedAt: event.createdAt };
    this.db.prepare("INSERT INTO split_events(task_id,event_id,event_json) VALUES(?,?,?)").run(taskId, event.id, JSON.stringify(event));
    this.db.prepare("UPDATE split_tasks SET state_json=? WHERE task_id=?").run(JSON.stringify(state), taskId);
    return state;
  }

  assertLease() {
    const lease = this.db.prepare("SELECT * FROM worker_lease WHERE id=1").get();
    if (!this.leader || lease?.owner !== this.owner) throw conflict("拆页执行租约已失效，禁止继续提交");
  }

  acquireLease() {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM worker_lease WHERE id=1").get();
      if (old?.owner !== this.owner && ownerAlive(old)) return false;
      this.db.prepare("INSERT OR REPLACE INTO worker_lease VALUES(1,?,?,?,?)").run(this.owner, process.pid, this.processStart, stamp());
      return true;
    });
  }

  async start() {
    if (this.closed) throw new Error("拆页 worker 已关闭");
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick().catch((error) => console.error("Durable split worker:", error.message)), this.pollMs);
      this.timer.unref?.();
    }
    await this.tick();
    return this;
  }

  async submit(input) {
    validateInput(input);
    return withProjectCatalogLease(this.projectsDir, async () => {
    if (!this.record(input.taskId)) await this.validate(input);
    const result = this.transaction(() => {
      const existing = this.record(input.taskId);
      if (existing) {
        if (canonicalJson(existing.input) !== canonicalJson(input)) throw conflict("同一任务标识不能用于不同输入");
        return { task: existing.state, reused: true };
      }
      const busy = this.allRecords().find((record) => record.input.projectSlug === input.projectSlug && ACTIVE.has(record.state.status));
      if (busy) throw Object.assign(conflict("该项目已有持久拆页任务运行"), { activeTaskId: busy.state.taskId });
      const state = { taskId: input.taskId, projectSlug: input.projectSlug, projectId: input.projectId, inputHash: input.inputHash,
        expectedRevision: input.expectedRevision, status: "queued", phase: "queued", attempts: 0, lastEventId: 0, createdAt: stamp(), updatedAt: stamp() };
      this.db.prepare("INSERT INTO split_tasks VALUES(?,?,?,?)").run(input.taskId, input.projectSlug, JSON.stringify(input), JSON.stringify(state));
      return { task: this.event(input.taskId, "queued", {}, { status: "queued" }), reused: false };
    });
    void this.tick().catch((error) => console.error("Durable split admission:", error.message));
    return result;
    });
  }

  cancel(taskId) {
    const state = this.transaction(() => {
      const record = this.record(taskId);
      if (!record) throw Object.assign(new Error("持久拆页任务不存在"), { statusCode: 404 });
      if (record.state.status === "committing") throw conflict("拆页已经进入原子提交阶段，不能取消；请等待提交结果");
      if (!ACTIVE.has(record.state.status)) return record.state;
      const status = record.state.status === "queued" ? "cancelled" : "cancelling";
      return this.event(taskId, status, { message: status === "cancelled" ? "排队任务已取消" : "正在停止模型进程" }, { status, cancelRequested: true });
    });
    this.active.get(taskId)?.controller.abort(abortError());
    return { task: state };
  }

  async resume(taskId) {
    return withProjectCatalogLease(this.projectsDir, async () => {
    const record = this.record(taskId);
    if (!record) throw Object.assign(new Error("持久拆页任务不存在"), { statusCode: 404 });
    if (ACTIVE.has(record.state.status) || record.state.status === "completed") return { task: record.state, reused: true };
    // A cancelled/failed task may only resume its ORIGINAL input. It cannot
    // adopt a newer deck revision or silently run against modified source.
    await this.validate(record.input);
    const task = this.transaction(() => {
      const current = this.record(taskId);
      if (ACTIVE.has(current.state.status) || current.state.status === "completed") return current.state;
      const other = this.allRecords().find((item) => item.state.taskId !== taskId && item.input.projectSlug === record.input.projectSlug && ACTIVE.has(item.state.status));
      if (other) throw conflict("该项目已有其他拆页任务，不能同时续跑旧任务");
      return this.event(taskId, "resumed", {}, { status: "queued", phase: "queued", cancelRequested: false, error: null });
    });
    void this.tick().catch((error) => console.error("Durable split resume:", error.message));
    return { task, reused: false };
    });
  }

  async recoverOwnership() {
    // Called only AFTER proving the previous process is gone and atomically
    // replacing its lease. Never restart a task from status/heartbeat alone.
    for (const record of this.allRecords()) {
      if (!["running", "committing", "cancelling"].includes(record.state.status)) continue;
      for (const child of record.state.children || []) await stopRegisteredProcess(child);
      const result = await this.reconcile(record.input, { taskId: record.state.taskId });
      this.transaction(() => {
        this.assertLease();
        const taskId = record.state.taskId;
        if (result) this.event(taskId, "complete", result, { status: "completed", phase: "completed", result });
        else if (record.state.cancelRequested) this.event(taskId, "cancelled", { message: "中断前取消请求已保留" }, { status: "cancelled" });
        else this.event(taskId, "recovered", { message: "执行进程已退出，持久任务已重新排队" }, { status: "queued", phase: "queued", owner: null, children: [] });
      });
    }
  }

  async tick() {
    if (this.closed || this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.leader) {
        if (!this.acquireLease()) return;
        this.leader = true;
        try { await this.recoverOwnership(); }
        catch (error) { this.leader = false; throw error; }
      }
      this.transaction(() => {
        this.assertLease();
        this.db.prepare("UPDATE worker_lease SET heartbeat=? WHERE owner=?").run(stamp(), this.owner);
      });
      for (const [taskId, active] of this.active) {
        if (this.record(taskId)?.state.cancelRequested) active.controller.abort(abortError());
      }
      for (const record of this.allRecords().filter((item) => item.state.status === "queued")) {
        if (this.active.size >= this.concurrency) break;
        const controller = new AbortController();
        const taskId = record.state.taskId;
        const active = { controller, promise: null };
        this.active.set(taskId, active);
        active.promise = this.run(record, controller).finally(() => this.active.delete(taskId));
      }
    } finally { this.ticking = false; }
  }

  async run(record, controller) {
    const { input } = record;
    const taskId = input.taskId;
    let committed = false;
    try {
      this.transaction(() => {
        this.assertLease();
        if (this.record(taskId).state.cancelRequested) throw abortError();
        this.event(taskId, "started", {}, { status: "running", owner: this.owner, attempts: record.state.attempts + 1 });
      });
      const alreadyCommitted = await this.reconcile(input, { taskId });
      if (alreadyCommitted) {
        this.transaction(() => this.event(taskId, "complete", alreadyCommitted, { status: "completed", phase: "completed", result: alreadyCommitted }));
        return;
      }
      await this.validate(input);
      const emit = (event) => {
        if (this.closed || controller.signal.aborted) return;
        if (["complete", "error", "cancelled"].includes(event.type)) throw new Error("终态由持久 worker 控制，执行器不得提前发布");
        this.transaction(() => {
          this.assertLease();
          this.event(taskId, event.type || "phase", event, { phase: event.stage || event.phase || this.record(taskId).state.phase });
        });
      };
      const commit = async (commitResult) => {
        await this.validate(input);
        this.transaction(() => {
          this.assertLease();
          if (controller.signal.aborted || this.record(taskId).state.cancelRequested) throw abortError();
          this.event(taskId, "phase", { stage: "saving", message: "正在原子提交拆页结果" }, { status: "committing", phase: "saving" });
        });
        // Cancel is rejected once committing begins. This is a deliberate
        // linearization point: a successful commit cannot later turn cancelled.
        const beforeCommit = () => {
          this.assertLease();
          if (this.record(taskId).state.status !== "committing") throw conflict("拆页提交权限已改变");
        };
        const result = await commitResult({ beforeCommit });
        if (!result?.deck) throw new Error("持久拆页提交没有返回项目结果");
        this.transaction(() => {
          this.assertLease();
          this.event(taskId, "complete", result, { status: "completed", phase: "completed", result });
        });
        committed = true;
        return result;
      };
      const registerProcess = ({ pid, processStart = processIdentity(pid), processGroup = process.platform !== 'win32' }) => {
        if (!Number.isSafeInteger(pid) || pid < 2 || !processStart) throw conflict("无法确认模型子进程身份");
        this.transaction(() => {
          this.assertLease();
          const children = [...(this.record(taskId).state.children || []).filter((child) => child.pid !== pid), { pid, processStart, processGroup }];
          this.event(taskId, "process.started", {}, { children });
        });
        if (controller.signal.aborted) throw abortError();
      };
      const unregisterProcess = ({ pid }) => this.transaction(() => {
        this.assertLease();
        const children = (this.record(taskId).state.children || []).filter((child) => child.pid !== pid);
        this.event(taskId, "process.exited", {}, { children });
      });
      await this.execute(input, { taskId, signal: controller.signal, emit, commit, registerProcess, unregisterProcess });
      if (!committed) throw new Error("拆页执行结束但未经过持久提交屏障");
    } catch (error) {
      if (this.closed || this.stopping || committed) return;
      try {
        this.transaction(() => {
          this.assertLease();
          const cancelled = controller.signal.aborted || this.record(taskId).state.cancelRequested || error.name === "AbortError";
          const status = cancelled ? "cancelled" : "failed";
          this.event(taskId, cancelled ? "cancelled" : "error", { error: error.message, message: error.message, candidateId: error.candidateId || null }, { status, error: error.message, candidateId: error.candidateId || null });
        });
      } catch (failure) { console.error("Durable split terminal persistence:", failure.message); }
    }
  }

  async stop() {
    if (this.closed) return;
    this.stopping = true;
    clearInterval(this.timer);
    // Keep the lease until executions have observed AbortSignal and stopped.
    // A callback ignoring cancellation must not release its commit authority.
    for (const active of this.active.values()) active.controller.abort(abortError());
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    this.transaction(() => { this.db.prepare("DELETE FROM worker_lease WHERE owner=?").run(this.owner); });
    this.closed = true;
    this.leader = false;
    this.db.close();
  }
}

export function mountDurableSplitRoutes(app, worker) {
  const route = (run) => async (req, res) => {
    try { const result = await run(req); res.status(req.method === "POST" ? 202 : 200).json(result); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.message, activeTaskId: error.activeTaskId || null }); }
  };
  app.post("/api/tasks/split", route((req) => worker.submit(req.body || {})));
  app.get("/api/tasks/split/:taskId", route((req) => {
    const result = worker.get(req.params.taskId, req.query.after);
    if (!result) throw Object.assign(new Error("持久拆页任务不存在"), { statusCode: 404 });
    return result;
  }));
  app.post("/api/tasks/split/:taskId/cancel", route((req) => worker.cancel(req.params.taskId)));
  app.post("/api/tasks/split/:taskId/resume", route((req) => worker.resume(req.params.taskId)));
}
