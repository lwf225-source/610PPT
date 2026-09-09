import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "610ppt-release-smoke-"));
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
const publicPort = await freePort();
let enginePort = await freePort();
while (enginePort === publicPort) enginePort = await freePort();
const child = spawn(process.execPath, ["v2/server/production.js"], {
  cwd: root,
  env: {
    ...process.env,
    PPT_WORKBENCH_DATA_DIR: dataDir,
    PPT_WORKBENCH_API_PORT: String(publicPort),
    PPT_V2_PORT: String(publicPort),
    PPT_V1_ENGINE_PORT: String(enginePort),
    PPT_V2_V1_BASE_URL: `http://127.0.0.1:${enginePort}`
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
async function waitForReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited early (${child.exitCode})\n${output}`);
    try {
      const health = await fetch(`http://127.0.0.1:${publicPort}/api/health`, { signal: AbortSignal.timeout(1000) });
      const payload = await health.json();
      if (health.ok && payload.ok === true && payload.engine === "connected") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`runtime health timeout\n${output}`);
}
try {
  await waitForReady();
  const page = await fetch(`http://127.0.0.1:${publicPort}/`, { signal: AbortSignal.timeout(2000) });
  const html = await page.text();
  if (!page.ok || !html.includes("610PPT")) throw new Error("workspace page did not render");
  console.log(`runtime smoke passed: public=${publicPort} engine=${enginePort}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.rm(dataDir, { recursive: true, force: true });
}
