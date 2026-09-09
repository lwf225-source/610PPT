import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { withLocalLease } from "./local-lease.js";
import { withProjectCatalogLease, readProjectFile, writeFileAtomic } from "./project-repository.js";
import { assertProjectOperationsIdle } from "./project-operation.js";

const ACTIVE = new Set(["queued", "running", "committing", "cancelling", "pending", "starting"]);
const busy = (message) => Object.assign(new Error(message), { code: "PROJECT_BUSY", statusCode: 409 });
const missing = () => Object.assign(new Error("项目不存在或已经删除"), { code: "PROJECT_NOT_FOUND", statusCode: 404 });
async function stat(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function entries(dir) { try { return await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }

export function validateProjectSlug(value) {
  const slug = String(value || "").trim();
  if (!slug || slug === "." || slug === ".." || /[\\/\0]/.test(slug) || path.basename(slug) !== slug || slug.startsWith(".project-")) throw new Error("项目标识无效");
  return slug;
}

// A retained child registration is not proof of death, even on a terminal task.
// Deletion never kills processes; the owning worker must finish/reconcile first.
function assertChildrenStopped(children) {
  if (!Array.isArray(children)) throw busy("任务子进程记录不可判定，已阻止删除");
  for (const child of children) {
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw busy("任务子进程身份不可判定，已阻止删除");
    for (const target of child.processGroup ? [child.pid, -child.pid] : [child.pid]) {
      try { process.kill(target, 0); }
      catch (error) { if (error.code === "ESRCH") continue; throw busy("任务子进程状态不可判定，已阻止删除"); }
      throw busy("项目仍有任务子进程，请等待退出后再删除");
    }
  }
}
function assertRecordIdle(record) {
  if (ACTIVE.has(record?.status)) throw busy("项目仍有持久任务运行，请先取消或等待结束后再删除");
  assertChildrenStopped(record?.children || []);
}
async function jsonRecords(dir) {
  const records = [];
  for (const entry of await entries(dir)) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw busy("任务记录不是普通文件，已阻止删除");
    const file = path.join(dir, entry.name);
    records.push({ file, record: await readProjectFile(file) });
  }
  return records;
}

// Read the existing queues; this is not a second task registry. New work must
// be admitted under the catalog lease, closing the check/enqueue race.
export async function assertPersistedProjectIdle({ dataDir, slug = null }) {
  await assertProjectOperationsIdle({ dataDir, slug });
  const canonicalDataDir = await fs.realpath(dataDir);
  const matches = (record) => !slug || record?.projectSlug === slug || record?.project?.slug === slug || record?.input?.projectSlug === slug;
  const databasePath = path.join(dataDir, "durable-split", "tasks.sqlite");
  if (await stat(databasePath)) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT project_slug,state_json FROM split_tasks").all()) if (!slug || row.project_slug === slug) assertRecordIdle(JSON.parse(row.state_json));
    } finally { db.close(); }
  }
  for (const { record } of await jsonRecords(path.join(dataDir, "generation-batches"))) {
    if (!matches(record)) continue;
    assertRecordIdle(record);
    const childrenFile = record.execution?.childrenFile;
    if (!childrenFile) continue;
    const childrenRoot = path.resolve(dataDir, "generation-batches", ".processes");
    const relative = path.relative(childrenRoot, path.resolve(childrenFile));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw busy("生图子进程记录路径不可判定，已阻止删除");
    const canonicalRelative = path.join("generation-batches", ".processes", relative);
    await assertSafePath(canonicalDataDir, canonicalRelative);
    const children = await readProjectFile(path.join(canonicalDataDir, canonicalRelative));
    if (children) assertChildrenStopped(children);
    else if (record.execution.state !== "finished") throw busy("生图子进程记录缺失，已阻止删除");
  }
  for (const { record } of await jsonRecords(path.join(dataDir, "export-preview-jobs"))) {
    if (!matches(record)) continue;
    assertRecordIdle(record);
    for (const attempt of record?.attempts || []) {
      if (!attempt.outputDir) continue;
      const projectRoot = path.resolve(canonicalDataDir, "projects", validateProjectSlug(record.projectSlug));
      const realRoot = await fs.realpath(projectRoot).catch((error) => { if (error.code === "ENOENT") return projectRoot; throw error; });
      const from = path.relative(realRoot, path.resolve(attempt.outputDir));
      if (from.startsWith("..") || path.isAbsolute(from)) throw busy("预览子进程记录路径与项目不一致");
      const children = await readProjectFile(path.join(attempt.outputDir, "processes.json"));
      if (children) assertChildrenStopped(children);
    }
  }
  for (const project of await entries(path.join(dataDir, "v2", "projects"))) {
    if (!project.isDirectory()) continue;
    for (const task of await entries(path.join(dataDir, "v2", "projects", project.name, "tasks"))) {
      if (!task.isDirectory()) continue;
      const record = await readProjectFile(path.join(dataDir, "v2", "projects", project.name, "tasks", task.name, "state.json"));
      if (matches(record)) assertRecordIdle(record);
    }
  }
}

async function assertSafePath(dataDir, relative) {
  let current = dataDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if ((await stat(current))?.isSymbolicLink()) throw new Error("拒绝移动符号链接项目或数据目录");
  }
  return stat(current);
}

// The plan is durable before the first rename. A crash leaves source or trash
// copies at recorded locations, never an unrecoverable recursive rm.
async function moveToTrash(dataDir, relatives, metadata) {
  const trashId = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
  const trashDir = path.join(dataDir, "trash", trashId);
  await assertSafePath(dataDir, "trash");
  const moves = [];
  for (const relative of [...new Set(relatives)]) if (await assertSafePath(dataDir, relative)) moves.push({ from: relative, to: relative });
  await fs.mkdir(trashDir, { recursive: true });
  const manifest = { schemaVersion: 1, trashId, createdAt: new Date().toISOString(), status: "moving", ...metadata, moves };
  await writeFileAtomic(path.join(trashDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const move of moves) {
    const destination = path.join(trashDir, move.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(path.join(dataDir, move.from), destination);
  }
  await writeFileAtomic(path.join(trashDir, "manifest.json"), JSON.stringify({ ...manifest, status: "complete" }, null, 2));
  return { trashId, trashPath: trashDir, recoverable: true };
}

const projectLease = (dataDir, slug, run) => withLocalLease(path.join(dataDir, "projects", ".project-locks.sqlite"), path.resolve(dataDir, "projects", slug), run);
async function inspectProject(dataDir, slug, assertProjectIdle) {
  const projectRelative = path.join("projects", slug);
  const archiveRelative = path.join("archive", "projects", slug);
  const projectStat = await assertSafePath(dataDir, projectRelative);
  const archiveStat = await assertSafePath(dataDir, archiveRelative);
  if (!projectStat && !archiveStat) throw missing();
  const deck = await readProjectFile(path.join(dataDir, projectRelative, "deck.json")) || await readProjectFile(path.join(dataDir, archiveRelative, "deck.json"));
  await assertPersistedProjectIdle({ dataDir, slug });
  await assertProjectIdle?.({ slug, projectId: deck?.project?.id || deck?.deckId, projectDir: path.join(dataDir, projectRelative) });
  return { projectRelative, archiveRelative, projectStat, archiveStat };
}

export async function deleteProjectData({ dataDir: root, slug: rawSlug, assertProjectIdle }) {
  const dataDir = path.resolve(root);
  const slug = validateProjectSlug(rawSlug);
  return withProjectCatalogLease(path.join(dataDir, "projects"), () => projectLease(dataDir, slug, async () => {
    const info = await inspectProject(dataDir, slug, assertProjectIdle);
    const batches = (await jsonRecords(path.join(dataDir, "generation-batches"))).filter(({ record }) => record?.projectSlug === slug);
    const latest = await readProjectFile(path.join(dataDir, "latest-deck.json"));
    const latestDeckRemoved = latest?.project?.slug === slug || latest?.projectSlug === slug;
    const trash = await moveToTrash(dataDir, [info.projectRelative, info.archiveRelative, ...batches.map(({ file }) => path.relative(dataDir, file)), ...(latestDeckRemoved ? ["latest-deck.json"] : [])], { kind: "project", projectSlug: slug });
    // Uploads may be shared or referenced by a trashed project; retain them.
    return { slug, projectRemoved: Boolean(info.projectStat), archivedProjectRemoved: Boolean(info.archiveStat), uploadsRemoved: 0, uploadsRetained: true, generationBatchesRemoved: batches.length, latestDeckRemoved, ...trash };
  }));
}

export async function clearAllProjectData({ dataDir: root, assertProjectIdle }) {
  const dataDir = path.resolve(root);
  return withProjectCatalogLease(path.join(dataDir, "projects"), async () => {
    const active = (await entries(path.join(dataDir, "projects"))).filter((item) => item.isDirectory() || item.isSymbolicLink());
    const archived = await entries(path.join(dataDir, "archive", "projects"));
    const slugs = [...new Set([...active, ...archived].map((item) => validateProjectSlug(item.name)))].sort();
    const locked = async (index, run) => index === slugs.length ? run() : projectLease(dataDir, slugs[index], () => locked(index + 1, run));
    return locked(0, async () => {
      // Preflight the complete set before moving any project.
      await assertPersistedProjectIdle({ dataDir });
      for (const slug of slugs) await inspectProject(dataDir, slug, assertProjectIdle);
      await assertProjectIdle?.({ slug: null, projectId: null, projectDir: null });
      const uploads = await entries(path.join(dataDir, "uploads"));
      const batches = await entries(path.join(dataDir, "generation-batches"));
      const temporary = await entries(path.join(dataDir, "archive", "tmp"));
      const latestDeck = Boolean(await stat(path.join(dataDir, "latest-deck.json")));
      const trash = await moveToTrash(dataDir, [...active.map((item) => path.join("projects", item.name)), ...archived.map((item) => path.join("archive", "projects", item.name)), "archive/tmp", "uploads", "generation-batches", "latest-deck.json"], { kind: "all-projects", projectSlugs: slugs });
      for (const dir of ["uploads", "generation-batches", "archive/tmp", "archive/projects"]) await fs.mkdir(path.join(dataDir, dir), { recursive: true });
      // Never move/remove projects itself: it contains the live lease DB/WAL.
      return { projects: active.length, archivedProjects: archived.length, archivedTemporaryFiles: temporary.length, uploads: uploads.filter((item) => item.isFile()).length, generationBatches: batches.filter((item) => item.isFile()).length, latestDeck, ...trash };
    });
  });
}
