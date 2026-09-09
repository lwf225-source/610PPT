export const PAGE_COMMUNICATION_TASKS = [
  "cover",
  "context",
  "claim",
  "data",
  "comparison",
  "process",
  "case",
  "checklist",
  "transition",
  "conclusion"
];

const SOURCE_INSIGHT_FIELDS = [
  "people",
  "events",
  "decisions",
  "metrics",
  "artifacts",
  "constraints",
  "terms",
  "tensions",
  "quotes"
];

function clean(value = "", max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(items, maxItems = 16) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => clean(item)).filter(Boolean))].slice(0, maxItems);
}

export function normalizeSourceInsightMap(value = {}) {
  return Object.fromEntries(SOURCE_INSIGHT_FIELDS.map((field) => [field, cleanList(value?.[field])]));
}

export function normalizeCommunicationTask(value = "", pageRole = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (PAGE_COMMUNICATION_TASKS.includes(normalized)) return normalized;
  if (pageRole === "cover") return "cover";
  if (["agenda", "section-divider"].includes(pageRole)) return "transition";
  if (["takeaway", "action", "checklist"].includes(pageRole)) return "conclusion";
  if (["evidence", "proof", "result", "current-state"].includes(pageRole)) return "data";
  if (["method", "step", "process"].includes(pageRole)) return "process";
  if (["example", "attempt"].includes(pageRole)) return "case";
  return "claim";
}

function titleShape(title = "") {
  const text = clean(title, 120)
    .replace(/[0-9０-９]+(?:[.,，]\d+)?/g, "#")
    .replace(/[A-Za-z][A-Za-z0-9._/-]*/g, "X");
  if (/^不是.+而是/.test(text)) return "不是-而是";
  if (/^从.+(?:到|走向|变成)/.test(text)) return "从-到";
  if (/^(?:先|再|最后|第一步|第二步|第三步|步骤)/.test(text)) return "步骤序号";
  if (/^(?:为什么|如何|怎么|什么)/.test(text)) return "问句";
  if (/^(?:结论|亮点|证据|方法|成果|问题|风险)[一二三四五六七八九十:#：]/.test(text)) return "标签序号";
  return text.slice(0, 8);
}

function normalizedEvidenceKey(value = "") {
  return clean(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 100);
}

export function validateOutlineDistinctiveness(outline = {}) {
  const pages = Array.isArray(outline.pages) ? outline.pages : [];
  const contentPages = pages.filter((page) => !["cover", "agenda", "section-divider", "appendix"].includes(page.pageRole));
  const issues = [];
  const warnings = [];

  const taskKinds = new Set(contentPages.map((page) => page.communicationTask).filter(Boolean));
  const minimumTaskKinds = contentPages.length >= 8 ? 4 : contentPages.length >= 5 ? 3 : 2;
  if (contentPages.length >= 4 && taskKinds.size < minimumTaskKinds) {
    issues.push(`页面表达任务过于单一：${contentPages.length} 张内容页仅使用 ${taskKinds.size} 类任务`);
  }
  for (let index = 2; index < contentPages.length; index += 1) {
    const recent = contentPages.slice(index - 2, index + 1).map((page) => page.communicationTask);
    if (recent.every((task) => task && task === recent[0])) {
      issues.push(`${contentPages[index - 2].pageNo}-${contentPages[index].pageNo} 连续使用相同页面表达任务 ${recent[0]}`);
      break;
    }
  }

  const shapes = new Map();
  for (const page of contentPages) {
    const shape = titleShape(page.title);
    if (!shape) continue;
    shapes.set(shape, [...(shapes.get(shape) || []), page.pageNo]);
  }
  for (const [shape, pageNos] of shapes.entries()) {
    if (pageNos.length >= 3 && pageNos.length / Math.max(1, contentPages.length) >= 0.3) {
      issues.push(`标题句式“${shape}”重复 ${pageNos.length} 次：${pageNos.join(" / ")}`);
    }
  }

  for (const page of contentPages) {
    if (!Array.isArray(page.sourceSpecifics) || page.sourceSpecifics.length === 0) {
      issues.push(`${page.pageNo} 缺少源文档专属信息`);
    }
  }

  const evidenceOwners = new Map();
  for (const page of contentPages) {
    for (const item of [...(page.evidence || []), ...(page.sourceSpecifics || [])]) {
      const key = normalizedEvidenceKey(item);
      if (!key || key.length < 8) continue;
      evidenceOwners.set(key, [...(evidenceOwners.get(key) || []), page.pageNo]);
    }
  }
  const repeatedEvidence = [...evidenceOwners.values()].filter((owners) => new Set(owners).size >= 3);
  if (repeatedEvidence.length) warnings.push(`有 ${repeatedEvidence.length} 条事实在至少 3 页重复使用`);

  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    warnings: [...new Set(warnings)],
    communicationTaskKinds: [...taskKinds],
    score: Math.max(0, 100 - issues.length * 12 - warnings.length * 4)
  };
}

export function sourceInsightPromptRules() {
  return [
    "先通读全文并生成 sourceInsights，再规划页面。sourceInsights 必须提取源文档专属的人物、事件、决策、数字、产物、约束、术语、矛盾和可引用原话；没有的类别返回空数组。",
    "页面内容来自上传原文，sourceInsights 仅辅助组织，sourceRefs 可留空。去掉项目名后可套用于任意 AI 项目的泛化表达，不得作为一页的核心内容。",
    "不得把原文改写成通用方法论流水账；优先保留原文中的具体动作、取舍、失败、对象名称、时间、数字和因果关系。"
  ].join("\n");
}

export function outlineQualityPromptRules() {
  return [
    `每页 communicationTask 必须从 ${PAGE_COMMUNICATION_TASKS.join(" / ")} 中选择。它表示本页对受众完成的沟通任务，而不是视觉版式。`,
    "communicationTask按原文内容选用，允许连续数据页、步骤页或同类主题页；不为任务种类和数量补写内容。",
    "讲述结构只约束开场方式、推进逻辑和收束方向，不是要求每个阶段机械分配一页；允许围绕源文档最强材料调整阶段数量。",
    "sourceSpecifics仅记录原文专属信息作为内部内容定位，可留空；无需额外引用核验。",
    "标题准确概括每页已有内容，不为追求标题句式变化新增判断。",
    "coreClaim 概括一页的原文主题或核心信息；只有原文明示判断时才保留该判断；displayText、evidence 可以按内容需要使用多个槽位，详细展示可增加槽位，但不能重复同一事实凑数。"
  ].join("\n");
}
