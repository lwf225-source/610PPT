import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { withLocalLease } from "./local-lease.js";

const queues = new Map();

export function projectConflict(message = "项目已有更新，请重新载入后再保存；本次修改未覆盖新版本") {
  return Object.assign(new Error(message), { statusCode: 409, code: "PROJECT_VERSION_CONFLICT" });
}

export function storageRevision(deck) {
  return Number(deck?.storageRevision ?? deck?.revision ?? 0);
}

export async function readProjectFile(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeFileAtomic(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx");
    try { await handle.writeFile(data, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

// The API owns project mutations. Serialize the entire read/check/build/commit,
// including expensive derived work, rather than merely serializing writeFile.
export async function withProjectCatalogLease(projectsDir, build) {
  await fs.mkdir(projectsDir, { recursive: true });
  return withLocalLease(path.join(projectsDir, ".project-locks.sqlite"), "project-catalog", build);
}

export async function withProjectMutation(projectDir, incoming, build) {
  const key = path.resolve(projectDir);
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => withProjectCatalogLease(path.dirname(projectDir), () => withLocalLease(path.join(path.dirname(projectDir), ".project-locks.sqlite"), key, async () => {
    const current = await readProjectFile(path.join(projectDir, "deck.json"));
    if (current) {
      if ((current.project?.id || current.deckId) !== (incoming.project?.id || incoming.deckId)) {
        throw projectConflict("项目标识与现有项目不一致，已阻止覆盖");
      }
      if (storageRevision(current) !== storageRevision(incoming)) throw projectConflict();
      const revisionsDir = path.join(projectDir, "revisions");
      await fs.mkdir(revisionsDir, { recursive: true });
      const baseline = JSON.stringify(current, null, 2);
      const hash = crypto.createHash("sha256").update(baseline).digest("hex").slice(0, 16);
      await fs.writeFile(path.join(revisionsDir, `baseline-${storageRevision(current)}-${hash}.json`), baseline, { flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    } else if (storageRevision(incoming) > 0) {
      throw projectConflict("原项目不存在，已阻止旧任务重新创建或覆盖项目");
    }
    await fs.mkdir(projectDir, { recursive: true });
    const nextStorageRevision = storageRevision(current) + 1;
    return build({ current, nextStorageRevision });
  })));
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

// deck.json is authoritative and is the final atomic commit point. Sidecars
// are rebuildable exports, NOT independently authoritative database records.
// Full immutable snapshots retain every save, including skipRevision updates.
export async function commitProjectSnapshot(projectDir, deck, artifacts = {}, { beforeCommit } = {}) {
  const revisionsDir = path.join(projectDir, "revisions");
  await fs.mkdir(revisionsDir, { recursive: true });
  const serialized = JSON.stringify(deck, null, 2);
  const snapshot = path.join(revisionsDir, `${String(deck.storageRevision).padStart(8, "0")}-${crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16)}.json`);
  await fs.writeFile(snapshot, serialized, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST" || await fs.readFile(snapshot, "utf8") !== serialized) throw error;
  });
  for (const [name, content] of Object.entries(artifacts)) {
    if (name !== path.basename(name) || name === "deck.json") throw new Error("Invalid derived artifact name");
    await writeFileAtomic(path.join(projectDir, name), content);
  }
  await beforeCommit?.();
  await writeFileAtomic(path.join(projectDir, "deck.json"), serialized);
  return deck;
}

export function newProjectIdentity(title, slugify, requestedSlug = "") {
  const id = `deck-${crypto.randomUUID()}`;
  let readable = "";
  for (const character of slugify(title)) {
    if (Buffer.byteLength(readable + character, "utf8") > 160) break;
    readable += character;
  }
  if (Buffer.byteLength(requestedSlug, "utf8") > 240) throw Object.assign(new Error("项目路径过长，请缩短项目标识"), { statusCode: 400 });
  return {
    id,
    slug: requestedSlug || `${readable || "project"}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${id.slice(5)}`
  };
}
