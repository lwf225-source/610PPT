import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 24 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const INTERNAL_DIRS = new Set(['generation-logs', 'revisions', 'exports', 'codex', 'logs', 'tasks']);
const invalid = () => Object.assign(new Error('导出图片无效：只能使用当前项目内已登记的完整 PNG、JPEG 或 WebP 图片'), { statusCode: 400, code: 'INVALID_EXPORT_IMAGE' });
const requireImage = condition => { if (!condition) throw invalid(); };

function dimensions(width, height) {
  requireImage(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS);
  return { width, height };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
  requireImage(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  let offset = 8, size, depth, channels, interlace, sawData = false, dataEnded = false, palette = false, ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    requireImage(end <= bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    requireImage(/^[A-Za-z]{4}$/.test(type) && crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4));
    const data = bytes.subarray(offset + 8, end - 4);
    if (!size) {
      requireImage(type === 'IHDR' && length === 13);
      size = dimensions(data.readUInt32BE(0), data.readUInt32BE(4));
      depth = data[8];
      const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      requireImage(allowed[data[9]]?.includes(depth) && data[10] === 0 && data[11] === 0 && data[12] <= 1);
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[data[9]];
      palette = data[9] !== 3;
      interlace = data[12];
    } else if (type === 'IHDR') throw invalid();
    else if (type === 'PLTE') {
      requireImage(!sawData && length > 0 && length <= 768 && length % 3 === 0);
      palette = true;
    } else if (type === 'IDAT') {
      requireImage(!dataEnded && palette);
      sawData = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      requireImage(length === 0 && sawData && end === bytes.length);
      ended = true;
      break;
    } else {
      // Unknown critical chunks and animated PNG are outside the static image contract.
      requireImage(type[0] === type[0].toLowerCase() && !['acTL', 'fcTL', 'fdAT'].includes(type));
      if (sawData) dataEnded = true;
    }
    offset = end;
  }
  requireImage(ended);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((size.width - x) / dx));
    const height = Math.max(0, Math.ceil((size.height - y) / dy));
    return { length: Math.ceil(width * depth * channels / 8) + 1, count: width ? height : 0 };
  });
  const expected = rows.reduce((sum, row) => sum + row.length * row.count, 0);
  requireImage(expected > 0 && expected <= MAX_PIXELS * 8 + MAX_DIMENSION * 7);
  const packed = Buffer.concat(compressed);
  const result = inflateSync(packed, { maxOutputLength: expected, info: true });
  requireImage(result.buffer.length === expected && result.engine.bytesWritten === packed.length);
  let cursor = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++, cursor += row.length) requireImage(result.buffer[cursor] <= 4);
  return size;
}

function jpeg(bytes) {
  requireImage(bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8);
  let offset = 2, size, scan = false;
  while (offset < bytes.length) {
    requireImage(bytes[offset++] === 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { requireImage(size && scan && offset === bytes.length); return size; }
    requireImage(marker && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7) && offset + 2 <= bytes.length);
    const length = bytes.readUInt16BE(offset), end = offset + length;
    requireImage(length >= 2 && end <= bytes.length);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      requireImage(!size && length >= 11 && bytes[offset + 2] === 8);
      const components = bytes[offset + 7];
      requireImage([1, 3, 4].includes(components) && length === 8 + 3 * components);
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) throw invalid();
    offset = end;
    if (marker === 0xda) {
      requireImage(size && length >= 6 && length === 6 + 2 * bytes[end - length + 2]);
      scan = true;
      let entropyBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; entropyBytes++; continue; }
        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; entropyBytes++; continue; }
        break;
      }
      requireImage(entropyBytes > 0);
    }
  }
  throw invalid();
}

function webp(bytes) {
  requireImage(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length);
  let offset = 12, size, canvas;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    requireImage(end + (length & 1) <= bytes.length);
    if (type === 'VP8X') {
      requireImage(offset === 12 && length === 10 && !(bytes[start] & 0xc3)
        && bytes.subarray(start + 1, start + 4).every(byte => byte === 0));
      canvas = dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      requireImage(!size && length >= 11 && !(bytes[start] & 1)
        && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])));
      const firstPartition = bytes.readUIntLE(start, 3) >>> 5;
      requireImage(firstPartition > 0 && firstPartition + 10 <= length);
      size = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
    } else if (type === 'VP8L') {
      requireImage(!size && length >= 6 && bytes[start] === 0x2f && !(bytes[start + 4] & 0xe0));
      const bits = bytes.readUInt32LE(start + 1);
      size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else requireImage(['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type) && canvas);
    offset = end + (length & 1);
  }
  requireImage(offset === bytes.length && size && (!canvas || (canvas.width === size.width && canvas.height === size.height)));
  return size;
}

function allowedRelative(root, file) {
  const relative = path.relative(root, file);
  requireImage(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  requireImage(relative.split(path.sep).every(part => !part.startsWith('.') && !INTERNAL_DIRS.has(part.toLowerCase())));
}

/** Read once and return verified bytes, never a filesystem path for the PPTX library. */
export async function loadVerifiedExportImage({ storedPath, projectDir, resolveStoredPath }) {
  let handle;
  try {
    requireImage(typeof storedPath === 'string' && typeof projectDir === 'string' && typeof resolveStoredPath === 'function');
    const extension = path.extname(storedPath).toLowerCase();
    requireImage(Boolean(MIME[extension]));
    const projectInfo = await fs.lstat(projectDir);
    requireImage(projectInfo.isDirectory() && !projectInfo.isSymbolicLink());
    const requested = resolveStoredPath(storedPath);
    allowedRelative(path.resolve(projectDir), path.resolve(requested));
    const root = await fs.realpath(projectDir), actual = await fs.realpath(requested);
    allowedRelative(root, actual);
    requireImage(MIME[path.extname(actual).toLowerCase()] === MIME[extension]);
    handle = await fs.open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    requireImage(before.isFile() && before.size > 0 && before.size <= MAX_BYTES);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      requireImage(bytesRead > 0);
      offset += bytesRead;
    }
    const after = await handle.stat(), current = await fs.stat(actual);
    allowedRelative(root, await fs.realpath(actual));
    requireImage(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && after.dev === current.dev && after.ino === current.ino);
    const mime = MIME[extension];
    const size = mime === 'image/png' ? png(bytes) : mime === 'image/jpeg' ? jpeg(bytes) : webp(bytes);
    return { data: `${mime};base64,${bytes.toString('base64')}`, mime, ...size };
  } catch { throw invalid(); }
  finally { await handle?.close(); }
}
