import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { summarizePageForEditor } from "./page-copy-contract.js";
import { legacyProjectKey, projectStorageKey, readEventJournal, prepareJournalAppend } from "./task-storage.js";
import { withLocalLease } from "../../server/local-lease.js";
import { reduceTaskLifecycle } from "../../shared/task-lifecycle-contract.js";
import { reduceTaskDomain } from "../../shared/task-domain-reducer.js";

function safeSegment(value) {
  return legacyProjectKey(value);
}

function now() {
  return new Date().toISOString();
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function summarizePage(page = {}) {
  return summarizePageForEditor(page);
}

// Page formatting belongs at the server event boundary, not in browser state
// code. Reuse the editor's authoritative copy projection for new events AND
// older raw-page journals without changing historical bytes on disk.
const pagePayloadAdapters = {
  "split.page.completed": (payload) => ({ ...payload, page: summarizePage(payload.page) }),
  "split.completed": (payload) => ({ ...payload, ...(Array.isArray(payload.pages) ? { pages: payload.pages.map(summarizePage) } : {}) })
};
function normalizedTaskEvent(event) {
  const adapter = pagePayloadAdapters[event.type];
  return adapter ? { ...event, payload: adapter(event.payload || {}) } : event;
}

export function generationTaskHasTerminalScope(task = {}) {
  if (!["generation", "image2-compile"].includes(task?.kind)) return false;
  const total = Math.max(0, Number(task.total || 0));
  const completed = Math.max(0, Number(task.completed || 0));
  const failed = Math.max(0, Number(task.failed || 0));
  const activePageNos = Array.isArray(task.activePageNos) ? task.activePageNos.filter(Boolean) : [];
  const failedPages = Array.isArray(task.failedPages) ? task.failedPages.filter(Boolean) : [];
  const pageFailed = (task.pages || []).some((page) => page?.generationStatus === "failed");
  return total > 0
    && completed >= total
    && failed === 0
    && failedPages.length === 0
    && !pageFailed
    && activePageNos.length === 0;
}

function reduceTaskState(state, event) {
  const normalized = normalizedTaskEvent(event);
  return reduceTaskDomain(reduceTaskLifecycle(state, normalized), normalized);
}

export class TaskEventStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.runtimeId = crypto.randomUUID();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.locks = new Map();
  }

  taskDir(projectSlug, taskId) {
    return path.join(this.dataDir, "v2", "projects", projectStorageKey(projectSlug), "tasks", safeSegment(taskId));
  }

  projectDirs(projectSlug) {
    const root = path.join(this.dataDir, "v2", "projects");
    return [...new Set([projectStorageKey(projectSlug), legacyProjectKey(projectSlug)])].map((key) => path.join(root, key));
  }

  async ownsTask(projectSlug, state, taskDir) {
    const slug = String(projectSlug).trim();
    if (!state) return false;
    if (state.storageIdentityVersion === 2) return state.projectSlug === slug;
    // Legacy state.projectSlug was lossy. Never use that value alone to claim
    // ownership: two Chinese names could have shared the same old directory.
    const journal = await readEventJournal(path.join(taskDir, "events.ndjson"));
    // A completion's slug was supplied by the V1 project, not safeSegment.
    const completedSlugs = journal.events.filter((event) => event.type === "split.completed")
      .map((event) => event.payload?.projectSlug).filter(Boolean);
    if (completedSlugs.length) return completedSlugs.every((value) => value === slug);
    const deck = await readJson(path.join(this.dataDir, "projects", slug, "deck.json"));
    if (deck) {
      const deckId = deck.deckId || deck.id;
      if (state.input?.deckId && deckId) return state.input.deckId === deckId;
      // A source can be reused by multiple projects, so sourcePath alone is
      // not proof that this legacy task belongs to the requested project.
    }
    return false;
  }

  async resolveTask(projectSlug, taskId) {
    for (const projectDir of this.projectDirs(projectSlug)) {
      const taskDir = path.join(projectDir, "tasks", safeSegment(taskId));
      const state = await readJson(path.join(taskDir, "state.json"));
      if (await this.ownsTask(projectSlug, state, taskDir)) return { taskDir, state };
    }
    return null;
  }

  async loadTask(projectSlug, taskId) {
    const resolved = await this.resolveTask(projectSlug, taskId);
    if (!resolved) return null;
    const { taskDir } = resolved;
    const journal = await readEventJournal(path.join(taskDir, "events.ndjson"));
    let state = resolved.state;
    const snapshotEventId = Number(state.lastEventId || 0);
    if (snapshotEventId > (journal.events.at(-1)?.id || 0)) {
      throw new Error("任务快照领先于事件日志，已停止写入以保护任务记录");
    }
    for (const event of journal.events) {
      if (event.id > snapshotEventId) state = reduceTaskState(state, event);
    }
    if (state !== resolved.state) await writeJsonAtomic(path.join(taskDir, "state.json"), state);
    // Expose the original identity even for proven legacy tasks without moving
    // or rewriting their original storage location.
    // Restore attempt timing for old snapshots too; task creation can predate a resume by hours.
    const latestSplitStart = state.kind === "split" ? journal.events.findLast((event) => event.type === "task.started")?.createdAt : null;
    return { taskDir, journal, state: { ...state, ...(latestSplitStart ? { attemptStartedAt: latestSplitStart } : {}), projectSlug: String(projectSlug).trim() } };
  }

  statePath(projectSlug, taskId) {
    return path.join(this.taskDir(projectSlug, taskId), "state.json");
  }

  eventsPath(projectSlug, taskId) {
    return path.join(this.taskDir(projectSlug, taskId), "events.ndjson");
  }

  async withLock(projectSlug, taskId, operation) {
    const key = `${projectStorageKey(projectSlug)}:${safeSegment(taskId)}`;
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => withLocalLease(path.join(this.dataDir, "v2", "task-leases.sqlite"), key, operation, { timeoutMs: 30000, pollMs: 15 }));
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async createTask({ projectSlug, kind, input = {}, request }) {
    const taskId = `${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const state = {
      taskId,
      projectSlug: String(projectSlug).trim(),
      storageIdentityVersion: 2,
      kind,
      status: "queued",
      phase: "queued",
      total: 0,
      completed: 0,
      pages: [],
      input,
      runtimeId: this.runtimeId,
      createdAt: now(),
      updatedAt: now(),
      lastEventId: 0
    };
    if (request) await writeJsonAtomic(path.join(this.taskDir(projectSlug, taskId), "request.json"), { ...request, taskId });
    await writeJsonAtomic(this.statePath(projectSlug, taskId), state);
    await this.append(projectSlug, taskId, "task.created", { kind, status: "queued" });
    return this.getTask(projectSlug, taskId);
  }

  async getTask(projectSlug, taskId) {
    return this.withLock(projectSlug, taskId, async () => (await this.loadTask(projectSlug, taskId))?.state || null);
  }

  async readRequest(projectSlug, taskId) {
    const resolved = await this.resolveTask(projectSlug, taskId);
    return resolved ? readJson(path.join(resolved.taskDir, "request.json")) : null;
  }

  async listActiveTasks() {
    const projectsDir = path.join(this.dataDir, "v2", "projects");
    const projects = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const slugs = new Set();
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      const tasksDir = path.join(projectsDir, project.name, "tasks");
      const entries = await fs.readdir(tasksDir, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const task = await readJson(path.join(tasksDir, entry.name, "state.json"));
        if (task?.projectSlug) slugs.add(task.projectSlug);
      }
    }
    const tasks = (await Promise.all([...slugs].map((slug) => this.listTasks(slug, Number.MAX_SAFE_INTEGER)))).flat();
    return tasks.filter((task) => ["queued", "running"].includes(task.status));
  }

  async listDurableSplitTasks() {
    const projectsDir = path.join(this.dataDir, "v2", "projects");
    const projects = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const tasks = [];
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      const tasksDir = path.join(projectsDir, project.name, "tasks");
      const entries = await fs.readdir(tasksDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const state = await readJson(path.join(tasksDir, entry.name, "state.json"));
        if (state?.kind === "split" && state.input?.workerProtocol === "durable-split-v1") {
          const task = await this.getTask(state.projectSlug, state.taskId);
          if (task) tasks.push(task);
        }
      }
    }
    return tasks;
  }

  async listTasks(projectSlug, limit = 12) {
    const taskIds = new Set();
    for (const projectDir of this.projectDirs(projectSlug)) {
      const entries = await fs.readdir(path.join(projectDir, "tasks"), { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) if (entry.isDirectory()) taskIds.add(entry.name);
    }
    const loadedTasks = await Promise.all([...taskIds].map((taskId) => this.getTask(projectSlug, taskId)));
    const settledTasks = await Promise.all(loadedTasks.filter(Boolean).map(async (task) => {
      if (generationTaskHasTerminalScope(task) && task.status !== "completed") {
        const phase = task.generationPhase || task.input?.phase || (task.kind === "image2-compile" ? "anchors" : "full");
        await this.append(task.projectSlug, task.taskId, "generation.completed", {
          status: "completed",
          total: Number(task.total || 0),
          completed: Number(task.completed || 0),
          failed: 0,
          phase
        });
        await this.append(task.projectSlug, task.taskId, "task.completed", {
          status: "completed",
          recovery: "all-generation-pages-persisted"
        });
        return this.getTask(task.projectSlug, task.taskId);
      }
      const shouldPauseAfterRestart = ["queued", "running"].includes(task.status)
        && task.input?.workerProtocol !== "durable-split-v1"
        && task.runtimeId
        && task.runtimeId !== this.runtimeId;
      if (shouldPauseAfterRestart) {
        await this.append(projectSlug, task.taskId, "task.paused", {
          status: "paused",
          action: ["generation", "image2-compile"].includes(task.kind) && task.batchId
            ? "continue-generation"
            : "restart",
          message: "本地服务已重启，未完成任务已暂停。已返回的页面会保留。"
        });
        return this.getTask(projectSlug, task.taskId);
      }
      const persistedGeneratedPages = task.kind === "generation"
        ? new Set((task.pages || [])
          .filter((page) => page?.generationStatus === "generated")
          .map((page) => page.pageNo)
          .filter(Boolean)).size
        : 0;
      if (persistedGeneratedPages > Number(task.completed || 0)) {
        await this.append(projectSlug, task.taskId, "generation.reconciled", {
          completed: persistedGeneratedPages,
          generatedCount: Math.max(persistedGeneratedPages, Number(task.generatedCount || 0)),
          failed: Number(task.failed || 0)
        });
        return this.getTask(projectSlug, task.taskId);
      }
      // Legacy page events are drafts too. Listing/reopening a task cannot
      // replace an acknowledged project commit with a page-count heuristic.
      return task;
    }));
    return settledTasks
      .filter(Boolean)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
      .slice(0, Math.max(1, Number(limit) || 12));
  }

  async listEvents(projectSlug, taskId, after = 0) {
    return this.withLock(projectSlug, taskId, async () => {
      const resolved = await this.loadTask(projectSlug, taskId);
      return resolved?.journal.events.filter((event) => event.id > Number(after || 0)).map(normalizedTaskEvent) || [];
    });
  }

  async append(projectSlug, taskId, type, payload = {}) {
    return this.withLock(projectSlug, taskId, async () => {
      const resolved = await this.loadTask(projectSlug, taskId);
      if (!resolved) throw new Error("V2 任务不存在、归属无法确认或已被清理");
      const { state: current, taskDir, journal } = resolved;
      if (Number.isSafeInteger(payload.engineEventId) && payload.engineEventId <= Number(current.lastEngineEventId || 0)) {
        return { event: null, state: current, replayed: true };
      }
      const statePath = path.join(taskDir, "state.json");
      const event = normalizedTaskEvent({
        id: Number(current.lastEventId || 0) + 1,
        type,
        payload,
        createdAt: now()
      });
      const next = reduceTaskState(current, event);
      // Any durable event written by this process transfers task ownership to
      // the current runtime. Otherwise a resumed task is paused again the next
      // time listTasks() sees the old runtime id.
      next.runtimeId = this.runtimeId;
      next.storageIdentityVersion = 2;
      const eventsPath = path.join(taskDir, "events.ndjson");
      await fs.mkdir(path.dirname(eventsPath), { recursive: true });
      await prepareJournalAppend(eventsPath, journal);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      await writeJsonAtomic(statePath, next);
      this.events.emit(`${projectStorageKey(projectSlug)}:${safeSegment(taskId)}`, event);
      return { event, state: next };
    });
  }

  subscribe(projectSlug, taskId, listener) {
    const key = `${projectStorageKey(projectSlug)}:${safeSegment(taskId)}`;
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }

  async deleteProject(projectSlug) {
    const segment = projectStorageKey(projectSlug);
    const lockPrefix = `${segment}:`;
    if ([...this.locks.keys()].some((key) => key.startsWith(lockPrefix))) {
      throw new Error("项目仍有任务正在写入，请稍后再删除");
    }
    let existed = false;
    // Delete proven owned tasks only. A lossy legacy bucket may also contain
    // unrelated or unidentifiable tasks, which must remain recoverable.
    for (const projectDir of this.projectDirs(projectSlug)) {
      const tasksDir = path.join(projectDir, "tasks");
      const entries = await fs.readdir(tasksDir, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const taskDir = path.join(tasksDir, entry.name);
        if (!await this.ownsTask(projectSlug, await readJson(path.join(taskDir, "state.json")), taskDir)) continue;
        existed = true;
        await fs.rm(taskDir, { recursive: true, force: true });
      }
      await fs.rmdir(tasksDir).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
      await fs.rmdir(projectDir).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
    }
    for (const eventName of this.events.eventNames()) {
      if (typeof eventName === "string" && eventName.startsWith(lockPrefix)) this.events.removeAllListeners(eventName);
    }
    return existed;
  }

  async clearProjects() {
    if (this.locks.size) throw new Error("仍有项目任务正在写入，请稍后再清空");
    const projectsDir = path.join(this.dataDir, "v2", "projects");
    const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const removed = entries.filter((entry) => entry.isDirectory()).length;
    await fs.rm(projectsDir, { recursive: true, force: true });
    await fs.mkdir(projectsDir, { recursive: true });
    this.events.removeAllListeners();
    return removed;
  }
}

export { safeSegment, summarizePage };
