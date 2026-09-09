import { plainTextDraft, plainCopySlots } from "../public/plain-copy.js";
import { CONSULTING_PAGE_LOGICS, consultingCopyBlocks, normalizeConsultingCopyBlueprint, validateConsultingCopyBlueprint } from "../../shared/consulting-copy-ir.js";
import { editedBlueprintLock } from "../public/copy-blueprint-editor.js";

const BLOCK_ROLE_ALIASES = Object.freeze({
  title: "headline",
  headline: "headline",
  标题: "headline",
  主标题: "headline",
  subtitle: "subtitle",
  副标题: "subtitle",
  body: "body",
  正文: "body",
  内容: "body",
  短句: "body",
  展示句: "body",
  解读: "body",
  label: "label",
  标签: "label",
  metric: "metric",
  metrics: "metric",
  kpi: "metric",
  指标: "metric",
  数据: "metric",
  关键指标: "metric",
  关键数字: "metric",
  evidence: "evidence",
  证据: "evidence",
  事实依据: "evidence",
  table: "table",
  表格: "table",
  "table-row": "table-row",
  表格行: "table-row",
  judgment: "judgment",
  判断: "judgment",
  关键发现: "judgment",
  经营读法: "judgment",
  数据读法: "judgment",
  业务判断: "judgment",
  第一印象: "judgment",
  conclusion: "conclusion",
  结论: "conclusion",
  业务含义: "conclusion",
  复盘结论: "conclusion",
  记忆点: "conclusion",
  "bottom-conclusion": "bottom-conclusion",
  底部结论: "bottom-conclusion",
  下一步: "bottom-conclusion",
  行动提醒: "bottom-conclusion",
  收束句: "bottom-conclusion",
  "module-title": "module-title",
  模块: "module-title",
  模块标题: "module-title",
  "key-point": "key-point",
  要点: "key-point",
  关键点: "key-point",
  "flow-node": "flow-node",
  流程节点: "flow-node",
  step: "step",
  步骤: "step",
  phase: "phase",
  阶段: "phase",
  check: "check",
  检查项: "check",
  example: "example",
  案例: "example",
  rule: "rule",
  规则: "rule",
  goal: "goal",
  目标: "goal",
  note: "note",
  备注: "note"
});

const BLOCK_ROLE_LABELS = Object.freeze({
  body: "正文",
  label: "标签",
  metric: "指标",
  evidence: "证据",
  table: "表格",
  "table-row": "表格行",
  judgment: "判断",
  conclusion: "结论",
  "bottom-conclusion": "底部结论",
  "module-title": "模块标题",
  "key-point": "要点",
  "flow-node": "流程节点",
  step: "步骤",
  phase: "阶段",
  check: "检查项",
  example: "案例",
  rule: "规则",
  goal: "目标",
  note: "备注"
});

const PAGE_ROLE_LABELS = Object.freeze({
  "data-native": Object.freeze({ judgment: "数据读法", conclusion: "业务含义", "bottom-conclusion": "下一步", body: "解读", metric: "关键指标" }),
  "business-infographic": Object.freeze({ judgment: "业务判断", conclusion: "业务含义", "bottom-conclusion": "下一步", body: "展示句", metric: "关键指标" }),
  "visual-poster": Object.freeze({ judgment: "第一印象", conclusion: "记忆点", "bottom-conclusion": "收束句", body: "短句", metric: "关键数字" }),
  "content-card": Object.freeze({ judgment: "关键发现", conclusion: "复盘结论", "bottom-conclusion": "行动提醒", body: "展示句", metric: "关键点" })
});

const STRUCTURAL_ROLES = new Set(["headline", "subtitle"]);

function canonicalBlockRole(role = "body") {
  const key = String(role || "body").trim().toLowerCase().replace(/_/g, "-");
  return BLOCK_ROLE_ALIASES[key] || key || "body";
}

function knownCanonicalBlockRole(role = "") {
  const normalized = canonicalBlockRole(role);
  if (STRUCTURAL_ROLES.has(normalized) || BLOCK_ROLE_LABELS[normalized]) return normalized;
  return null;
}

function splitInlineBlockLabel(text = "") {
  const match = String(text || "").trim().match(/^([^:：\n]{1,14})[:：]\s*(.+)$/);
  if (!match) return null;
  const label = match[1].trim();
  const value = match[2].trim();
  if (!label || !value || /^https?$/i.test(label) || /^P\d{1,3}$/i.test(label)) return null;
  return { label, text: value };
}

function roleLabel(role, page = {}) {
  const normalized = canonicalBlockRole(role);
  const labels = PAGE_ROLE_LABELS[page.pageType] || PAGE_ROLE_LABELS["content-card"];
  return labels[normalized] || BLOCK_ROLE_LABELS[normalized] || "正文";
}

function splitPageCopyBlocks(blocks = []) {
  let title = "";
  let subtitle = "";
  const contentBlocks = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const role = canonicalBlockRole(block?.role || "body");
    const text = String(block?.text || "").trim();
    if (!text) continue;
    const inline = splitInlineBlockLabel(text);
    const inlineRole = inline ? knownCanonicalBlockRole(inline.label) : null;
    if ((role === "headline" || inlineRole === "headline") && !title) {
      title = inlineRole === "headline" ? inline.text : text;
      continue;
    }
    if ((role === "subtitle" || inlineRole === "subtitle") && !subtitle) {
      subtitle = inlineRole === "subtitle" ? inline.text : text;
      continue;
    }
    contentBlocks.push({ ...block, role, text });
  }
  return { title, subtitle, contentBlocks };
}

function contentBlocksToText(blocks = [], page = {}) {
  return blocks.map((block) => {
    const role = canonicalBlockRole(block.role || "body");
    const text = String(block.text || "").trim();
    const inline = splitInlineBlockLabel(text);
    if (!STRUCTURAL_ROLES.has(role) && inline) return text;
    return `${roleLabel(role, page)}：${text}`;
  }).filter(Boolean).join("\n");
}

function textToContentBlocks(text = "") {
  const blocks = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^:：]{1,24})[:：](.*)$/);
    const rawRole = match ? match[1].trim() : "body";
    const knownRole = match ? knownCanonicalBlockRole(rawRole) : "body";
    const value = match ? match[2].trim() : line;
    if (!value) continue;
    if (match && !knownRole) blocks.push({ role: "body", text: `${rawRole}：${value}` });
    else if (!STRUCTURAL_ROLES.has(knownRole || "body")) blocks.push({ role: knownRole || "body", text: value });
  }
  return blocks;
}

// A flat editor is a view of semantic fields, not a replacement for the
// blueprint. Keep ownership even when two modules contain identical copy.
function blueprintSlots(copy = {}) {
  const slots = [];
  const add = (path, role, text, maxLength) => {
    if (typeof text === "string" && text.trim()) slots.push({ path, role, text, maxLength });
  };
  add(["lead"], "judgment", copy.lead, 260);
  (copy.modules || []).forEach((module, index) => {
    add(["modules", index, "label"], "label", module.label, 80);
    add(["modules", index, "headline"], "module-title", module.headline, 160);
    add(["modules", index, "body"], "body", module.body, 260);
    (module.items || []).forEach((text, itemIndex) => add(["modules", index, "items", itemIndex], "key-point", text, 180));
  });
  add(["example"], "example", copy.example, 260);
  (copy.evidence || []).forEach((text, index) => add(["evidence", index], "evidence", text, 240));
  add(["boundary"], "rule", copy.boundary, 260);
  (copy.bottomTakeaways || []).forEach((text, index) => add(["bottomTakeaways", index], "bottom-conclusion", text, 180));
  return slots;
}

function hasBlueprint(page) {
  return page.copyBlueprint && typeof page.copyBlueprint === "object" && Array.isArray(page.copyBlueprint.modules);
}

function copyEditError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, code: "COPY_STRUCTURE_CONFLICT" });
}

function requireTextFits(value, limit, label) {
  if (value.length > limit) throw copyEditError(`${label}超过 ${limit} 字，请缩短后保存；原文未改动。`, 400);
}

function resolvedCopyDraft(draft, page) {
  const current = pageCopyDraftFromPage(page);
  return Object.fromEntries(["title", "subtitle", "displayText"].map((field) => [field, String(draft[field] ?? current[field] ?? "").trim()]));
}

export function isPageCopyDraftUnchanged(draft = {}, page = {}) {
  if (draft.copyEditMode === "plain") {
    const current = plainTextDraft(page);
    return draft.title === current.title && draft.bodyText === current.bodyText;
  }
  if (Object.prototype.hasOwnProperty.call(draft, "copyBlueprint")) {
    return draft.copyEditMode === "structured" && JSON.stringify(draft.copyBlueprint) === JSON.stringify(page.copyBlueprint);
  }
  const current = pageCopyDraftFromPage(page);
  const next = resolvedCopyDraft(draft, page);
  return ["title", "subtitle", "displayText"].every((field) => next[field] === current[field].trim());
}

export function pageCopyDraftFromPage(page = {}) {
  if (hasBlueprint(page)) {
    const copy = page.copyBlueprint;
    return {
      title: String(copy.title ?? page.title ?? "").trim(),
      subtitle: String(copy.subtitle ?? "").trim(),
      // Always include the role prefix: a colon inside source copy is content,
      // not an editor field label.
      displayText: blueprintSlots(copy).map((slot) => `${roleLabel(slot.role, page)}：${slot.text}`).join("\n")
    };
  }
  const split = splitPageCopyBlocks(page.blocks);
  return {
    title: String(page.title || split.title || "").trim(),
    subtitle: String(split.subtitle || page.subtitle || "").trim(),
    displayText: contentBlocksToText(split.contentBlocks, page) || String(page.displayText || "").trim()
  };
}

export function pageBlocksFromCopyDraft(draft = {}, fallbackTitle = "") {
  const title = String(draft.title || fallbackTitle || "待填写页面标题").trim();
  const subtitle = String(draft.subtitle || "").trim();
  const blocks = [{ role: "headline", text: title }];
  if (subtitle) blocks.push({ role: "subtitle", text: subtitle });
  return [...blocks, ...textToContentBlocks(draft.displayText)];
}

export function consultingCopyFromDraft(draft = {}, page = {}) {
  if (draft.copyEditMode === "plain") return plainCopyFromDraft(draft, page);
  if (Object.prototype.hasOwnProperty.call(draft, "copyBlueprint")) return structuredCopyFromDraft(draft, page);
  if (hasBlueprint(page)) {
    const original = page.copyBlueprint;
    const copy = structuredClone(original);
    if (isPageCopyDraftUnchanged(draft, page)) return copy;
    const next = resolvedCopyDraft(draft, page);
    if (!next.title) throw copyEditError("页面主标题不能为空", 400);
    requireTextFits(next.title, 120, "主标题");
    requireTextFits(next.subtitle, 180, "副标题");
    const slots = blueprintSlots(original);
    const currentDraft = pageCopyDraftFromPage(page);
    const changedText = next.displayText !== currentDraft.displayText.trim();
    // Insertion/deletion/retyping a role loses field identity in this legacy
    // three-field UI. Refuse it instead of guessing and destroying evidence.
    if (changedText) {
      const lines = next.displayText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const parsed = textToContentBlocks(next.displayText);
      if (lines.length !== slots.length || parsed.length !== slots.length || parsed.some((block, index) => block.role !== slots[index].role)) {
        throw copyEditError("请保留每行的栏目标签、行数和顺序，仅修改冒号后的文字。增删模块需使用结构化编辑，原文未改动。");
      }
      slots.forEach((slot, index) => {
        requireTextFits(parsed[index].text, slot.maxLength, `第 ${index + 1} 行`);
        const owner = slot.path.slice(0, -1).reduce((value, key) => value[key], copy);
        owner[slot.path.at(-1)] = parsed[index].text;
      });
    }
    copy.title = next.title;
    copy.subtitle = next.subtitle;
    copy.status = "edited";
    // Preserve the authored lock's order and additional locked strings (for
    // example a bridge) while replacing only text owned by edited fields.
    const before = [original.title, original.subtitle, ...slots.map((slot) => slot.text)];
    const after = [copy.title, copy.subtitle, ...blueprintSlots(copy).map((slot) => slot.text)];
    if (original.schemaVersion !== "1.0") {
      // Current locks represent occurrences, not a set: identical labels in
      // different modules must remain separate and in reading order.
      copy.verbatimText = after.filter(Boolean);
      return copy;
    }
    const replacements = new Map();
    before.forEach((text, index) => {
      if (!text) return;
      const values = replacements.get(text) || [];
      values.push(after[index]);
      replacements.set(text, values);
    });
    const locked = (original.verbatimText || before).flatMap((text) => replacements.get(text) || [text]);
    if (!original.subtitle && copy.subtitle) locked.splice(Math.max(0, locked.indexOf(copy.title) + 1), 0, copy.subtitle);
    copy.verbatimText = [...new Set([...locked, ...after].filter(Boolean))];
    return copy;
  }
  const title = String(draft.title || page.title || "待填写页面标题").trim();
  const subtitle = String(draft.subtitle || "").trim();
  const content = textToContentBlocks(draft.displayText).map((block) => block.text).filter(Boolean);
  return normalizeConsultingCopyBlueprint({
    status: "edited",
    audienceQuestion: page.audienceQuestion || page.copyBlueprint?.audienceQuestion || page.communicationTask || "本页需要回答什么？",
    oneSentenceAnswer: content[0] || title,
    pageLogic: page.pageLogic || page.copyBlueprint?.pageLogic || (page.narrativeRole === "cover" ? "cover" : "claim"),
    title,
    subtitle,
    lead: content[0] || "",
    modules: content.slice(1).map((text) => ({ role: "point", label: "", headline: text, body: "", items: [], sourceRefs: [] })),
    example: "",
    evidence: [],
    boundary: "",
    bottomTakeaways: [],
    bridgeToNext: page.task || "",
    sourceRefs: page.sourceExcerpt || page.copyBlueprint?.sourceRefs || [],
    verbatimText: [title, subtitle, ...content].filter(Boolean)
  }, page);
}

export function pageBlocksFromConsultingCopy(copy) {
  return consultingCopyBlocks(copy);
}

export function structuredCopyFromDraft(draft = {}, page = {}) {
  if (draft.copyEditMode !== "structured") throw copyEditError("结构化文案保存缺少编辑模式标识", 400);
  if (!hasBlueprint(page)) throw copyEditError("当前旧版页面尚无文案蓝图，请先使用普通文案编辑", 409);
  const raw = draft.copyBlueprint;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw copyEditError("文案蓝图格式无效", 400);
  if (isPageCopyDraftUnchanged(draft, page)) return structuredClone(page.copyBlueprint);
  const original = page.copyBlueprint;
  if (raw.schemaVersion !== original.schemaVersion) throw copyEditError("不可在编辑时变更文案蓝图版本", 400);
  const textLimits = { title: 120, subtitle: 180, lead: 260, audienceQuestion: 220, oneSentenceAnswer: 260, pageLogic: 40, example: 260, boundary: 260, bridgeToNext: 220 };
  const permitted = new Set([...Object.keys(textLimits), "schemaVersion", "status", "modules", "evidence", "bottomTakeaways", "sourceRefs", "verbatimText"]);
  for (const key of Object.keys(raw)) if (!permitted.has(key) && JSON.stringify(raw[key]) !== JSON.stringify(original[key])) throw copyEditError(`不允许通过文案编辑修改字段 ${key}`, 400);
  const checkText = (value, limit, label) => {
    if (typeof value !== "string") throw copyEditError(`${label}必须为文字`, 400);
    requireTextFits(value, limit, label);
  };
  const checkList = (value, limit, label) => {
    if (!Array.isArray(value)) throw copyEditError(`${label}必须为列表`, 400);
    value.forEach((text, index) => {
      checkText(text, limit, `${label} ${index + 1}`);
      if (!text.trim()) throw copyEditError(`${label} ${index + 1} 为空，请填写或删除此项`, 400);
    });
  };
  for (const [key, limit] of Object.entries(textLimits)) checkText(raw[key] ?? "", limit, key);
  if (!CONSULTING_PAGE_LOGICS.includes(raw.pageLogic)) throw copyEditError("页面逻辑无效，请使用已支持的页面逻辑", 400);
  if (!Array.isArray(raw.modules) || raw.modules.length > 24) throw copyEditError("内容模块必须为列表，且不得超过 24 个", 400);
  raw.modules.forEach((module, index) => {
    if (!module || typeof module !== "object" || Array.isArray(module)) throw copyEditError(`模块 ${index + 1} 格式无效`, 400);
    for (const [field, limit] of Object.entries({ role: 40, label: 80, headline: 160, body: 260 })) checkText(module[field] ?? "", limit, `模块 ${index + 1} ${field}`);
    checkList(module.items, 180, `模块 ${index + 1} 条目`);
    checkList(module.sourceRefs, 320, `模块 ${index + 1} 来源`);
    if (![module.label, module.headline, module.body, ...module.items].some((text) => typeof text === "string" && text.trim())) throw copyEditError(`模块 ${index + 1} 为空，请填写或删除模块`, 400);
    if (module.items.length > 8 || module.sourceRefs.length > 8) throw copyEditError(`模块 ${index + 1} 的条目或来源超过 8 项，请调整结构`, 400);
  });
  for (const [key, limit] of Object.entries({ evidence: 240, bottomTakeaways: 180, sourceRefs: 320, verbatimText: 260 })) checkList(raw[key], limit, key);
  if (raw.evidence.length > 10 || raw.bottomTakeaways.length > 4 || raw.sourceRefs.length > 16) throw copyEditError("证据、底部结论或来源超过当前蓝图容量，请调整结构", 400);
  const expected = editedBlueprintLock(raw, original);
  if (JSON.stringify(raw.verbatimText) !== JSON.stringify(expected)) throw copyEditError("锁定文案与结构化内容不一致，请重新载入编辑器后保存", 400);
  const copy = { ...structuredClone(raw), status: "edited" };
  const validation = validateConsultingCopyBlueprint(copy, page.narrativeRole);
  if (!validation.valid) throw copyEditError(validation.issues.join("；"), 400);
  return copy;
}

export function summarizePageForEditor(page = {}) {
  const copy = pageCopyDraftFromPage(page);
  return {
    id: page.id || page.pageNo || "",
    pageNo: page.pageNo || page.id || "",
    title: copy.title || "未命名页面",
    subtitle: copy.subtitle,
    displayText: copy.displayText,
    copyBlueprint: hasBlueprint(page) ? structuredClone(page.copyBlueprint) : null,
    copyEditorCapabilities: { structuredBlueprint: Boolean(hasBlueprint(page)), contractVersion: "1", flatText: true },
    pageType: page.pageType || "",
    editableMode: page.editableMode || "",
    visualPriority: page.visualPriority || "",
    narrativeRole: page.narrativeRole || "",
    masterRole: page.masterRole || page.masterRoleOverride || "",
    designSpec: page.designSpec ? { ...page.designSpec } : null,
    regenerationPreviewImage: page.regenerationPreviewImage ? { ...page.regenerationPreviewImage } : null,
    generationStatus: page.generationStatus || undefined,
    status: page.status || ""
  };
}

// Free text edits accept additions, deletions and paragraph changes without
// requiring users to preserve role labels or field counts.
export function plainCopyFromDraft(draft, page) {
  if (typeof draft.title !== "string" || typeof draft.bodyText !== "string") throw copyEditError("请填写标题和正文", 400);
  const current = plainTextDraft(page);
  const original = page.copyBlueprint || consultingCopyFromDraft({}, page);
  if (isPageCopyDraftUnchanged(draft, page)) return structuredClone(original);
  const copy = structuredClone(original);
  copy.title = draft.title.trim();
  if (!copy.title) throw copyEditError("标题不能为空", 400);
  requireTextFits(copy.title, 120, "标题");
  const changedBody = draft.bodyText !== current.bodyText;
  if (changedBody) {
    requireTextFits(draft.bodyText, 5000, "本页正文");
    const slots = plainCopySlots(original);
    const paragraphs = draft.bodyText.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
    // Retain field ownership when paragraph boundaries remain intact. Blank
    // or inserted paragraphs use an ordinary text flow in canonical order.
    const stable = paragraphs.length === slots.length && slots.every((slot, i) => !slot.text.includes("\n\n") && paragraphs[i].length <= slot.limit);
    if (stable) slots.forEach((slot, i) => {
      const owner = slot.path.slice(0, -1).reduce((value, key) => value[key], copy);
      owner[slot.path.at(-1)] = paragraphs[i];
    });
    else {
      const parts = [];
      for (const paragraph of paragraphs) {
        let remaining = paragraph;
        while (remaining.length > 260) {
          let end = 260;
          if (/^[\uDC00-\uDFFF]$/.test(remaining[end])) end--;
          parts.push(remaining.slice(0, end)); remaining = remaining.slice(end);
        }
        if (remaining) parts.push(remaining);
      }
      if (parts.length > 23) throw copyEditError("本页段落较多，请合并一些短段后保存", 400);
      // Preserve every source reference even when the author changes grouping.
      copy.sourceRefs = [...new Set([...(copy.sourceRefs || []), ...(copy.modules || []).flatMap((m) => m.sourceRefs || [])])];
      copy.subtitle = ""; copy.lead = ""; copy.example = ""; copy.evidence = []; copy.boundary = ""; copy.bottomTakeaways = [];
      copy.modules = parts.map((body) => ({ role: "point", label: "", headline: "", body, items: [], sourceRefs: [] }));
    }
  }
  copy.status = "edited";
  const visible = [copy.title, copy.subtitle, copy.lead, ...(copy.modules || []).flatMap((m) => [m.label, m.headline, m.body, ...(m.items || [])]), copy.example, ...(copy.evidence || []), copy.boundary, ...(copy.bottomTakeaways || [])].filter((text) => typeof text === "string" && text.trim());
  const originalExtras = plainCopySlots(original).filter((slot) => slot.path[0] === "verbatimText");
  const bodyParagraphs = draft.bodyText.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
  const originalSlots = plainCopySlots(original);
  const keptSlots = !changedBody || (bodyParagraphs.length === originalSlots.length && originalSlots.every((slot, i) => !slot.text.includes("\n\n") && bodyParagraphs[i].length <= slot.limit));
  const legacyExtras = keptSlots ? originalExtras.map((slot) => copy.verbatimText[slot.path[1]]) : [];
  copy.verbatimText = [...visible, ...legacyExtras];
  if (!changedBody && original.schemaVersion === "1.0") {
    const titleIndex = (original.verbatimText || []).indexOf(original.title);
    copy.verbatimText = (original.verbatimText || visible).map((text, i) => i === titleIndex ? copy.title : text);
  }
  return copy;
}
