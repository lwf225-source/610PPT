import { image2CoverCopyPrompt } from "./image2-cover-contract.js";

export const ARGUMENT_MAP_SCHEMA_VERSION = "1.0";
export const CONSULTING_COPY_SCHEMA_VERSION = "1.1";

export const ARGUMENT_UNIT_TYPES = Object.freeze([
  "claim", "contrast", "cause", "mechanism", "evidence", "example", "boundary", "transition", "conclusion"
]);

export const CONSULTING_PAGE_LOGICS = Object.freeze([
  "cover", "claim", "comparison", "framework", "process", "timeline", "matrix", "ladder", "case", "roadmap", "maturity", "conclusion"
]);

function clean(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(items, maxItems = 20, maxLength = 500) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => clean(item, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function visibleText(value = "") {
  return String(value ?? "").trim();
}

function visibleList(items = []) {
  return (Array.isArray(items) ? items : []).map(visibleText).filter(Boolean);
}

export function normalizeArgumentMap(payload = {}, defaults = {}) {
  const units = (Array.isArray(payload.units) ? payload.units : []).map((unit, index) => ({
    id: clean(unit?.id || `A${String(index + 1).padStart(2, "0")}`, 24),
    type: ARGUMENT_UNIT_TYPES.includes(unit?.type) ? unit.type : "claim",
    statement: clean(unit?.statement, 320),
    supports: cleanList(unit?.supports, 8, 24),
    sourceRefs: visibleList(unit?.sourceRefs),
    tension: clean(unit?.tension, 260),
    implication: clean(unit?.implication, 260)
  })).filter((unit) => unit.statement);
  return {
    schemaVersion: ARGUMENT_MAP_SCHEMA_VERSION,
    audience: clean(payload.audience || defaults.audience, 180),
    audienceProblem: clean(payload.audienceProblem, 320),
    thesis: clean(payload.thesis || defaults.thesis, 360),
    narrativeArc: cleanList(payload.narrativeArc, 12, 240),
    units
  };
}

function normalizeModule(module = {}, index = 0) {
  return {
    role: clean(module.role || `module-${index + 1}`, 40),
    label: visibleText(module.label),
    headline: visibleText(module.headline),
    body: visibleText(module.body),
    items: visibleList(module.items),
    sourceRefs: visibleList(module.sourceRefs)
  };
}

function blueprintText(blueprint = {}) {
  return visibleList([
    blueprint.title,
    blueprint.subtitle,
    blueprint.lead,
    ...(blueprint.modules || []).flatMap((module) => [module.label, module.headline, module.body, ...(module.items || [])]),
    blueprint.example,
    ...(blueprint.evidence || []),
    blueprint.boundary,
    ...(blueprint.bottomTakeaways || [])
  ]);
}

export function normalizeConsultingCopyBlueprint(raw = {}, legacyPage = {}) {
  const title = visibleText(raw.title ?? legacyPage.title);
  const subtitle = visibleText(raw.subtitle ?? legacyPage.subtitle);
  const legacyDisplay = visibleList(legacyPage.displayText);
  const rawModules = Array.isArray(raw.modules)
    ? raw.modules
    : legacyDisplay.map((text, index) => ({ role: "point", headline: text, items: [], sourceRefs: [] }));
  const hasExplicitLead = Object.prototype.hasOwnProperty.call(raw, "lead");
  const blueprint = {
    // Old authored locks can contain an internal bridge or deduplicate repeated
    // labels. Reading/saving them must not silently migrate their copy contract.
    schemaVersion: raw.schemaVersion === "1.0" ? "1.0" : CONSULTING_COPY_SCHEMA_VERSION,
    status: raw.status === "edited" ? "edited" : (raw.status === "authored" ? "authored" : "legacy-derived"),
    audienceQuestion: clean(raw.audienceQuestion || legacyPage.communicationTask, 220),
    oneSentenceAnswer: clean(raw.oneSentenceAnswer || raw.lead || legacyPage.coreClaim || legacyPage.mainPoint, 260),
    pageLogic: CONSULTING_PAGE_LOGICS.includes(raw.pageLogic)
      ? raw.pageLogic
      : (legacyPage.pageRole === "cover" ? "cover" : "claim"),
    title,
    subtitle,
    // oneSentenceAnswer is an internal editorial judgment. Only an explicit
    // lead is visible copy; legacy pages still inherit their old core claim.
    lead: visibleText(hasExplicitLead ? raw.lead : (raw.oneSentenceAnswer || legacyPage.coreClaim || legacyPage.mainPoint)),
    modules: rawModules.map(normalizeModule).filter((module) => module.label || module.headline || module.body || module.items.length),
    example: visibleText(raw.example),
    evidence: visibleList(Array.isArray(raw.evidence) ? raw.evidence : legacyPage.evidence),
    boundary: visibleText(raw.boundary),
    bottomTakeaways: visibleList(raw.bottomTakeaways),
    bridgeToNext: clean(raw.bridgeToNext || legacyPage.relationship?.toNext, 220),
    sourceRefs: visibleList(raw.sourceRefs?.length ? raw.sourceRefs : legacyPage.sourceRefs)
  };
  const derived = blueprintText(blueprint);
  blueprint.verbatimText = Array.isArray(raw.verbatimText) ? visibleList(raw.verbatimText) : derived;
  return blueprint;
}

export function consultingCopyBlocks(blueprint = {}, legacyPage = {}) {
  const copy = normalizeConsultingCopyBlueprint(blueprint, legacyPage);
  const blocks = [
    { role: "headline", text: copy.title },
    copy.subtitle ? { role: "subtitle", text: copy.subtitle } : null,
    copy.lead ? { role: "judgment", text: copy.lead } : null
  ];
  copy.modules.forEach((module) => {
    if (module.label) blocks.push({ role: "label", text: module.label });
    if (module.headline) blocks.push({ role: "module-title", text: module.headline });
    if (module.body) blocks.push({ role: "body", text: module.body });
    module.items.forEach((text) => blocks.push({ role: "key-point", text }));
  });
  if (copy.example) blocks.push({ role: "example", text: copy.example });
  copy.evidence.forEach((text) => blocks.push({ role: "evidence", text }));
  if (copy.boundary) blocks.push({ role: "rule", text: copy.boundary });
  copy.bottomTakeaways.forEach((text) => blocks.push({ role: "bottom-conclusion", text }));
  return blocks.filter((block) => block?.text);
}

export function validateArgumentMap(map = {}) {
  const issues = [];
  if (!map.thesis) issues.push("论证地图缺少总论点");
  if (!map.audienceProblem) issues.push("论证地图缺少受众问题");
  if (!Array.isArray(map.units) || map.units.length < 3) issues.push("论证地图至少需要 3 个论证单元");
  (map.units || []).forEach((unit) => {
    if (!unit.sourceRefs?.length && !["transition", "conclusion"].includes(unit.type)) issues.push(`${unit.id} 缺少来源引用`);
  });
  return { valid: issues.length === 0, issues };
}

export function validateConsultingCopyBlueprint(copy = {}, pageRole = "", { conventionalCover = false } = {}) {
  const issues = [];
  const warnings = [];
  const isCover = pageRole === "cover" || copy.pageLogic === "cover";
  // Apply only while authoring new copy; reading old locks must remain lossless.
  if (isCover && conventionalCover) {
    if (copy.modules?.length || copy.example || copy.evidence?.length || copy.boundary || copy.bottomTakeaways?.length) {
      issues.push("封面只保留主题标题、简短副标题和可选署名/日期；不得包含正文模块、例子、证据、边界或底部结论");
    }
    if (/^(受众问题|本页问题|核心张力|汇报目标|简报定位)[：:]/.test(copy.subtitle || "")
      || /^(受众问题|本页问题|本次.*将用|本页|核心张力|汇报目标)[：:]?/.test(copy.lead || "")) {
      issues.push("封面不得把内部受众问题或汇报说明写入副标题与署名行");
    }
  }
  if (!copy.title) issues.push("缺少受众可见标题");
  if (!isCover && !copy.audienceQuestion) issues.push("缺少本页受众问题");
  if (!isCover && !copy.oneSentenceAnswer) issues.push("缺少本页一句话答案");
  if (!isCover && !copy.modules?.length && !copy.evidence?.length) issues.push("缺少支撑一句话答案的内容模块");
  if (!copy.verbatimText?.length) issues.push("缺少逐字锁定文案");
  const expected = blueprintText(copy);
  const missing = expected.filter((text) => !copy.verbatimText?.includes(text));
  if (missing.length) issues.push(`逐字锁定文案遗漏 ${missing.length} 条成稿文字`);
  const exact = Array.isArray(copy.verbatimText) && expected.length === copy.verbatimText.length && expected.every((text, index) => copy.verbatimText[index] === text);
  if (!exact) {
    const message = "逐字锁定文案必须与可见字段的阅读顺序和出现次数完全一致，不得添加内部说明或额外文字";
    if (copy.schemaVersion === "1.0") warnings.push(`兼容旧版蓝图：${message}`);
    else issues.push(message);
  }
  if (expected.length > 24 || expected.some((text) => text.length > 260)) {
    const message = "可见文案超过单页容量（最多 24 项、每项 260 字），请精简或调整拆页；原文未被截断";
    if (copy.schemaVersion === "1.0") warnings.push(`兼容旧版蓝图：${message}`);
    else issues.push(message);
  }
  if (!isCover && !copy.bottomTakeaways?.length) warnings.push("本页没有底部收束句");
  if (["comparison", "framework", "process", "matrix", "roadmap", "maturity"].includes(copy.pageLogic) && !copy.boundary) {
    warnings.push("方法/框架页没有写适用边界");
  }
  return { valid: issues.length === 0, issues, warnings };
}

export function conventionalCoverPromptRules() {
  return image2CoverCopyPrompt();
}

export function consultingCopyPromptRules() {
  return [
    conventionalCoverPromptRules(),
    "标题概括本页原文主题；原文已有结论时可以用结论作标题，不强制制造判断或张力。audienceQuestion和oneSentenceAnswer仅作内部内容定位。",
    "每页围绕一个原文主题分组，按已有内容选择短段、数据、步骤、案例或对比。没有的例子、边界、含义或收束句留空，不为模板补写。",
    "以上是内部编辑结构，不是需要印在页面上的栏目清单。新写正文时，audienceQuestion、oneSentenceAnswer、bridgeToNext 和 sourceRefs 中的来源编号只用于内部编辑定位；不要机械地把它们复制成副标题或正文，不添加‘受众问题：’‘一句话答案：’‘底部收束：’‘S0001 |’等工作标签。需要展示的判断、证据和边界写成观众可直接阅读的短句；用户明确要求的标签与已确认的逐字文案保持不变。",
    "pageLogic 从 cover、claim、comparison、framework、process、timeline、matrix、ladder、case、roadmap、maturity、conclusion 中选择，并让内容关系与页面逻辑一致。",
    "modules按本页已有内容分组：label为可选栏目名，headline概括模块主题，body保留原文内容，items用于原文中的并列信息。",
    "verbatimText 必须按最终阅读顺序完整列出本页所有真正上屏文字；一字不改，不得遗漏，不包含内部说明或来源引用。",
    "优先使用源材料的专属名词、动作、数字、矛盾和边界；禁止空泛的“赋能、提效、升级、全面提升”等套话替代事实。"
  ].join("\n");
}
