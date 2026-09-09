import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const failure = (message, statusCode = 400, code = "PROJECT_HISTORY_INVALID") => Object.assign(new Error(message), { statusCode, code });
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const identity = (deck) => deck?.project?.id || deck?.deckId;
const slugOf = (deck) => deck?.project?.slug || deck?.projectSlug;
function revisionOf(deck) {
  const value = deck?.storageRevision ?? deck?.revision;
  if (!(typeof value === "number" || (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw failure("历史版本的存储修订号无效");
  return Number(value);
}
function revisionName(name) {
  if (typeof name !== "string" || name !== path.basename(name) || /[\\/\0]/.test(name)) throw failure("历史版本标识无效");
  const baseline = /^baseline-(0|[1-9]\d*)-([a-f0-9]{16})\.json$/.exec(name);
  const snapshot = /^(\d{8,})-([a-f0-9]{16})\.json$/.exec(name);
  const parsed = baseline || snapshot;
  if (!parsed || !Number.isSafeInteger(Number(parsed[1]))) throw failure("历史版本文件名无效");
  const revision = Number(parsed[1]);
  if (!baseline && parsed[1] !== String(revision).padStart(8, "0")) throw failure("历史版本修订号格式无效");
  return { kind: baseline ? "baseline" : "snapshot", revision, prefix: parsed[2] };
}
async function directory(dir, optional = false) {
  const info = await fs.lstat(dir).catch((error) => { if (optional && error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure("历史版本目录不是普通目录");
  return info;
}
async function readPlain(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if (error.code === "ENOENT") throw failure("历史版本不存在", 404, "PROJECT_HISTORY_NOT_FOUND");
    if (error.code === "ELOOP") throw failure("拒绝读取符号链接历史版本");
    throw error;
  });
  try {
    if (!(await handle.stat()).isFile()) throw failure("历史版本不是普通文件");
    const text = await handle.readFile("utf8");
    let deck;
    try { deck = JSON.parse(text); } catch { throw failure("历史版本内容不是有效 JSON"); }
    if (!deck || typeof deck !== "object" || Array.isArray(deck)) throw failure("历史版本内容无效");
    return { deck, hash: digest(text) };
  } finally { await handle.close(); }
}
async function currentState(projectDir) {
  const dir = path.resolve(projectDir);
  await directory(dir);
  const { deck, hash } = await readPlain(path.join(dir, "deck.json"));
  const projectId = identity(deck), projectSlug = slugOf(deck);
  if (typeof projectId !== "string" || !projectId || projectSlug !== path.basename(dir)) throw failure("当前项目的标识或目录不匹配");
  if (deck.project?.id && deck.deckId && deck.project.id !== deck.deckId) throw failure("当前项目标识存在冲突");
  if (deck.project?.slug && deck.projectSlug && deck.project.slug !== deck.projectSlug) throw failure("当前项目路径标识存在冲突");
  return { dir, deck, projectId, projectSlug, storageRevision: revisionOf(deck), sha256: hash };
}
async function inspectRevision(current, revisionId) {
  const parsed = revisionName(revisionId);
  if (!await directory(path.join(current.dir, "revisions"), true)) throw failure("历史版本不存在", 404, "PROJECT_HISTORY_NOT_FOUND");
  const { deck, hash } = await readPlain(path.join(current.dir, "revisions", revisionId));
  if (identity(deck) !== current.projectId || slugOf(deck) !== current.projectSlug || (deck.project?.id && deck.deckId && deck.project.id !== deck.deckId) || (deck.project?.slug && deck.projectSlug && deck.project.slug !== deck.projectSlug)) throw failure("历史版本属于不同项目");
  if (revisionOf(deck) !== parsed.revision || hash.slice(0, 16) !== parsed.prefix) throw failure("历史版本文件名、内容校验值或修订号不匹配");
  if (parsed.revision > current.storageRevision) throw failure("该快照尚未成为已提交历史", 409, "PROJECT_HISTORY_UNCOMMITTED");
  const isCurrent = hash === current.sha256;
  if (parsed.revision === current.storageRevision && !isCurrent) throw failure("同一存储修订号的历史内容与当前项目冲突", 409, "PROJECT_HISTORY_UNCOMMITTED");
  // Numbered snapshots are written BEFORE deck.json. Their presence alone is
  // never evidence of a successful commit. Baselines are captured from deck.json
  // by a later mutation under the repository lease.
  if (parsed.kind === "snapshot" && !isCurrent) throw failure("该快照缺少已提交依据", 409, "PROJECT_HISTORY_UNCOMMITTED");
  return {
    deck,
    revision: {
      revisionId, kind: parsed.kind === "baseline" ? "baseline" : "current", isCurrent,
      storageRevision: parsed.revision, sha256: hash, projectId: current.projectId, projectSlug: current.projectSlug,
      title: typeof deck.title === "string" ? deck.title : "", pageCount: Array.isArray(deck.pages) ? deck.pages.length : 0,
      updatedAt: deck.updatedAt || null
    }
  };
}
async function assertStillCurrent(current) {
  const after = await currentState(current.dir);
  if (after.sha256 !== current.sha256 || after.projectId !== current.projectId) throw failure("项目在读取历史期间已更新，请刷新后重试", 409, "PROJECT_VERSION_CONFLICT");
}

// Read-only. This is a conservative catalogue, not an audit log: without a
// baseline, old numbered snapshots cannot establish that a commit succeeded.
export async function listCommittedHistory(projectDir) {
  const current = await currentState(projectDir), revisions = [], ignored = [];
  const revisionDir = path.join(current.dir, "revisions");
  const names = await directory(revisionDir, true) ? await fs.readdir(revisionDir) : [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try { revisions.push((await inspectRevision(current, name)).revision); }
    catch (error) {
      if (!error.statusCode) throw error;
      ignored.push({ revisionId: name, reason: error.message, code: error.code });
    }
  }
  revisions.sort((a, b) => b.storageRevision - a.storageRevision || Number(b.isCurrent) - Number(a.isCurrent) || a.revisionId.localeCompare(b.revisionId));
  await assertStillCurrent(current);
  return { projectId: current.projectId, projectSlug: current.projectSlug, currentRevision: current.storageRevision, currentHash: current.sha256, revisions, ignored };
}

// Returns a candidate only. The caller must recheck CAS under the repository
// mutation lease and commit a NEW revision; never overwrite with this old revision.
export async function readCommittedHistory(projectDir, revisionId, { projectId, expectedRevision } = {}) {
  revisionName(revisionId);
  if (typeof projectId !== "string" || !projectId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure("读取历史需提供项目标识与当前存储修订号");
  const current = await currentState(projectDir);
  if (projectId !== current.projectId || expectedRevision !== current.storageRevision) throw failure("项目已有更新或标识不一致，请重新载入历史", 409, "PROJECT_VERSION_CONFLICT");
  const result = await inspectRevision(current, revisionId);
  await assertStillCurrent(current);
  return { ...result, current: { projectId: current.projectId, projectSlug: current.projectSlug, storageRevision: current.storageRevision, sha256: current.sha256 } };
}
