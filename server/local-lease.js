import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { processIdentity as identity } from '../shared/process-identity.js';
import { DatabaseSync } from "node:sqlite";

const ownIdentity = identity(process.pid);
function alive(lease) {
  try { process.kill(lease.pid, 0); }
  catch (error) { return error.code === "EPERM"; }
  const actual = identity(lease.pid);
  return !actual || !lease.process_start || actual === lease.process_start;
}

/** Cross-process lease for a bounded local mutation, not a wall-clock expiry.
 * PID + process-start identity prevents stale PID reuse. SQLite only holds its
 * transaction while claiming/releasing; the async critical section is fenced
 * by the live owner, not an async transaction on a shared connection.
 */
export async function withLocalLease(databasePath, key, run, { timeoutMs = 10000, pollMs = 40 } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const deadline = Date.now() + timeoutMs;
  try {
  // WAL initialization can return SQLITE_BUSY without honoring busy_timeout
  // when another brand-new connection is changing the journal mode. Yield and
  // retry only initialization; never steal a live task lease based on age.
  db.exec("PRAGMA busy_timeout=50");
  for (;;) {
    try {
      if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS local_leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL)");
      break;
    } catch (error) {
      const sqliteCode = Number(error.errcode) & 255;
      if (![5, 6].includes(sqliteCode) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
  }
  db.exec("PRAGMA busy_timeout=5000");
  } catch (error) { db.close(); throw error; }
  const owner = crypto.randomUUID();
  let acquired = false;
  try {
    while (!acquired) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT * FROM local_leases WHERE key=?").get(key);
        if (!existing || !alive(existing)) {
          db.prepare("INSERT OR REPLACE INTO local_leases VALUES(?,?,?,?)").run(key, owner, process.pid, ownIdentity);
          acquired = true;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (!acquired) {
        if (Date.now() >= deadline) throw Object.assign(new Error("项目正在由另一个本地进程保存，请稍后重试；本次修改未覆盖"), { statusCode: 409, code: "LOCAL_MUTATION_BUSY" });
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    const assertOwner = () => {
      if (db.prepare("SELECT owner FROM local_leases WHERE key=?").get(key)?.owner !== owner) throw Object.assign(new Error("本地写入租约已失效"), { statusCode: 409 });
    };
    return await run({ assertOwner });
  } finally {
    if (acquired) db.prepare("DELETE FROM local_leases WHERE key=? AND owner=?").run(key, owner);
    db.close();
  }
}
