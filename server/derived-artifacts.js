import fs from "node:fs/promises";
import path from "node:path";

/** Read/compare actual bytes under the writer's project lease. This is not a
 * metadata cache: every candidate is checked anew, including missing/corrupt files.
 * Immutable history and the authoritative deck commit remain unconditional. */
export async function selectChangedDerivedArtifacts(projectDir, artifacts, { mode = "changed", concurrency = 4 } = {}) {
  if (!["all", "changed"].includes(mode)) throw new TypeError("Derived write mode must be all or changed");
  const entries = Object.entries(artifacts);
  for (const [name, content] of entries) {
    if (name !== path.basename(name) || [".", "..", "deck.json"].includes(name)) throw new Error("Invalid derived artifact name");
    if (typeof content !== "string" && !Buffer.isBuffer(content)) throw new TypeError("Derived artifacts must contain UTF-8 strings or bytes");
  }
  const stats = { mode, totalFiles: entries.length, writtenFiles: 0, unchangedFiles: 0, readBytes: 0, writtenBytes: 0, avoidedWriteBytes: 0 };
  const selected = new Array(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(entries.length, Math.max(1, Math.min(8, Math.floor(Number(concurrency)) || 1))) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++;
      const [name, content] = entries[index];
      const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      let identical = false;
      if (mode === "changed") {
        try {
          const file = path.join(projectDir, name);
          const stat = await fs.lstat(file);
          // Never follow an unexpected symlink outside the project, nor read a
          // malformed huge sidecar just to discover that its length differs.
          if (stat.isFile() && stat.size === expected.length) {
            const actual = await fs.readFile(file);
            stats.readBytes += actual.length;
            identical = actual.equals(expected);
          }
        } catch { /* missing/unreadable/corrupt -> rebuild via normal atomic path */ }
      }
      if (identical) {
        stats.unchangedFiles++;
        stats.avoidedWriteBytes += expected.length;
      } else {
        selected[index] = [name, content];
        stats.writtenFiles++;
        stats.writtenBytes += expected.length;
      }
    }
  }));
  return { artifacts: Object.fromEntries(selected.filter(Boolean)), stats };
}
