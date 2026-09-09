import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { editorialHash } from "./editorial-cache.js";

export const VISUAL_CACHE_RULE_VERSION = "visual-cache-v1";

/** Validate the JSON Schema subset used by the local visual provider contracts. */
export function validateVisualSchema(value, schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) return false;
    return Object.entries(schema.properties || {}).every(([key, child]) => !Object.hasOwn(value, key) || validateVisualSchema(value[key], child));
  }
  if (schema.type === "array") return Array.isArray(value)
    && (schema.minItems === undefined || value.length >= schema.minItems)
    && (schema.maxItems === undefined || value.length <= schema.maxItems)
    && value.every((item) => validateVisualSchema(item, schema.items));
  if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength);
  if (["number", "integer"].includes(schema.type)) return typeof value === "number" && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "null") return value === null;
  return false;
}

/** Conservative image-reference discovery. Unbound/remote/ambiguous references
 * disable reuse; this never fetches any URL. Complete context is also key-bound. */
export function visualCacheReferencePaths(context, prompt, resolveStoredPath) {
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(context);
  const imageEnding = /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i;
  const imageMention = /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|svg)(?:\b|[?#])/i;
  const references = [...new Set(strings.filter((item) => imageEnding.test(item) && !/[\r\n]/.test(item)))];
  if (references.some((item) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(item))) return null;
  for (const item of [...strings, prompt]) {
    const unbound = references.reduce((text, reference) => text.split(reference).join(""), item || "");
    if (imageMention.test(unbound) || /(?:https?:|data:image|file:)/i.test(unbound)) return null;
  }
  try { return references.map((item) => ({ role: "context-reference", path: resolveStoredPath(item) })); } catch { return null; }
}

export async function visualCacheInputKey(input) {
  if (!input?.prompt || !input.schema || !input.modelPolicy?.model || !input.ruleVersion || !Array.isArray(input.files)) return null;
  try {
    const files = [];
    for (const item of input.files) {
      if (!item?.path || !path.isAbsolute(item.path)) return null;
      const bytes = await fs.readFile(item.path);
      files.push({ role: item.role, path: item.path, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    }
    return editorialHash({ ...input, files, cacheRuleVersion: VISUAL_CACHE_RULE_VERSION });
  } catch { return null; }
}

/** Cache is never the acceptance authority. Both fresh and cached values must
 * pass current validation; inputs are byte-checked again after the operation. */
export async function runValidatedVisualCache({ cacheDir, kind, input, validate, generate, cacheable = () => true }) {
  if (!/^[a-z0-9-]+$/.test(kind)) throw new Error("Invalid visual cache kind");
  const key = input ? await visualCacheInputKey(await input()) : null;
  const accepted = (value) => { try { return validate(value) === true; } catch { return false; } };
  const canStore = (value) => { try { return cacheable(value) === true; } catch { return false; } };
  const unchanged = async () => {
    if (key && await visualCacheInputKey(await input()) !== key) {
      throw Object.assign(new Error("视觉审查/编译期间输入已变化，拒绝复用或验收本次结果，请重试"), { code: "VISUAL_INPUT_CHANGED" });
    }
  };
  const cachePath = key && cacheDir ? path.join(cacheDir, `${kind}-${key}.json`) : null;
  if (cachePath) {
    let saved;
    try {
      const stat = await fs.stat(cachePath);
      if (stat.size <= 10_000_000) saved = JSON.parse(await fs.readFile(cachePath, "utf8"));
    } catch { /* absent or corrupt cache is a miss */ }
    if (saved?.version === 1 && saved.key === key && saved.digest === editorialHash(saved.value) && accepted(saved.value) && canStore(saved.value)) {
      await unchanged();
      return { value: saved.value, cache: { key, reuse: "disk", reusedAt: new Date().toISOString(), storedAt: saved.storedAt } };
    }
  }
  const value = await generate();
  if (!accepted(value)) throw new Error("Invalid visual result schema or semantic validation");
  await unchanged();
  let storedAt = null;
  if (cachePath && canStore(value)) {
    const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      storedAt = new Date().toISOString();
      await fs.writeFile(temporary, JSON.stringify({ version: 1, key, digest: editorialHash(value), value, storedAt }), { mode: 0o600 });
      await fs.rename(temporary, cachePath);
    } catch { storedAt = null; await fs.unlink(temporary).catch(() => {}); }
  }
  return { value, cache: { key, reuse: cachePath ? "none" : "bypass", storedAt } };
}
