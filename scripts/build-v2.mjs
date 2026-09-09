import { businessCoreStatus } from "../shared/business-core-integrity.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WORKBENCH_BUILD_ID } from "../shared/runtime-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "v2", "public");
const output = path.join(root, "dist-v2");
const staging = await fs.mkdtemp(path.join(root, ".dist-v2-build-"));
try {
  await fs.cp(source, staging, { recursive: true });
  await fs.mkdir(path.join(staging, "shared"), { recursive: true });
  await fs.copyFile(path.join(root, "shared", "task-lifecycle-contract.js"), path.join(staging, "shared", "task-lifecycle-contract.js"));
  await fs.copyFile(path.join(root, "shared", "task-domain-reducer.js"), path.join(staging, "shared", "task-domain-reducer.js"));
  const files = {};
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile()) files[path.relative(staging, absolute)] = crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
      else throw new Error("V2 build does not accept symlink assets");
    }
  }
  await collect(staging);
  const manifest = { ui: "v2", buildId: WORKBENCH_BUILD_ID, businessCore: businessCoreStatus, builtAt: new Date().toISOString(), files };
  await fs.writeFile(path.join(staging, "build-manifest.json"), JSON.stringify(manifest, null, 2));
  // Only replace this script's generated output, never source or project data.
  await fs.rm(output, { recursive: true, force: true });
  await fs.rename(staging, output);
  console.log(`610PPT V2 build ${WORKBENCH_BUILD_ID}: ${Object.keys(files).length} files -> ${output}`);
} finally { await fs.rm(staging, { recursive: true, force: true }); }
