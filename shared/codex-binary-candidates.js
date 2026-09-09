import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Always execute a native Windows binary directly, never an npm .cmd/.ps1 shim.
// Official npm layout: github.com/openai/codex/blob/main/codex-cli/bin/codex.js.
export function codexBinaryCandidates({ binary = '', env = process.env, platform = process.platform,
  arch = process.arch, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return [...new Set([binary || env.PPT_WORKBENCH_CODEX_BIN,
    ...(!binary ? ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex', 'codex'] : [])].filter(Boolean))];
  const p = path.win32;
  const environment = name => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] || '';
  const entries = String(environment('PATH')).split(';').map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  const native = value => typeof value === 'string' && /\.exe$/i.test(value) && !/[\0\r\n]/.test(value);
  const resolve = value => {
    if (!value) return [];
    if (p.isAbsolute(value)) return native(value) && exists(value) ? [value] : [];
    if (!/^[\w.-]+$/.test(value) || /\.(cmd|bat|ps1)$/i.test(value)) return [];
    const name = /\.exe$/i.test(value) ? value : `${value}.exe`;
    return entries.map(directory => p.join(directory, name)).filter(exists);
  };
  // An explicit path is authoritative; do not silently run a different account's CLI.
  if (binary) return resolve(binary);
  const candidates = [environment('PPT_WORKBENCH_CODEX_BIN'), environment('CODEX_CLI_PATH'),
    p.join(home, '.codex', 'bin', 'codex.exe'),
    ...['Codex', 'codex'].map(name => p.join(environment('LOCALAPPDATA') || p.join(home, 'AppData', 'Local'), 'Programs', name, 'resources', 'codex.exe'))];
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const moduleRoots = [...entries.map(directory => p.join(directory, 'node_modules')),
    p.join(environment('APPDATA') || p.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules')];
  for (const modules of moduleRoots) {
    const packageName = `codex-win32-${arch === 'arm64' ? 'arm64' : 'x64'}`;
    for (const vendor of [p.join(modules, '@openai', packageName, 'vendor'),
      p.join(modules, '@openai', 'codex', 'node_modules', '@openai', packageName, 'vendor'),
      p.join(modules, '@openai', 'codex', 'vendor')]) {
      for (const subdir of ['bin', 'codex']) candidates.push(p.join(vendor, triple, subdir, 'codex.exe'));
    }
  }
  candidates.push('codex.exe');
  return [...new Set(candidates.flatMap(resolve))];
}
