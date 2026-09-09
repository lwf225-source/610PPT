import { activeRuleBundle } from "./rule-runtime.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PPT_WORKBENCH_STYLE_CONFIG
  || path.resolve(__dirname, "../config/style-bible.json");

function readStyleConfig() {
  if (activeRuleBundle) return structuredClone(activeRuleBundle.payload.styleBible);
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("style-bible config must be a JSON object");
  for (const key of ["version", "typographyScale", "fontProfile", "styleSystems"]) {
    if (!(key in parsed)) throw new Error(`style-bible config missing key: ${key}`);
  }
  return parsed;
}

export const styleConfig = readStyleConfig();

export function reloadStyleConfig() {
  const next = readStyleConfig();
  for (const key of Object.keys(styleConfig)) delete styleConfig[key];
  Object.assign(styleConfig, next);
  return styleConfig;
}

export function styleConfigPath() {
  return CONFIG_PATH;
}
