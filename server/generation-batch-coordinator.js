import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { processIdentity } from '../shared/process-identity.js';
import { withLocalLease } from "./local-lease.js";
import { withProjectCatalogLease, readProjectFile, writeFileAtomic, storageRevision } from "./project-repository.js";
import { projectOperationOwnerState } from "./project-operation.js";
import { stopRegisteredProcess } from "../v2/server/durable-split-worker.js";

export const generationExecutionContext = new AsyncLocalStorage();
const ACTIVE = new Set(["queued", "running", "cancelling"]);
const TERMINAL = new Set(["completed", "completed-with-errors", "failed", "interrupted"]);
const conflict = (message) => Object.assign(new Error(message), { statusCode: 409, code: "GENERATION_OWNER_CONFLICT" });
const stamp = () => new Date().toISOString();
const safe = (value) => typeof value === "string" && value && ![".", ".."].includes(value) && !/[\\/\0]/.test(value);
export const generationBatchProjectSlug = (batch = {}) => batch.deck?.project?.slug || batch.deck?.projectSlug || batch.projectSlug || "";
export function serializeGenerationBatch(batch) {
  const { deck, persistChain, ...value } = batch;
  return { ...value, activePageNos: [...(batch.activePageNos || [])], projectSlug: generationBatchProjectSlug(batch),
    deckId: deck?.project?.id || deck?.deckId || batch.deckId || null };
}
export function hydrateGenerationBatch(raw) {
  return { ...raw, total: raw.total ?? raw.queued?.length ?? 0, completed: raw.completed || 0, failed: raw.failed || 0,
    phase: raw.phase || "full", activePageNos: new Set(raw.activePageNos || []), completedPageNos: [...(raw.completedPageNos || [])],
    failedPages: [...(raw.failedPages || [])], queued: raw.queued || [], jobs: raw.jobs || {}, durationSamples: raw.durationSamples || [], deck: null, persistChain: Promise.resolve() };
}

/** JSON batches remain authoritative. A long, process-bound local lease owns
 * dispatch; short per-batch leases fence state changes. Registered child groups
 * must be reconciled before a dead owner's batch can execute again.
 */
export class GenerationBatchCoordinator {
  constructor({ dataDir, runBatch, provider, payload, reconcileJobs = (deck) => deck.generationJobs || {}, keep = 20 }) {
    this.dataDir = path.resolve(dataDir); this.dir = path.join(this.dataDir, "generation-batches");
    this.leaseDb = path.join(this.dataDir, "generation-batch-leases.sqlite");
    this.owner = crypto.randomUUID(); this.pid = process.pid;
    this.processStart = processIdentity(process.pid);
    if (!this.processStart) throw conflict('无法确认当前制作进程身份，请检查系统进程查询权限');
    this.batches = new Map(); this.activeRuns = new Map(); this.runBatch = runBatch; this.provider = provider; this.payload = payload; this.reconcileJobs = reconcileJobs; this.keep = keep;
  }
  file(id) { if (!safe(id)) throw conflict("批次标识无效"); return path.join(this.dir, `${id}.json`); }
  control(id) { this.file(id); return path.join(this.dir, ".control", `${id}.json`); }
  projectDir(slug) { if (!safe(slug)) throw conflict("批次项目标识无效"); return path.join(this.dataDir, "projects", slug); }
  async read(id) { return readProjectFile(this.file(id)); }
  async records() {
    const names = await fs.readdir(this.dir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    return (await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readProjectFile(path.join(this.dir, name))))).filter(Boolean);
  }
  async loadDeck(batch) { return readProjectFile(path.join(this.projectDir(generationBatchProjectSlug(batch)), "deck.json")); }
  active(slug) { return [...this.batches.values()].find((batch) => generationBatchProjectSlug(batch) === slug && ACTIVE.has(batch.status)); }
  async assertProjectIdle(slug) {
    // Call inside the project catalog lease before changing an anchor. Checking
    // only the next generation/start is too late: its input invalidation has
    // already committed and would strand the batch still using that anchor.
    const records = await this.records();
    const live = this.active(slug) || [...this.activeRuns.values()].find((run) => generationBatchProjectSlug(run.batch) === slug);
    const persisted = records.find((record) => generationBatchProjectSlug(record) === slug
      && (ACTIVE.has(record.status) || (record.execution && record.execution.state !== "finished")));
    if (live || persisted) throw conflict("当前项目仍有页面正在生成或校验，请等待结束或停止生成后再调整锚点；本次锚点和已有图片未修改");
  }
  lock(id, run) { return withLocalLease(this.leaseDb, `batch:${id}`, run); }
  async persist(batch) {
    return this.lock(batch.batchId, async () => {
      const current = await this.read(batch.batchId);
      if (current?.execution && ["owner", "attemptId", "pid", "processStart"].some((key) => batch.execution?.[key] !== current.execution[key])) throw conflict("批次执行代次已变化");
      if (current?.execution && current.execution.owner !== this.owner && (current.execution.state !== "finished" || batch.execution?.state !== "finished")) throw conflict("批次由另一个引擎持有，拒绝覆盖任务状态");
      await fs.mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.file(batch.batchId), JSON.stringify(serializeGenerationBatch(batch), null, 2));
    });
  }
  async admit(batch, { catalogHeld = false } = {}) {
    const run = async () => {
      const slug = generationBatchProjectSlug(batch);
      const current = await this.loadDeck(batch);
      if (!current || (current.project?.id || current.deckId) !== (batch.deck?.project?.id || batch.deck?.deckId) || storageRevision(current) !== storageRevision(batch.deck)) throw conflict("生成启动前项目身份或版本已变化");
      for (const other of await this.records()) {
        if (other.projectSlug !== slug) continue;
        if (ACTIVE.has(other.status) || (other.execution?.state !== "finished" && other.execution && projectOperationOwnerState(other.execution) !== "dead")) throw conflict("此项目已有持久生成任务，请等待原任务结束或恢复");
        if (other.execution) {
          for (const child of await this.registeredChildren(other.execution)) {
            if (projectOperationOwnerState(child) !== "dead") throw conflict("旧生成子进程尚未退出或身份未知，禁止启动新任务");
            if (child.processGroup) {
              try { process.kill(-child.pid, 0); }
              catch (error) { if (error.code === "ESRCH") continue; throw conflict("旧生成进程组状态未知"); }
              throw conflict("旧生成进程组仍存在，请先完成安全恢复检查");
            }
          }
        }
      }
      const provider = this.provider();
      batch.execution = { protocol: "generation-owner-v1", owner: this.owner, pid: this.pid, processStart: this.processStart, attemptId: crypto.randomUUID(), state: "admitted", admittedAt: stamp(), providerMode: provider?.mode || null, providerFingerprint: provider?.fingerprint || null };
      batch.execution.childrenFile = path.join(this.dir, ".processes", batch.batchId, `${batch.execution.attemptId}.json`);
      await this.persist(batch); this.batches.set(batch.batchId, batch); return batch;
    };
    return catalogHeld ? run() : withProjectCatalogLease(path.join(this.dataDir, "projects"), run);
  }
  assertOwner(batch) {
    const current = JSON.parse(syncFs.readFileSync(this.file(batch.batchId), "utf8"));
    if (current.execution?.owner !== this.owner || current.execution.attemptId !== batch.execution?.attemptId) throw conflict("生成任务执行所有权已失效");
  }
  async registeredChildren(execution) {
    if (!execution?.childrenFile) {
      if (execution && !["admitted", "finished"].includes(execution.state)) throw conflict("旧执行缺少子进程登记，不能证明没有孤儿进程");
      return [];
    }
    const relative = path.relative(path.join(this.dir, ".processes"), path.resolve(execution.childrenFile));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw conflict("旧批次子进程登记路径无效");
    let segmentPath = this.dir;
    for (const segment of path.relative(this.dir, path.resolve(execution.childrenFile)).split(path.sep)) {
      segmentPath = path.join(segmentPath, segment);
      const info = await fs.lstat(segmentPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isSymbolicLink()) throw conflict("子进程登记路径包含符号链接");
    }
    const info = await fs.lstat(execution.childrenFile).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info && execution.state !== "admitted" && execution.state !== "finished") throw conflict("旧执行缺少子进程登记，不能证明没有孤儿进程");
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw conflict("子进程登记文件不是普通文件");
    const children = await readProjectFile(execution.childrenFile) || [];
    if (!Array.isArray(children)) throw conflict("子进程登记格式不可验证");
    if (children.some((child) => child?.state === "starting" || !Number.isSafeInteger(child?.pid) || child.pid <= 0)) throw conflict("旧模型启动意图尚未登记PID，已停止恢复以防重复调用");
    return children;
  }
  async execute(batch, provider = this.provider(), { recovering = false } = {}) {
    if (this.activeRuns.has(batch.batchId)) return this.activeRuns.get(batch.batchId).promise;
    const controller = new AbortController(); const run = { controller, batch };
    run.promise = withLocalLease(this.leaseDb, `dispatch:${generationBatchProjectSlug(batch)}`, async ({ assertOwner: assertLease }) => {
      let record = await this.read(batch.batchId);
      if (!record) throw conflict("批次尚未持久登记，禁止模型调用");
      if (!ACTIVE.has(record.status)) return; // Another owner may have finished while this contender waited.
      if (recovering && record.execution?.attemptId !== batch.execution?.attemptId) return;
      const prior = record.execution;
      if ((prior?.providerMode && prior.providerMode !== provider.mode) || (prior?.providerFingerprint && prior.providerFingerprint !== provider.fingerprint)) throw conflict("AI 生图配置已变化，禁止沿用旧批次，请重新开始生成");
      if (!prior || prior.protocol !== "generation-owner-v1") throw conflict("旧批次缺少可验证的执行进程身份，禁止盲目恢复");
      if (prior.owner !== this.owner && projectOperationOwnerState(prior) !== "dead") throw conflict("另一个生图引擎仍存活，禁止重复执行");
      if (!recovering && prior.owner !== this.owner) throw conflict("批次需要经过重启恢复检查");
      if (recovering) {
        for (const child of await this.registeredChildren(prior)) await stopRegisteredProcess(child);
        batch.execution = { protocol: "generation-owner-v1", owner: this.owner, pid: this.pid, processStart: this.processStart, attemptId: crypto.randomUUID(), state: "running", recoveredFrom: prior.attemptId, providerMode: provider.mode || prior.providerMode || null, providerFingerprint: provider.fingerprint || prior.providerFingerprint || null };
        batch.execution.childrenFile = path.join(this.dir, ".processes", batch.batchId, `${batch.execution.attemptId}.json`);
        await this.lock(batch.batchId, async () => {
          record = await this.read(batch.batchId);
          if (record.execution?.attemptId !== prior.attemptId) throw conflict("另一个引擎已接管批次");
          await writeFileAtomic(this.file(batch.batchId), JSON.stringify(serializeGenerationBatch(batch)));
        });
      }
      const children = new Map();
      const assertCurrent = () => { assertLease(); this.assertOwner(batch); };
      const persistChildren = () => {
        assertCurrent(); const file = batch.execution.childrenFile;
        syncFs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${crypto.randomUUID()}.tmp`; const fd = syncFs.openSync(temp, "wx");
        try { syncFs.writeFileSync(fd, JSON.stringify([...children.values()])); syncFs.fsyncSync(fd); } finally { syncFs.closeSync(fd); }
        syncFs.renameSync(temp, file);
      };
      const context = { signal: controller.signal, assertOwner: assertCurrent,
        qaRecoveryPageIds: new Set(recovering ? batch.queued.filter((job) => job.qaCandidate?.binding).map((job) => job.pageId) : []),
        beforeSpawn: ({ launchId }) => { if (!launchId) throw conflict("缺少模型启动意图标识"); children.set(launchId, { launchId, state: "starting" }); persistChildren(); },
        registerProcess: ({ pid, processStart, launchId, processGroup = process.platform !== "win32" }) => {
          if (!pid || !processStart) throw conflict("无法登记生图/QA子进程身份");
          if (launchId) children.delete(launchId);
          children.set(pid, { pid, processStart, processGroup, launchId }); persistChildren();
        },
        unregisterProcess: ({ pid, launchId }) => { if (pid) children.delete(pid); if (launchId) children.delete(launchId); persistChildren(); } };
      const pollCancel = async () => {
        if (!controller.signal.aborted && await readProjectFile(this.control(batch.batchId))) {
          batch.status = "cancelling"; controller.abort(new Error("生成任务已取消")); await this.persist(batch);
        }
      };
      await pollCancel();
      const timer = setInterval(() => void pollCancel().catch((error) => controller.abort(error)), 100); timer.unref?.();
      try {
        persistChildren(); batch.execution.state = "running"; await this.persist(batch);
        if (!controller.signal.aborted) await generationExecutionContext.run(context, () => this.runBatch(batch, provider));
        await batch.persistChain;
        for (const child of children.values()) await stopRegisteredProcess(child);
        children.clear(); persistChildren();
        if (controller.signal.aborted) {
          batch.status = this.stopping ? "running" : "interrupted";
          batch.interruptionReason = this.stopping ? "引擎停止，等待安全重启恢复" : "用户取消生成，已停止模型进程";
        }
        batch.execution.state = this.stopping ? "abandoned" : "finished";
        await this.persist(batch);
      } catch (error) {
        for (const child of children.values()) await stopRegisteredProcess(child);
        children.clear(); persistChildren();
        batch.status = "interrupted"; batch.interruptionReason = error.message; batch.execution.state = "finished";
        await this.persist(batch);
        throw error;
      } finally { clearInterval(timer); }
    }, { timeoutMs: 150, pollMs: 25 }).catch(async (error) => {
      if (recovering) await this.lock(batch.batchId, async () => {
        const current = await this.read(batch.batchId);
        if (current?.execution?.attemptId !== batch.execution?.attemptId || projectOperationOwnerState(current.execution) !== "dead") return;
        current.status = "interrupted"; current.interruptionReason = error.message; current.execution.state = "blocked";
        await writeFileAtomic(this.file(batch.batchId), JSON.stringify(current)); batch.status = current.status; batch.interruptionReason = current.interruptionReason;
      });
      throw error;
    }).finally(() => this.activeRuns.delete(batch.batchId));
    this.activeRuns.set(batch.batchId, run); return run.promise;
  }
  async cancel(id, reason = "用户取消生成") {
    const record = await this.read(id); if (!record) throw conflict("批次不存在");
    if (!ACTIVE.has(record.status)) return hydrateGenerationBatch(record);
    await fs.mkdir(path.dirname(this.control(id)), { recursive: true });
    await writeFileAtomic(this.control(id), JSON.stringify({ requestedAt: stamp(), reason }));
    const active = this.activeRuns.get(id);
    if (active) { active.batch.status = "cancelling"; active.controller.abort(new Error(reason)); }
    return { ...hydrateGenerationBatch(record), status: "cancelling" };
  }
  async restore() {
    for (const record of await this.records()) {
      if (this.activeRuns.has(record.batchId)) continue;
      const batch = hydrateGenerationBatch(record); this.batches.set(batch.batchId, batch);
      if (!ACTIVE.has(batch.status)) continue;
      if (batch.execution && projectOperationOwnerState(batch.execution) !== "dead") continue;
      const deck = await this.loadDeck(batch); const provider = this.provider();
      if (!batch.execution || !deck || (deck.project?.id || deck.deckId) !== batch.deckId || !provider.canDispatch || (batch.execution.providerFingerprint && batch.execution.providerFingerprint !== provider.fingerprint) || (provider.fingerprint && !batch.execution.providerFingerprint) || (batch.execution.providerMode && batch.execution.providerMode !== provider.mode)) {
        await this.lock(batch.batchId, async () => {
          const current = await this.read(batch.batchId);
          if (current.execution?.attemptId !== record.execution?.attemptId) return;
          batch.status = "interrupted"; batch.activePageNos = new Set(); batch.interruptionReason = "旧执行身份不可验证、AI 接入设置或项目已变化、生图服务不可用，请确认后重新生成";
          if (!batch.execution) batch.execution = { protocol: "legacy-unverified", state: "blocked" };
          await writeFileAtomic(this.file(batch.batchId), JSON.stringify(serializeGenerationBatch(batch)));
        }); continue;
      }
      batch.deck = deck; const currentJobs = this.reconcileJobs(deck);
      batch.jobs = { ...batch.jobs, ...currentJobs };
      try {
        batch.queued = batch.queued.filter((job) => !["generated", "imported", "dispatched"].includes(batch.jobs[job.pageId]?.status)).map((job) => {
          const current = batch.jobs[job.pageId];
          if (!current || current.status === "stale" || current.promptHash !== job.promptHash) throw conflict("恢复时页面生成输入已变化，禁止沿用旧任务");
          if (["bridge", "openai"].includes(record.execution.providerMode) && !current.qaCandidate?.binding) throw conflict("外部生图请求完成状态不可验证，禁止自动重复派发；请先核对 API/bridge 任务");
          return { ...current, status: "queued", ...(current.qaCandidate?.binding ? { qaCandidate: { ...current.qaCandidate, status: "error" } } : {}) };
        });
      } catch (error) {
        await this.lock(batch.batchId, async () => {
          const current = await this.read(batch.batchId); if (current.execution?.attemptId !== record.execution?.attemptId) return;
          batch.status = "interrupted"; batch.interruptionReason = error.message;
          await writeFileAtomic(this.file(batch.batchId), JSON.stringify(serializeGenerationBatch(batch)));
        }); continue;
      }
      batch.status = "running"; batch.activePageNos = new Set();
      void this.execute(batch, provider, { recovering: true }).catch((error) => console.warn("生图恢复安全停止:", error.message));
    }
  }
  async trim(keep = this.keep) {
    const records = await this.records();
    const terminal = records.filter((record) => TERMINAL.has(record.status) && (!record.execution || record.execution.state === "finished"))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    for (const record of terminal.slice(keep)) await this.lock(record.batchId, async () => {
      const current = await this.read(record.batchId);
      if (!current || !TERMINAL.has(current.status) || (current.execution && current.execution.state !== "finished")) return;
      if ((await this.registeredChildren(current.execution)).length) return;
      const archive = path.join(this.dataDir, "archive", "generation-batches"); await fs.mkdir(archive, { recursive: true });
      await fs.rename(this.file(record.batchId), path.join(archive, `${record.batchId}-${crypto.randomUUID()}.json`));
    });
  }
  async stop() {
    this.stopping = true;
    for (const run of this.activeRuns.values()) { run.batch.status = "cancelling"; run.controller.abort(new Error("引擎停止")); }
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.promise));
  }
}
