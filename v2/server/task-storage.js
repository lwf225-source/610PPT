import crypto from "node:crypto";
import fs from "node:fs/promises";

export function legacyProjectKey(value) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  const segment = normalized.replace(/^-+|-+$/g, "").slice(0, 120) || "untitled";
  return [".", ".."].includes(segment) ? "untitled" : segment;
}

export function projectStorageKey(value) {
  const slug = String(value || "").trim();
  if (!slug || slug === "." || slug === ".." || /[\\/\0]/.test(slug)) {
    throw new Error("无效的项目标识");
  }
  if (slug === legacyProjectKey(slug)) return slug;
  // '~' never occurs in a legacy key, so even an ASCII slug that resembles a
  // digest cannot alias a hashed project. Hash the full identity, not its prefix.
  return `~${crypto.createHash("sha256").update(slug).digest("hex")}`;
}

export async function readEventJournal(filePath) {
  const content = await fs.readFile(filePath).catch((error) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  const events = [];
  let offset = 0;
  let previousId = 0;
  while (offset < content.length) {
    const newline = content.indexOf(10, offset);
    const end = newline < 0 ? content.length : newline;
    const line = content.subarray(offset, end).toString("utf8").trim();
    if (line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        if (newline < 0) return { events, content, validBytes: offset, tornTail: true };
        throw new Error(`任务事件日志损坏（字节 ${offset}），已保留原文件`);
      }
      if (!Number.isSafeInteger(event.id) || event.id !== previousId + 1 || typeof event.type !== "string") {
        throw new Error(`任务事件序号不连续（字节 ${offset}），已保留原文件`);
      }
      previousId = event.id;
      events.push(event);
    }
    offset = newline < 0 ? content.length : newline + 1;
  }
  return { events, content, validBytes: content.length, tornTail: false };
}

export async function prepareJournalAppend(filePath, journal) {
  if (journal.tornTail) {
    // Preserve the exact pre-repair journal for diagnosis/recovery. Only an
    // incomplete final record may be removed; interior corruption is fatal.
    await fs.writeFile(`${filePath}.interrupted-${crypto.randomUUID()}.bak`, journal.content, { flag: "wx" });
    await fs.truncate(filePath, journal.validBytes);
  } else if (journal.content.length && journal.content.at(-1) !== 10) {
    await fs.appendFile(filePath, "\n");
  }
}
