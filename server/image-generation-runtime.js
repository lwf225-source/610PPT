import { image2VisualContractPrompt } from '../shared/image2-visual-contract.js';
import { normalizeImage2RepairFeedback } from '../shared/image2-body-layout.js';

// Canonicalize generated instructions only. The entire visible-copy section is
// opaque, including text that happens to look like a rule or repair request.
export function finalizeImage2BodyPrompt(prompt = '') {
  const current = image2VisualContractPrompt();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^(?:\\d+\\. )?${escape(current)}(?:\\r?\\n)?`, 'gm');
  const legacy = /^(?:\d+\. )?【正文视觉母版统一契约 3\.[0-3]】\r?\n(?:(?!^【)[\s\S])*?可见文案逐字遵守本页锁定文本，不复制母版文字、数字或事实；统一使用整套已确定的字号层级。(?:\r?\n)?/gm;
  const parts = String(prompt).split(/(【必须显示的页面文字】\r?\n[\s\S]*?)(?=【只供模型理解，禁止显示】)/);
  const cleaned = parts.map(part => part.startsWith('【必须显示的页面文字】\n') || part.startsWith('【必须显示的页面文字】\r\n') ? part : part
    .replace(exact, '')
    .replace(legacy, '')
    .replace(/^(本次改动要求|上一轮校验反馈)：(.*)$/gm, (_line, label, value) => `${label}：${normalizeImage2RepairFeedback(value)}`)
  ).join('').trimEnd();
  return `${cleaned}\n\n${current}`;
}

// Compact only proven duplicate copy. The role-labelled whitelist remains the
// exact, sole rendered copy; unknown/legacy prompt formats are left untouched.
export function compactImageGenerationPrompt(prompt = "") {
  const source = String(prompt || "");
  const visible = source.match(/【必须显示的页面文字】\n([\s\S]*?)(?=【只供模型理解，禁止显示】)/);
  if (!visible) return source;
  const section = visible[1];
  const marker = section.match(/逐字锁定清单（共 (\d+) 条，必须全部出现且一字不改）：\n/);
  if (!marker) return source;
  const labelled = section.slice(0, marker.index).split("\n")
    .map((line) => line.match(/^[^\n]+ → 「([^\n]*)」$/)?.[1]).filter((text) => text !== undefined);
  const numbered = section.slice(marker.index + marker[0].length).trim().split("\n");
  const locked = numbered.map((line, index) => line.startsWith(`${index + 1}. `) ? line.slice(`${index + 1}. `.length) : null);
  if (locked.length !== Number(marker[1]) || locked.some((text) => text === null)
    || JSON.stringify(labelled) !== JSON.stringify(locked)) return source;
  let result = source.replace(visible[0], `【必须显示的页面文字】\n${section.slice(0, marker.index)}以上 ${locked.length} 条角色文案必须全部显示，顺序与文字逐字不改。\n`);
  // Some prompt versions repeat the same whitelist a third time in the plan.
  const duplicatePlanLine = `视觉计划锁定文字（必须与逐字清单一致）：${locked.join("｜")}`;
  result = result.split("\n").filter((line) => line !== duplicatePlanLine).join("\n");
  return result;
}

// Keep only timings and counts from JSONL. Never retain model text, tool
// arguments/results, image data, or local paths in diagnostic records.
export function createImageGenerationTelemetry(now = Date.now) {
  const start = now();
  let buffer = "", firstEventMs = null, imageStartedMs = null, imageFinishedMs = null, imageCalls = 0;
  const consume = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event.type !== "string") return;
    const elapsed = Math.max(0, now() - start);
    firstEventMs ??= elapsed;
    const item = event.item || {};
    const toolName = String(item.tool || item.name || "");
    const imageTool = ["image_generation", "image_generation_call"].includes(item.type)
      || /^(?:image_gen[._])?imagegen$/.test(toolName)
      || (item.server === "image_gen" && toolName === "imagegen");
    if (!imageTool) return;
    if (event.type === "item.started") { imageStartedMs ??= elapsed; imageCalls++; }
    if (event.type === "item.completed") imageFinishedMs = elapsed;
  };
  return {
    onStdoutChunk(chunk) {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        consume(line);
      }
      // JSONL metadata is small; discard oversized partial payloads.
      if (buffer.length > 1024 * 1024) buffer = "";
    },
    snapshot() {
      return { firstEventMs, imageStartedMs, imageFinishedMs, imageCalls,
        imageToolElapsedMs: imageStartedMs !== null && imageFinishedMs !== null ? imageFinishedMs - imageStartedMs : null };
    }
  };
}
