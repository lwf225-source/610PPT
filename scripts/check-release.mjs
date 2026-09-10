import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { businessCoreStatus } from "../shared/business-core-integrity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md", "LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md",
  "package.json", "package-lock.json", "business-core-manifest.json",
  "install.sh", "uninstall.sh", "install.ps1", "uninstall.ps1",
  "scripts/install-workbench-service.zsh", "scripts/run-workbench-windows.ps1",
  "scripts/com.610ppt.workbench.plist", "v2/server/production.js"
];
for (const name of required) {
  const stat = fs.lstatSync(path.join(root, name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`发布文件无效：${name}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.engines?.node !== "^24.0.0" || pkg.packageManager !== "npm@11.16.0") throw new Error("Node/npm 版本合同不完整");
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("package version 不是语义化版本");

const codexIntegration = fs.readFileSync(path.join(root, "server/codex-integration.js"), "utf8");
if (/"--cd",\s*deps\.PROJECT_ROOT/.test(codexIntegration)) throw new Error("Codex 任务仍可从项目目录启动");
for (const requiredControl of ["CODEX_TOOLLESS_ARGS", "features.shell_tool=false", 'web_search="disabled"', "isolatedCodexRuntime"]) {
  if (!codexIntegration.includes(requiredControl)) throw new Error(`Codex 隔离控制缺失：${requiredControl}`);
}
const generation = fs.readFileSync(path.join(root, "server/generation.js"), "utf8");
for (const requiredControl of ["610ppt-imagegen-runtime-", "features.shell_tool=false", 'web_search="disabled"']) {
  if (!generation.includes(requiredControl)) throw new Error(`Codex 生图隔离控制缺失：${requiredControl}`);
}
if (/--add-dir/.test(generation) || !generation.includes('localCodexImagePrompt(job, "final.png")')) throw new Error("Codex 生图仍暴露项目输出目录");

// Generic privacy rules avoid embedding a developer's own identity in the checker.
const forbidden = [
  new RegExp(["", "(?:Users|home)", "[a-z0-9_.-]+", ""].join("/"), "i"),
  /[a-z]:\\Users\\[^\\\s"']+\\/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];
const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".zsh", ".sh", ".ps1", ".plist", ".yml", ".yaml"]);
const excluded = new Set([".git", "node_modules", "dist-v2"]);
let filesChecked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`发布树不允许符号链接：${path.relative(root, absolute)}`);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) {
      if (stat.size > 50 * 1024 * 1024) throw new Error(`单文件超过 50MB：${path.relative(root, absolute)}`);
      if (!textExtensions.has(path.extname(entry.name).toLowerCase()) && entry.name !== "LICENSE") continue;
      const source = fs.readFileSync(absolute, "utf8");
      for (const pattern of forbidden) if (pattern.test(source)) throw new Error(`发现发布禁用内容（规则 ${forbidden.indexOf(pattern) + 1}）：${path.relative(root, absolute)}`);
      filesChecked += 1;
    }
  }
}
walk(root);
console.log(`release check passed: ${filesChecked} text files; business core ${businessCoreStatus.version} (${businessCoreStatus.files} files)`);
