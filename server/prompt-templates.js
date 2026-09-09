import { activeRuleBundle } from "./rule-runtime.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = process.env.PPT_WORKBENCH_PROMPTS_DIR
  || path.resolve(__dirname, "../config/prompts");

function readPromptTemplates() {
  if (activeRuleBundle) return structuredClone(activeRuleBundle.payload.promptTemplates);
  const templates = {};
  if (!fs.existsSync(PROMPTS_DIR)) return templates;
  for (const name of fs.readdirSync(PROMPTS_DIR)) {
    if (!name.endsWith(".md")) continue;
    templates[name.slice(0, -3)] = fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
  }
  return templates;
}

export const promptTemplates = readPromptTemplates();

export function reloadPromptTemplates() {
  const next = readPromptTemplates();
  for (const key of Object.keys(promptTemplates)) delete promptTemplates[key];
  Object.assign(promptTemplates, next);
  return promptTemplates;
}

export function promptTemplatesDir() {
  return PROMPTS_DIR;
}

export function renderPrompt(name, vars = {}) {
  const template = promptTemplates[name];
  if (template == null) throw new Error(`提示词模板不存在：${name}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => (
    key in vars && vars[key] != null ? String(vars[key]) : ""
  ));
}
