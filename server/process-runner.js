import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { processIdentity, stopWindowsProcessTree } from '../shared/process-identity.js';

export function runProcessWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error("任务已取消"), { name: "AbortError", code: "ABORT_ERR" });
    if (options.signal?.aborted) { reject(abortError()); return; }
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...(options.env || {}) };
    if (options.cloudExecutionTiming) {
      env.PPT_CLOUD_EXECUTION_TIMEOUT_MS = String(options.timeoutMs || 150000);
      env.PPT_CLOUD_QUEUE_TIMEOUT_MS = String(options.queueTimeoutMs || 1800000);
    }
    for (const key of options.unsetEnv || []) delete env[key];
    const grouped = process.platform !== "win32";
    const launchId = randomUUID();
    // Persist intent BEFORE spawning. A crash in the spawn/register gap must
    // leave an explicit unknown launch, never an apparently empty child list.
    try { options.onBeforeSpawn?.({ launchId }); } catch (error) { reject(error); return; }
    let child;
    try { child = spawn(command, args, { cwd: options.cwd, env, windowsHide: true, detached: grouped, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { try { options.onProcessEnd?.({ launchId }); } catch {} reject(error); return; }
    let processStart = "";
    if (child.pid && options.onProcessStart) {
      processStart = processIdentity(child.pid);
    }
    let stdout = "", stderr = "", settled = false, timedOut = false, cancelled = false, executionError = null, killTimer, windowsCleanupError;
    const limit = options.maxOutputCharacters || 6 * 1024 * 1024;
    const append = (existing, chunk) => (existing + chunk.toString("utf8")).slice(0, limit);
    const kill = (signal) => {
      if (!grouped && child.pid) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { stopWindowsProcessTree(child.pid); }
        catch (error) {
          try { process.kill(child.pid, 0); windowsCleanupError = error; }
          catch (probe) { if (probe.code !== 'ESRCH') windowsCleanupError = error; }
        }
        return;
      }
      try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
    };
    const terminate = () => { kill("SIGTERM"); killTimer ??= setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? 4000); killTimer.unref(); };
    const onAbort = () => { cancelled = true; terminate(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = options.timeoutMs || 150000;
    let waitingForCloud = Boolean(options.cloudExecutionTiming), cloudEventBuffer = "";
    let timer = setTimeout(() => { timedOut = true; terminate(); }, waitingForCloud ? (options.queueTimeoutMs || 1800000) : timeoutMs);
    const observeCloudStart = chunk => {
      if (!waitingForCloud) return;
      cloudEventBuffer += chunk.toString("utf8");
      const lines = cloudEventBuffer.split(/\r?\n/); cloudEventBuffer = lines.pop() || "";
      if (cloudEventBuffer.length > 100000) cloudEventBuffer = "";
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "cloud.execution.started") continue;
        waitingForCloud = false; clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs + (options.cloudResultGraceMs ?? 60000));
        break;
      }
    };
    const cleanup = async () => {
      clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener("abort", onAbort);
      // A normally exited leader can leave unref'd descendants with closed
      // stdio. Its `close` event is not proof the owned group has exited.
      if (grouped && child.pid) {
        kill("SIGKILL");
        const deadline = Date.now() + (options.groupExitTimeoutMs ?? 4000);
        for (;;) {
          let unknown = false;
          try { process.kill(-child.pid, 0); }
          catch (error) { if (error.code === "ESRCH") break; unknown = true; }
          // macOS may briefly return EPERM while the killed group disappears.
          // Retry the observation, never interpret unknown as successful exit.
          if (Date.now() >= deadline) throw Object.assign(new Error("任务进程组尚未确认退出，保留登记以阻止重复启动"), { code: unknown ? "PROCESS_GROUP_UNKNOWN" : "PROCESS_GROUP_STILL_RUNNING" });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } else if (cancelled || timedOut || executionError) kill("SIGKILL");
      if (windowsCleanupError) throw Object.assign(new Error('Windows 任务进程树尚未确认退出，保留登记以阻止重复启动'), { code: 'PROCESS_GROUP_UNKNOWN' });
      try { options.onProcessEnd?.({ pid: child.pid, processStart, launchId }); } catch { /* Retaining an exited PID is safe for recovery. */ }
    };
    const notify = (callback, chunk) => { try { callback?.(chunk); } catch { /* Observability cannot break model execution. */ } };
    child.stdout.on("data", (chunk) => { observeCloudStart(chunk); stdout = append(stdout, chunk); notify(options.onStdoutChunk, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); notify(options.onStderrChunk, chunk); });
    const fail = async (error) => { if (settled) return; settled = true; try { await cleanup(); } catch (cleanupError) { error = cleanupError; } error.stdout = stdout; error.stderr = stderr; reject(error); };
    const stopOnError = (error) => {
      if (settled) return;
      executionError ||= error;
      if (child.pid) terminate();
      // `close`, including spawn failure's close, is the only place that
      // releases the registered PID. An I/O failure isn't proof of process exit.
    };
    child.on("error", stopOnError);
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE" && !cancelled && !timedOut) stopOnError(error); });
    child.on("close", async (code) => {
      if (settled) return;
      if (executionError) { fail(executionError); return; }
      if (cancelled) { fail(abortError()); return; }
      if (timedOut) { fail(Object.assign(new Error(waitingForCloud ? "本地连接器排队超时，模型尚未开始执行" : `${options.timeoutLabel || "Codex 拆分"}超时，超过 ${Math.round(timeoutMs / 1000)} 秒`), { code: "ETIMEDOUT" })); return; }
      if (code !== 0) { fail(Object.assign(new Error(`Codex 退出码 ${code}`), { code })); return; }
      settled = true;
      try { await cleanup(); resolve({ stdout, stderr }); }
      catch (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    });
    try { if (child.pid) options.onProcessStart?.({ pid: child.pid, processStart, launchId, processGroup: grouped }); }
    catch (error) { stopOnError(error); child.stdin.destroy(); return; }
    child.stdin.end(input);
    if (options.signal?.aborted) onAbort();
  });
}
