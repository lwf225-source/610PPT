import {
  NARRATIVE_NEUTRAL_ROLES,
  narrativeContractFor,
  normalizeNarrativeModeId,
  normalizeNarrativeRole,
  validateNarrativeStructure
} from "./narrative-contracts.js";
import { normalizeContentDetailMode } from "./content-detail-contracts.js";
import { validateOutlineSourceGrounding } from "./source-grounding.js";
import {
  normalizeCommunicationTask,
  normalizeSourceInsightMap,
  validateOutlineDistinctiveness
} from "./content-outline-quality.js";
import {
  consultingCopyBlocks,
  normalizeArgumentMap,
  normalizeConsultingCopyBlueprint,
  validateConsultingCopyBlueprint
} from "./consulting-copy-ir.js";

export const CONTENT_OUTLINE_SCHEMA_VERSION = "2.0";

function clean(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(items, maxItems = 12, maxLength = 500) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => clean(item, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function visibleText(value = "") {
  return String(value ?? "").trim();
}

function visibleList(items) {
  return (Array.isArray(items) ? items : []).map(visibleText).filter(Boolean);
}

function pageNo(index) {
  return `P${String(index + 1).padStart(2, "0")}`;
}

function blocksForOutlinePage(page) {
  return consultingCopyBlocks(page.copyBlueprint, page);
}

export function normalizeContentOutline(payload = {}, defaults = {}) {
  const narrativeMode = normalizeNarrativeModeId(payload.narrativeMode || defaults.narrativeMode);
  const contentDetailMode = normalizeContentDetailMode(payload.contentDetailMode || defaults.contentDetailMode);
  const rawPages = Array.isArray(payload.pages) ? payload.pages : [];
  const pages = rawPages.map((page, index) => {
    const legacy = {
      pageRole: normalizeNarrativeRole(page?.pageRole || page?.narrativeRole, narrativeMode),
      communicationTask: normalizeCommunicationTask(page?.communicationTask, page?.pageRole || page?.narrativeRole),
      title: visibleText(page?.title),
      subtitle: visibleText(page?.subtitle),
      coreClaim: clean(page?.coreClaim || page?.mainPoint, 240),
      displayText: visibleList(page?.displayText),
      evidence: visibleList(page?.evidence),
      sourceRefs: cleanList(page?.sourceRefs || page?.sourceExcerpt, 12, 300),
      relationship: {
        fromPrevious: clean(page?.relationship?.fromPrevious, 180),
        toNext: clean(page?.relationship?.toNext, 180)
      }
    };
    const copyBlueprint = normalizeConsultingCopyBlueprint(page?.copyBlueprint || {}, legacy);
    return {
      pageNo: pageNo(index),
      pageRole: legacy.pageRole,
      communicationTask: legacy.communicationTask,
      pageLogic: copyBlueprint.pageLogic,
      audienceQuestion: copyBlueprint.audienceQuestion,
      title: copyBlueprint.title || legacy.title,
      subtitle: copyBlueprint.subtitle,
      coreClaim: copyBlueprint.oneSentenceAnswer || legacy.coreClaim,
      displayText: copyBlueprint.modules.flatMap((module) => [module.headline, module.body, ...module.items]).filter(Boolean),
      evidence: copyBlueprint.evidence,
      sourceRefs: copyBlueprint.sourceRefs,
      sourceSpecifics: cleanList(page?.sourceSpecifics || legacy.sourceRefs, 6, 300),
      relationship: legacy.relationship,
      copyBlueprint,
      verbatimText: copyBlueprint.verbatimText
    };
  });
  return {
    schemaVersion: CONTENT_OUTLINE_SCHEMA_VERSION,
    title: visibleText(payload.title || defaults.title || "未命名演示文稿"),
    narrativeMode,
    contentDetailMode,
    coverMode: ["none", "required", "auto"].includes(defaults.coverMode ?? payload.coverMode) ? (defaults.coverMode ?? payload.coverMode) : "auto",
    targetPageCount: Number(defaults.targetPageCount || payload.targetPageCount || pages.length),
    sourceSummary: clean(payload.sourceSummary || defaults.sourceSummary, 800),
    sourceInsights: normalizeSourceInsightMap(payload.sourceInsights || defaults.sourceInsights),
    ...((defaults.sourceDocument || payload.sourceDocument) ? { sourceDocument: defaults.sourceDocument || payload.sourceDocument } : {}),
    argumentMap: normalizeArgumentMap(payload.argumentMap || defaults.argumentMap, { thesis: payload.sourceSummary || defaults.sourceSummary }),
    pages,
    notes: cleanList(payload.notes, 12, 300),
    generatedAt: payload.generatedAt || new Date().toISOString()
  };
}

export function validateSplitPageShape(outline = {}) {
  const issues = [];
  const pages = Array.isArray(outline.pages) ? outline.pages : [];
  const target = Number(outline.targetPageCount) || 0;
  if (!String(outline.title || "").trim()) issues.push("缺少整套标题");
  if (!pages.length) issues.push("没有拆出页面");
  if (target && pages.length !== target) issues.push(`目标页数为${target}，实际为${pages.length}`);
  pages.forEach((page, index) => {
    if (page.pageNo !== pageNo(index)) issues.push(`${pageNo(index)}页码不连续`);
    if (!String(page.title || "").trim()) issues.push(`${pageNo(index)}缺少标题`);
  });
  return { valid: !issues.length, scope: "format-only", issues, targetPageCount: target, actualPageCount: pages.length };
}

export function validateContentOutline(outline = {}, { conventionalCover = false } = {}) {
  const issues = [];
  const copyWarnings = [];
  const pages = Array.isArray(outline.pages) ? outline.pages : [];
  const target = Number(outline.targetPageCount) || 0;
  if (outline.schemaVersion !== CONTENT_OUTLINE_SCHEMA_VERSION) issues.push("ContentOutlineIR 版本不是 2.0");
  if (!outline.title) issues.push("缺少整套标题");
  if (!pages.length) issues.push("没有拆出页面");
  if (target && pages.length !== target) issues.push(`目标页数为 ${target}，实际为 ${pages.length}`);
  if (outline.coverMode === "none") {
    if (pages.some((page) => page.pageRole === "cover")) issues.push("当前设置为无封面，不应生成封面页");
  } else if (pages[0]?.pageRole !== "cover") issues.push("P01 必须是封面");

  const contract = narrativeContractFor(outline.narrativeMode);
  const lastContentPage = [...pages].reverse().find((page) => !NARRATIVE_NEUTRAL_ROLES.includes(page.pageRole));
  if (lastContentPage && !contract.closingRoles.includes(lastContentPage.pageRole)) {
    issues.push(`最后一张内容页应使用 ${contract.closingRoles.join(" / ")}，当前为 ${lastContentPage.pageRole || "缺失"}`);
  }
  pages.forEach((page, index) => {
    const id = page.pageNo || pageNo(index);
    if (page.pageNo !== pageNo(index)) issues.push(`${id} 页码不连续`);
    if (!page.pageRole) issues.push(`${id} 缺少有效页面角色`);
    if (!page.title) issues.push(`${id} 缺少主标题`);
    if (!page.coreClaim && page.pageRole !== "cover" && page.pageRole !== "agenda") issues.push(`${id} 缺少核心判断`);
    if (!page.sourceRefs?.length && page.pageRole !== "cover" && page.pageRole !== "agenda") issues.push(`${id} 缺少来源引用`);
    const copyValidation = validateConsultingCopyBlueprint(page.copyBlueprint, page.pageRole, { conventionalCover });
    issues.push(...copyValidation.issues.map((issue) => `${id} ${issue}`));
    copyWarnings.push(...copyValidation.warnings.map((warning) => `${id} ${warning}`));
  });
  const narrative = validateNarrativeStructure(
    pages.map((page) => ({ pageNo: page.pageNo, title: page.title, mainPoint: page.coreClaim, narrativeRole: page.pageRole })),
    outline.narrativeMode,
    { strictCoverage: false, strictSequence: false }
  );
  issues.push(...narrative.issues);
  const distinctiveness = validateOutlineDistinctiveness(outline);
  const sourceInsightCount = Object.values(outline.sourceInsights || {})
    .reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
  if (sourceInsightCount > 0) issues.push(...distinctiveness.issues);
  const normalizedIssues = [...new Set(issues)];
  const sourceGrounding = validateOutlineSourceGrounding(outline);
  normalizedIssues.push(...sourceGrounding.issues);
  return {
    valid: normalizedIssues.length === 0,
    issues: normalizedIssues,
    score: Math.max(0, 100 - normalizedIssues.length * 10),
    targetPageCount: target,
    actualPageCount: pages.length,
    warnings: [...copyWarnings, ...sourceGrounding.warnings, ...(sourceInsightCount > 0
      ? distinctiveness.warnings
      : ["兼容旧大纲：未启用 SourceInsightMap 去模板化强校验"])],
    distinctiveness,
    sourceGrounding
  };
}

export function projectContentOutlineToDeck(outline = {}, seedDeck = {}) {
  const styleProfile = {
    ...(seedDeck.styleProfile || {}),
    narrativeMode: outline.narrativeMode,
    contentDetailMode: outline.contentDetailMode,
    coverMode: outline.coverMode || seedDeck.styleProfile?.coverMode || "auto",
    targetPageCount: outline.targetPageCount,
    targetPageCountMode: "custom"
  };
  const pages = outline.pages.map((page) => ({
    id: page.pageNo,
    pageNo: page.pageNo,
    title: page.title,
    subtitle: page.subtitle,
    pageType: page.pageRole === "cover" ? "visual-poster" : "content-card",
    editableMode: "image-only",
    visualPriority: page.pageRole === "cover" ? "high" : "medium",
    narrativeRole: page.pageRole,
    communicationTask: page.communicationTask,
    pageLogic: page.pageLogic,
    audienceQuestion: page.audienceQuestion,
    task: page.relationship?.toNext || "",
    mainPoint: page.coreClaim,
    blocks: blocksForOutlinePage(page),
    sourceExcerpt: page.sourceRefs,
    sourceSpecifics: page.sourceSpecifics,
    contentEvidence: page.evidence,
    contentRelationship: page.relationship,
    copyBlueprint: page.copyBlueprint,
    verbatimText: page.verbatimText,
    assetNeeds: [],
    status: "draft",
    qa: { status: "pending", issues: [] },
    prompt: ""
  }));
  return {
    ...seedDeck,
    title: outline.title,
    narrativeMode: outline.narrativeMode,
    argumentMap: outline.argumentMap,
    styleProfile,
    contentOutline: outline,
    pages,
    chapters: pages.map((page, index) => ({ title: `${page.pageNo} ${page.title}`, range: page.pageNo, line: index + 1 }))
  };
}

export function deriveContentOutlineFromDeck(deck = {}) {
  const pages = (Array.isArray(deck.pages) ? deck.pages : []).map((page, index) => {
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    const byRole = (roles) => blocks.filter((block) => roles.includes(String(block?.role || ""))).map((block) => block.text);
    return {
      pageNo: pageNo(index),
      pageRole: page.narrativeRole || (index === 0 ? "cover" : ""),
      communicationTask: page.communicationTask,
      pageLogic: page.pageLogic,
      audienceQuestion: page.audienceQuestion,
      title: page.title,
      subtitle: page.subtitle || byRole(["subtitle"])[0] || "",
      coreClaim: page.mainPoint || byRole(["key-message", "judgment", "conclusion", "bottom-conclusion"])[0] || "",
      displayText: byRole(["body", "content", "label", "module-title", "key-point", "flow-node", "step", "phase", "check", "example", "rule", "goal", "note", "metric", "table-row"]),
      evidence: page.contentEvidence || byRole(["evidence"]),
      sourceRefs: page.sourceExcerpt || [],
      sourceSpecifics: page.sourceSpecifics || page.sourceExcerpt || [],
      relationship: page.contentRelationship || { fromPrevious: "", toNext: page.task || "" },
      copyBlueprint: page.copyBlueprint,
      verbatimText: page.verbatimText
    };
  });
  return normalizeContentOutline({
    ...(deck.contentOutline || {}),
    title: deck.title,
    narrativeMode: deck.styleProfile?.narrativeMode || deck.narrativeMode,
    contentDetailMode: deck.styleProfile?.contentDetailMode,
    coverMode: deck.styleProfile?.coverMode || deck.contentOutline?.coverMode || "auto",
    targetPageCount: pages.length,
    sourceSummary: deck.analysisProvider?.sourceSummary || "由旧项目页面兼容生成",
    argumentMap: deck.argumentMap || deck.contentOutline?.argumentMap,
    pages,
    notes: deck.contentOutline?.notes || ["由旧 PageIR 兼容生成；不会改写既有图片。"]
  });
}
