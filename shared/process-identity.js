import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Compare stable native start times; PID alone must never authorize recovery.
// The only interpolated value is a validated numeric PID. No user text is sent
// to PowerShell, and execFileSync invokes its executable without cmd.exe.
export function processIdentity(pid, { platform = process.platform, env = process.env, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  try {
    if (platform !== 'win32') return run('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim();
    const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const value = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d{15,20}$/.test(value) ? `win32:${value}` : '';
  } catch { return ''; }
}

export function stopWindowsProcessTree(pid, { env = process.env, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid owned process PID');
  return run(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
}
