import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const inFlight = new Map();
const VERSION = 1;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function editorialHash(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

export function argumentMapCheckpointKey({ sourceText, prompt, schema, modelPolicy, validatorPolicy }) {
  return editorialHash({ version: VERSION, sourceHash: editorialHash(String(sourceText || "")), prompt, schema, modelPolicy, validatorPolicy });
}

/** A checkpoint is an optimization, never an authority: revalidate every disk read. */
export async function getArgumentMapCheckpoint({ cacheDir, key, validate, generate, signal, label = "论证地图" }) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid editorial checkpoint key");
  const checkpointPath = path.join(cacheDir, `${key}.json`);
  const pendingKey = path.resolve(checkpointPath);
  const existing = inFlight.get(pendingKey);
  if (existing && !existing.controller.signal.aborted) return waitForCheckpoint(existing, signal, true);
  const entry = { controller: new AbortController(), consumers: 0, promise: null };
  const run = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      if (saved.version === VERSION && saved.key === key && saved.digest === editorialHash(saved.value) && validate(saved.value)) {
        return { value: saved.value, key, reuse: "disk", saved: true };
      }
    } catch { /* Missing, unreadable or corrupt checkpoints must not block regeneration. */ }
    entry.controller.signal.throwIfAborted();
    const value = await generate(entry.controller.signal);
    entry.controller.signal.throwIfAborted();
    if (!validate(value)) throw new Error(`${label}未通过校验，拒绝写入检查点`);
    const temporaryPath = `${checkpointPath}.${crypto.randomUUID()}.tmp`;
    let saved = false;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(temporaryPath, JSON.stringify({ version: VERSION, key, digest: editorialHash(value), value, createdAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, checkpointPath);
      saved = true;
    } catch {
      // Successful model output remains usable when the cache disk is unavailable.
      await fs.unlink(temporaryPath).catch(() => {});
    }
    return { value, key, reuse: "none", saved };
  })();
  entry.promise = run;
  inFlight.set(pendingKey, entry);
  const cleanup = () => { if (inFlight.get(pendingKey) === entry) inFlight.delete(pendingKey); };
  run.then(cleanup, cleanup);
  return waitForCheckpoint(entry, signal, false);
}

function waitForCheckpoint(entry, signal, reused) {
  entry.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      entry.consumers--;
      if (signal?.aborted && entry.consumers === 0) entry.controller.abort(signal.reason);
      if (error) reject(error);
      else resolve({ ...structuredClone(value), ...(reused ? { reuse: "in-flight" } : {}) });
    };
    const abort = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    entry.promise.then((value) => finish(null, value), (error) => finish(error));
  });
}
