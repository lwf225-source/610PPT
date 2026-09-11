import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../server/generation.js", import.meta.url), "utf8");

// A logged-in CLI does not expose the native Image Gen tool unless the
// feature is explicitly enabled for this invocation. Keep this close to the
// production argument construction so a future refactor cannot silently
// restore the imageCalls=0 failure mode.
const imageGenerationArgs = source.match(/\.\.\.buildCodexExecBaseArgs\(runtimePolicy\),([\s\S]*?)"--ignore-rules"/);
assert.ok(imageGenerationArgs, "local Codex image-generation args are present");
assert.match(imageGenerationArgs[1], /"--enable",\s*"image_generation"/);
assert.match(source, /localCodexImagePrompt\(job, "final\.png"\)/);
assert.match(source, /recoverExecutionImage\(/);

console.log("PASS local Codex Image Gen explicitly enables image_generation and preserves PNG recovery");
