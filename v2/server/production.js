import "../../shared/business-core-integrity.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createV2App, recoverV2GenerationTasks } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_DIR = path.resolve(__dirname, "..", "..");
const enginePort = Number(process.env.PPT_V1_ENGINE_PORT || 6176);
const publicPort = Number(process.env.PPT_V2_PORT || process.env.PPT_WORKBENCH_API_PORT || 5176);
const engineBaseUrl = process.env.PPT_V2_V1_BASE_URL || `http://127.0.0.1:${enginePort}`;

if (!Number.isInteger(enginePort) || enginePort < 1 || enginePort > 65535 || !Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535 || enginePort === publicPort) {
  throw new Error("V2 公共端口与 V1 引擎端口必须是两个不同的有效端口");
}

async function engineIsReady() {
  try {
    const response = await fetch(`${engineBaseUrl}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForEngine() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await engineIsReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let engine = null;
let stopping = false;
let ownsEngine = false;
let restartTimer = null;
let restarts = [];

function startOwnedEngine() {
  if (stopping || !ownsEngine) return;
  const startedAt = Date.now();
  engine = spawn(process.execPath, ["server/index.js"], {
    cwd: WORKBENCH_DIR,
    env: { ...process.env, PPT_WORKBENCH_API_PORT: String(enginePort), PPT_WORKBENCH_PUBLIC_MODE: "engine" },
    stdio: "inherit"
  });
  console.log(`610PPT owned engine PID: ${engine.pid}`);
  engine.once("exit", (code, signal) => {
    engine = null;
    if (stopping || !ownsEngine) return;
    const now = Date.now();
    if (now - startedAt > 60000) restarts = [];
    restarts = restarts.filter((time) => now - time < 600000);
    restarts.push(now);
    if (restarts.length > 8) {
      console.error("610PPT 引擎在十分钟内反复退出，已停止自动拉起；持久任务保留，请检查引擎日志后重启应用");
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (restarts.length - 1));
    console.warn(`610PPT owned engine exited (${signal || code || "unknown"}); retry in ${delay}ms`);
    restartTimer = setTimeout(async () => {
      if (stopping) return;
      if (await engineIsReady()) {
        // Another launcher owns the replacement. Attach without killing or
        // supervising that external process, now or during app shutdown.
        ownsEngine = false;
        console.log("610PPT attached to an independently restarted engine");
        return;
      }
      startOwnedEngine();
    }, delay);
  });
  engine.once("error", (error) => console.error("610PPT engine launch failed:", error.message));
}

if (await engineIsReady()) {
  console.log(`610PPT V1 engine already available at ${engineBaseUrl}`);
} else {
  ownsEngine = true;
  startOwnedEngine();
}

if (!(await waitForEngine())) {
  console.warn(`610PPT internal generation engine is still starting at ${engineBaseUrl}`);
}

const { app, store, v1, splitWorker } = createV2App({ v1BaseUrl: engineBaseUrl });
const server = app.listen(publicPort, "127.0.0.1", () => {
  console.log(`610PPT V2 workspace: http://127.0.0.1:${server.address().port}`);
  console.log(`610PPT V1 engine: ${engineBaseUrl}`);
  void recoverV2GenerationTasks({ store, v1 })
    .then((tasks) => {
      if (tasks.length) console.log(`610PPT V2 resumed ${tasks.length} generation task(s)`);
    })
    .catch((error) => console.warn(`610PPT V2 task recovery failed: ${error.message}`));
});

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  splitWorker.close();
  console.log(`610PPT V2 received ${signal}; stopping local services`);
  server.close(() => process.exit(0));
  if (ownsEngine && engine && !engine.killed) engine.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
