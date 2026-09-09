import fs from 'node:fs';
import crypto from 'node:crypto';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('business-core-manifest.json', root), 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
if (digest(JSON.stringify(manifest.files)) !== manifest.sha256) throw new Error('通用业务核心清单校验失败');
for (const [name, hash] of Object.entries(manifest.files)) {
  if (!/^(?:server|shared|config|v2|public)\//.test(name) || name.split('/').some(part => !part || part.startsWith('.')) || name.includes('\\')) throw new Error('通用业务核心清单路径无效');
  if (digest(fs.readFileSync(new URL(name, root))) !== hash) throw new Error(`通用业务核心未同步：${name}；请从 business-core 同步后再构建或启动`);
}
export const businessCoreStatus = Object.freeze({ version: manifest.version, sha256: manifest.sha256, files: Object.keys(manifest.files).length });
