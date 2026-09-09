import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { processIdentity } from '../shared/process-identity.js';
import { readProjectFile, storageRevision, withProjectCatalogLease, writeFileAtomic, projectConflict } from "./project-repository.js";

const validSlug = (slug) => typeof slug === "string" && slug && ![".", ".."].includes(slug) && !/[\\/\0]/.test(slug);
const invalid = (message) => Object.assign(new Error(message), { code: "PROJECT_OPERATION_UNKNOWN", statusCode: 409 });

/** Read-only, conservative PID/start-time check. A reused PID proves the
 * original owner ended; missing identity or an uninspectable live PID does not.
 * No age/heartbeat expiry can steal an active export operation.
 */
export function projectOperationOwnerState(marker) {
  if (!Number.isSafeInteger(marker?.pid) || marker.pid <= 0) return "unknown";
  try { process.kill(marker.pid, 0); }
  catch (error) { return error.code === "ESRCH" ? "dead" : "unknown"; }
  const actual = processIdentity(marker.pid);
  if (!actual || !marker.processStart) return "unknown";
  return actual === marker.processStart ? "live" : "dead";
}

async function operationDirectory(dataDir, { create = false } = {}) {
  const dir = path.resolve(dataDir, "project-operations");
  if (create) await fs.mkdir(dir, { recursive: true });
  const info = await fs.lstat(dir).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw invalid("项目操作登记目录无效，已阻止操作");
  return { dir, exists: Boolean(info) };
}

export async function readProjectOperations({ dataDir, slug = null }) {
  const { dir, exists } = await operationDirectory(dataDir);
  if (!exists) return [];
  const records = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) throw invalid("项目操作登记不是普通文件，无法安全删除");
    const marker = await readProjectFile(path.join(dir, entry.name));
    // Concurrent release may remove an already-listed marker. Cleanup calls
    // this while holding catalog, so no admitted work can disappear/reappear.
    if (!marker) continue;
    if (!validSlug(marker.projectSlug) || !marker.operationId || entry.name !== `${marker.operationId}.json` || marker.status !== "active") throw invalid("项目操作登记损坏，无法安全删除");
    if (!slug || marker.projectSlug === slug) records.push({ ...marker, ownerState: projectOperationOwnerState(marker) });
  }
  return records;
}

// Must be called under the catalog lease by destructive callers. Dead markers
// are harmless audit remnants and do not block deletion or require a new DB.
export async function assertProjectOperationsIdle({ dataDir, slug = null }) {
  for (const operation of await readProjectOperations({ dataDir, slug })) {
    if (operation.ownerState !== "dead") throw Object.assign(new Error(operation.ownerState === "live"
      ? "项目仍在导出或处理文件，请等待结束后再删除"
      : "项目操作进程状态不可判定，已阻止删除"), { code: "PROJECT_BUSY", statusCode: 409 });
  }
}

/** A short admission lease persists a process-bound operation marker. Long
 * packaging runs without holding catalog; regular project CAS remains usable.
 * The caller must release only AFTER all associated work/children have ended.
 */
export async function beginProjectOperation({ dataDir, deck, kind }) {
  const projectSlug = deck?.project?.slug || deck?.projectSlug;
  const projectId = deck?.project?.id || deck?.deckId;
  if (!validSlug(projectSlug) || !projectId || typeof kind !== "string" || !kind.trim()) throw invalid("项目操作缺少项目身份或类型");
  const revision = storageRevision(deck);
  if (!Number.isSafeInteger(revision) || revision < 0) throw projectConflict();
  const projectsDir = path.resolve(dataDir, "projects");
  const operationId = crypto.randomUUID();
  let markerPath;
  await withProjectCatalogLease(projectsDir, async () => {
    const projectDir = path.join(projectsDir, projectSlug);
    const info = await fs.lstat(projectDir).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) throw projectConflict("原项目不存在或项目目录无效，已阻止文件处理");
    const current = await readProjectFile(path.join(projectDir, "deck.json"));
    if (!current || (current.project?.id || current.deckId) !== projectId || (current.project?.slug || current.projectSlug) !== projectSlug || storageRevision(current) !== revision) throw projectConflict("项目身份或版本已变化，请重新载入后再导出");
    const processStart = processIdentity(process.pid);
    if (!processStart) throw invalid("无法登记导出进程身份，请稍后重试");
    const { dir } = await operationDirectory(dataDir, { create: true });
    markerPath = path.join(dir, `${operationId}.json`);
    await writeFileAtomic(markerPath, JSON.stringify({ schemaVersion: 1, operationId, projectId, projectSlug, storageRevision: revision, kind: kind.trim(), status: "active", pid: process.pid, processStart, createdAt: new Date().toISOString() }));
  });
  let released = false;
  return { operationId, async release() {
    if (released) return;
    await withProjectCatalogLease(projectsDir, async () => {
      const current = await readProjectFile(markerPath);
      if (current) {
        if (current.operationId !== operationId || current.pid !== process.pid || current.projectId !== projectId) throw invalid("项目操作登记归属已变化，拒绝移除");
        await fs.unlink(markerPath);
      }
      released = true;
    });
  } };
}
