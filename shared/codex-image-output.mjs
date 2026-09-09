import fs from 'node:fs/promises';
import path from 'node:path';
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the CLI's top-level event binds an output directory to this execution.
// Never infer it from model prose, tool examples, or another task's directory.
export function executionThreadId(stdout) {
  const ids = new Set();
  for (const line of String(stdout).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'thread.started') continue;
    if (typeof event.thread_id !== 'string' || !uuid.test(event.thread_id)) return null;
    ids.add(event.thread_id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validGeneratedPng(bytes) {
  if (bytes.length < 57 || bytes.length > MAX_FILE_BYTES || !bytes.subarray(0,8).equals(pngSignature)) return false;
  let offset = 8, hasHeader = false, hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!hasHeader && (type !== 'IHDR' || length !== 13)) return false;
    if (type === 'IHDR') {
      if (hasHeader || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) return false;
      hasHeader = true;
    }
    if (type === 'IDAT' && length > 0) hasData = true;
    if (type === 'IEND') return length === 0 && hasHeader && hasData && end === bytes.length;
    offset = end;
  }
  return false;
}

export async function recoverExecutionImage({ stdout, startedAt, generatedImagesRoot }) {
  const threadId = executionThreadId(stdout);
  if (!threadId) return { reason: '无法唯一确认本次生成任务的图片目录' };
  if (!Number.isFinite(startedAt) || startedAt <= 0) return { reason: '无法确认本次生成任务的开始时间' };
  try {
    const root = path.resolve(generatedImagesRoot);
    // Reject symlinked roots/ancestors as well as thread directories and files.
    if (await fs.realpath(root) !== root) return { reason: '本次图片目录包含符号链接' };
    const directory = path.join(root, threadId);
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(directory) !== directory) return { reason: '本次图片目录无效' };
    // This is deliberately a single directory read, without recursion or a
    // search of siblings. More than one candidate always needs human review.
    const candidates = (await fs.readdir(directory)).filter(name => /\.png$/i.test(name));
    if (candidates.length !== 1) return { reason: candidates.length ? '本次任务存在多张候选图片，无法自动选择' : '本次任务未找到已保存的 PNG 图片' };
    const file = path.join(directory, candidates[0]);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.mtimeMs < startedAt) return { reason: '本次候选图片的文件类型、大小或生成时间校验失败' };
    const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) return { reason: '本次候选图片在接收时发生变化' };
      const bytes = await handle.readFile();
      if (!validGeneratedPng(bytes)) return { reason: '本次候选图片未通过 PNG 完整性校验' };
      return { bytes, threadId };
    } finally { await handle.close(); }
  } catch (error) {
    return { reason: error.code === 'ENOENT' ? '本次任务未找到已保存的 PNG 图片' : '本次候选图片无法安全读取' };
  }
}
