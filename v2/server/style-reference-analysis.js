import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ROLES = ['cover', 'directory', 'content', 'data', 'process', 'conclusion'];
function valid(result, pages) {
  if (!result?.summary?.trim() || !result.styleSystem || !Array.isArray(result.pages)) return false;
  const ids = new Set(result.pages.map(p => p.id));
  return ids.size === result.pages.length && pages.every(page => result.pages.some(p =>
    p.id === page.id && ROLES.includes(p.role) && typeof p.description === 'string' && p.description.trim() && p.styleSystem));
}

// Checkpoints are tied to actual rendered bytes, metadata and model, never just a filename.
export async function analyzeReferencePages({ pages, metadata, directory, model, analyze, onProgress }) {
  if (!pages.length) throw new Error('没有可分析的参考页');
  const cacheDir = path.join(directory, 'analysis-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const batches = [];
  for (let i = 0; i < pages.length; i += 3) batches.push(pages.slice(i, i + 3));
  const results = new Array(batches.length);
  let next = 0, completed = 0, failure;
  let reports = Promise.resolve();
  const report = () => {
    const progress = { completed, total: pages.length };
    reports = reports.then(() => onProgress?.(progress));
    return reports;
  };
  await report();
  async function worker() {
    while (!failure && next < batches.length) {
      const index = next++, batch = batches[index];
      try {
        const digest = createHash('sha256').update(JSON.stringify({ version: 1, model, metadata,
          pages: batch.map(({ id, metadata }) => ({ id, metadata })) }));
        for (const page of batch) digest.update(createHash('sha256').update(await fs.readFile(page.path)).digest());
        const cachePath = path.join(cacheDir, `${digest.digest('hex')}.json`);
        let result;
        try { result = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch (e) {
          if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
        }
        if (!valid(result, batch)) {
          result = await analyze({ pages: batch, metadata, directory, model });
          if (!valid(result, batch)) throw new Error('视觉分析遗漏了参考页，请重试');
          const temp = `${cachePath}.${randomUUID()}.tmp`;
          await fs.writeFile(temp, JSON.stringify(result), { mode: 0o600 });
          await fs.rename(temp, cachePath);
        }
        results[index] = result;
        completed += batch.length;
        await report();
      } catch (e) { failure ||= e; }
    }
  }
  // Let in-flight batches finish and persist before reporting failure to the caller.
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  if (failure) {
    failure.message += `；已完成 ${completed}/${pages.length} 页，重试将复用已完成部分`;
    throw failure;
  }
  return { summary: results.map(r => r.summary).join('\n').slice(0, 2000),
    styleSystem: results[0].styleSystem,
    pages: batches.flatMap((batch, i) => batch.map(page => results[i].pages.find(p => p.id === page.id))) };
}
