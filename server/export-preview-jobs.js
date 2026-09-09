import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { processIdentity } from '../shared/process-identity.js';
import { withLocalLease } from "./local-lease.js";
import { readProjectFile, storageRevision, writeFileAtomic, withProjectCatalogLease } from "./project-repository.js";
import { stopRegisteredProcess } from "../v2/server/durable-split-worker.js";

const stamp = () => new Date().toISOString();
const fail = (message) => Object.assign(new Error(message), { statusCode: 409 });
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeSlug = (value) => typeof value === "string" && value && ![".", ".."].includes(value) && !/[\\/\0]/.test(value);
function inputIdentity(input) {
  return digest(JSON.stringify([input.projectId, input.projectSlug, input.storageRevision, input.pptxPath, input.pptxHash, input.mode]));
}

/** Derived-artifact queue, not another project database. The source PPTX and
 * its owning project stay authoritative. This module never writes deck.json,
 * export manifests, source PPTX files or a mutable "latest preview" pointer.
 */
export class ExportPreviewJobs {
  constructor({ dataDir, render, pollMs = 500 }) {
    this.inputDataDir = path.resolve(dataDir);
    syncFs.mkdirSync(this.inputDataDir, { recursive: true });
    this.dataDir = syncFs.realpathSync(this.inputDataDir);
    this.jobsDir = path.join(this.dataDir, "export-preview-jobs");
    this.leaseDb = path.join(this.jobsDir, "leases.sqlite");
    this.render = render;
    this.pollMs = pollMs;
    this.owner = crypto.randomUUID();
    this.stopping = false;
    this.running = false;
  }

  jobPath(jobId) {
    if (!/^export-preview-[a-f0-9]{64}$/.test(jobId || "")) throw fail("预览任务标识无效");
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  async sourceHash(pptxPath) {
    const handle = await fs.open(pptxPath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw fail("导出源文件不是普通文件");
      const hash = crypto.createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await fs.stat(pptxPath);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail("PPTX 在核验时发生变化，请重新导出");
      return hash.digest("hex");
    } finally { await handle.close(); }
  }

  async prepare({ pptxPath, projectSlug, projectId, storageRevision: revision, mode = "image-only", pptxHash } = {}) {
    if (!safeSlug(projectSlug) || !projectId || !Number.isSafeInteger(revision) || revision < 0) throw fail("导出预览缺少项目与版本绑定");
    const dataRoot = await fs.realpath(this.dataDir);
    const projectDir = path.join(dataRoot, "projects", projectSlug);
    if (await fs.realpath(projectDir) !== projectDir) throw fail("导出项目目录不能是符号链接");
    const deck = await readProjectFile(path.join(projectDir, "deck.json"));
    if (!deck || (deck.project?.id || deck.deckId) !== projectId || deck.project?.slug !== projectSlug || storageRevision(deck) < revision) throw fail("导出项目身份或版本不匹配");
    const supplied = path.resolve(String(pptxPath || ""));
    const fromInputRoot = path.relative(this.inputDataDir, supplied);
    const absolute = !fromInputRoot.startsWith("..") && !path.isAbsolute(fromInputRoot)
      ? path.join(dataRoot, fromInputRoot) : supplied;
    const exportsDir = path.join(projectDir, "exports");
    const relative = path.relative(exportsDir, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(absolute).toLowerCase() !== ".pptx") throw fail("预览只能读取所属项目 exports 目录中的 PPTX");
    if (await fs.realpath(absolute) !== absolute || !(await fs.lstat(absolute)).isFile()) throw fail("预览源文件不能是符号链接");
    const hash = await this.sourceHash(absolute);
    if (pptxHash && hash !== pptxHash) throw fail("导出 PPTX 的内容哈希已变化，旧预览任务不能继续");
    const binding = { projectSlug, projectId, storageRevision: revision, mode: String(mode), pptxPath: absolute, pptxHash: hash };
    return { ...binding, jobId: `export-preview-${inputIdentity(binding)}` };
  }

  async enqueue(prepared) {
    return withProjectCatalogLease(path.join(this.dataDir, "projects"), async () => {
    const input = await this.prepare(prepared);
    if (prepared.jobId && prepared.jobId !== input.jobId) throw fail("预览任务绑定已变化");
    await fs.mkdir(this.jobsDir, { recursive: true });
    const job = await withLocalLease(this.leaseDb, input.jobId, async () => {
      const current = await readProjectFile(this.jobPath(input.jobId));
      if (current) return current;
      const next = { ...input, status: "queued", attempts: [], createdAt: stamp(), updatedAt: stamp(), preview: null, error: null, downloadReady: true };
      await writeFileAtomic(this.jobPath(input.jobId), JSON.stringify(next));
      return next;
    });
    void this.tick();
    return job;
    });
  }

  async get(jobId, { projectSlug, projectId } = {}) {
    const job = await readProjectFile(this.jobPath(jobId));
    if (!job) throw Object.assign(new Error("导出预览任务不存在"), { statusCode: 404 });
    if ((projectSlug && job.projectSlug !== projectSlug) || (projectId && job.projectId !== projectId)) throw fail("不能读取其他项目的预览任务");
    return job;
  }

  async update(jobId, build) {
    return withLocalLease(this.leaseDb, jobId, async () => {
      const current = await this.get(jobId);
      const next = await build(current);
      await writeFileAtomic(this.jobPath(jobId), JSON.stringify({ ...next, updatedAt: stamp() }));
      return next;
    });
  }

  async retry(jobId, scope = {}) {
    return withProjectCatalogLease(path.join(this.dataDir, "projects"), async () => {
    const job = await this.get(jobId, scope);
    await this.prepare(job);
    const next = await this.update(jobId, async (current) => {
      if (["queued", "running", "ready"].includes(current.status)) return current;
      // A previous host may have died with LibreOffice still running. Cleanup
      // is performed under the single global renderer lease before execution.
      return { ...current, status: "queued", error: null, preview: null };
    });
    void this.tick();
    return next;
    });
  }

  async start() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    if (!this.timer) { this.timer = setInterval(() => void this.tick(), this.pollMs); this.timer.unref?.(); }
    void this.tick();
    return this;
  }

  async tick() {
    if (this.stopping || this.running) return;
    this.running = true;
    this.active = (async () => {
      try {
        await withLocalLease(this.leaseDb, "single-preview-renderer", async ({ assertOwner }) => {
          const entries = await fs.readdir(this.jobsDir);
          const jobs = (await Promise.all(entries.filter((name) => /^export-preview-[a-f0-9]{64}\.json$/.test(name)).map((name) => readProjectFile(path.join(this.jobsDir, name)))))
            .filter((job) => ["queued", "running"].includes(job?.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          for (const job of jobs) {
            if (this.stopping) break;
            await this.run(job, assertOwner);
          }
        }, { timeoutMs: 100, pollMs: 25 });
      } catch (error) {
        if (error.code !== "LOCAL_MUTATION_BUSY" && !this.stopping) console.warn("Export preview scheduler:", error.message);
      }
    })().finally(() => { this.running = false; });
    await this.active;
  }

  async run(original, assertOwner) {
    const jobId = original.jobId;
    let job = original;
    let attemptId;
    const controller = new AbortController();
    this.controller = controller;
    try {
      // Global lease acquisition proves no live engine owns rendering. Old
      // registered child identities must still be checked before a new attempt.
      const previousAttempt = job.attempts?.at(-1);
      const previousProcesses = previousAttempt?.outputDir
        ? await readProjectFile(path.join(previousAttempt.outputDir, "processes.json")) : null;
      for (const child of previousProcesses || job.children || []) await stopRegisteredProcess(child);
      const input = await this.prepare(job);
      attemptId = crypto.randomUUID();
      const outputDir = path.join(this.dataDir, "projects", job.projectSlug, "previews", jobId, `attempt-${attemptId}`);
      await fs.mkdir(outputDir, { recursive: true });
      if (await fs.realpath(outputDir) !== path.resolve(outputDir)) throw fail("预览输出目录不能是符号链接");
      job = await this.update(jobId, (current) => ({ ...current, status: "running", owner: this.owner, children: [], attemptId,
        attempts: [...current.attempts, { attemptId, outputDir, startedAt: stamp() }], error: null }));
      const children = new Map();
      const persistProcesses = () => {
        const file = path.join(outputDir, "processes.json");
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        const fd = syncFs.openSync(temp, "wx");
        try { syncFs.writeFileSync(fd, JSON.stringify([...children.values()])); syncFs.fsyncSync(fd); }
        finally { syncFs.closeSync(fd); }
        syncFs.renameSync(temp, file);
      };
      const registerProcess = ({ pid, processStart, processGroup = process.platform !== 'win32' }) => {
        if (!processStart) {
          processStart = processIdentity(pid);
        }
        if (!Number.isSafeInteger(pid) || !processStart) throw fail("无法确认预览子进程身份");
        // The child registry is separate from job state so synchronous spawn
        // callbacks can durably register before model/render execution proceeds.
        children.set(pid, { pid, processStart, processGroup });
        persistProcesses();
      };
      const unregisterProcess = ({ pid }) => {
        children.delete(pid);
        persistProcesses();
      };
      const result = await this.render({ ...input, outputDir }, { signal: controller.signal, registerProcess, unregisterProcess });
      controller.signal.throwIfAborted();
      await this.prepare(job); // A source overwritten during rendering is stale.
      if (result?.status === "failed" || !result?.slides?.length) throw new Error(result?.error || "预览渲染没有产生页面图");
      const files = [...result.slides, ...(result.montage ? [result.montage] : [])];
      for (const file of files) {
        const relative = path.relative(outputDir, file);
        if (!path.isAbsolute(file) || relative.startsWith("..") || path.isAbsolute(relative) || !relative || await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw fail("预览结果路径越过本次尝试目录");
      }
      const preview = { status: "ready", jobId, attemptId, pptxHash: job.pptxHash, pptxPath: job.pptxPath,
        projectSlug: job.projectSlug, projectId: job.projectId, storageRevision: job.storageRevision,
        mode: job.mode, dir: outputDir, slides: result.slides, montage: result.montage || null, generatedAt: stamp() };
      assertOwner();
      await writeFileAtomic(path.join(outputDir, "preview.json"), JSON.stringify(preview));
      job = await this.update(jobId, (current) => {
        assertOwner();
        if (current.attemptId !== attemptId) throw fail("预览尝试已被更新，不能覆盖新预览");
        return { ...current, status: "ready", preview, error: null, children: [] };
      });
    } catch (error) {
      if (this.stopping) return; // Keep running record for proven-dead restart recovery.
      await this.update(jobId, (current) => {
        assertOwner();
        return { ...current, status: "failed", error: error.message, preview: null, downloadReady: true };
      });
    } finally { if (this.controller === controller) this.controller = null; }
    return job;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.controller?.abort(Object.assign(new Error("预览引擎正在关闭"), { name: "AbortError" }));
    await this.active;
  }
}
