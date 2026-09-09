import { editorialRule } from "./editorial-rule-runtime.js";
export const defaultTargetPageCount = 10;
export const minTargetPageCount = 3;
export const maxTargetPageCount = 60;

export function normalizeTargetPageCount(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maxTargetPageCount, Math.max(minTargetPageCount, parsed));
}

export function resetDocumentScopedPagePlan(styleProfile = {}) {
  return {
    ...styleProfile,
    contentDetailMode: "focus",
    targetPageCount: defaultTargetPageCount,
    targetPageCountMode: "recommended",
    outlineMode: "adaptive",
    coverMode: "auto",
    sourcePageCount: null,
    sourcePageMarkers: []
  };
}

export function extractExplicitPageMarkers(text = "") {
  const markers = [];
  const seen = new Set();

  String(text || "").split(/\r?\n/).forEach((line, index) => {
    const match = line.match(
      /^\s*(?:#{1,6}\s*)?P(\d{1,3})\s*(?:(?:[｜|:：、·.\-–—]\s*)|\s+)(.+?)\s*$/i
    );
    if (!match) return;
    // Legacy PDF extractor markers describe physical pages, not authored slides.
    if (/^Page\s+\d+$/i.test(match[2].trim())) return;
    const number = Number.parseInt(match[1], 10);
    if (!Number.isFinite(number) || seen.has(number)) return;
    seen.add(number);
    markers.push({
      pageNo: `P${String(number).padStart(2, "0")}`,
      number,
      title: match[2].replace(/\*+/g, "").trim(),
      line: index + 1
    });
  });

  markers.sort((left, right) => left.number - right.number);
  const contiguous = markers.length >= minTargetPageCount
    && markers.every((marker, index) => marker.number === index + 1);
  return contiguous ? markers : [];
}

export function analyzeDocumentStructure(documentData) {
  const text = typeof documentData === "string"
    ? documentData
    : String(documentData?.text || "");
  const pageMarkers = extractExplicitPageMarkers(text);
  const noCover = /无封面|不设封面|无需封面|不要封面|不需要封面|不另设封面|不单独设置封面/.test(text);
  const firstPageTitle = pageMarkers[0]?.title || "";
  const explicitCover = /封面|标题页|开场/.test(firstPageTitle);
  const coverMode = noCover ? "none" : explicitCover ? "required" : "auto";

  if (!pageMarkers.length) {
    return {
      outlineMode: "adaptive",
      coverMode,
      sourcePageCount: null,
      pageMarkers: []
    };
  }

  return {
    outlineMode: "locked",
    coverMode,
    sourcePageCount: pageMarkers.length,
    pageMarkers
  };
}

function codexPageCountAnalysis(documentData) {
  const analysis = documentData?.pageCountAnalysis;
  if (!analysis || typeof analysis !== "object") return null;

  const status = String(analysis.status || "").trim();
  if (status === "analyzing") {
    return {
      status,
      pageCount: defaultTargetPageCount,
      reason: "正在由 Codex 分析内容主题和页面边界。",
      source: "codex-pending"
    };
  }
  if (status !== "ready") return null;

  const pageCount = normalizeTargetPageCount(analysis.pageCount, null);
  if (!pageCount) return null;
  return {
    status,
    pageCount,
    reason: String(analysis.reason || "Codex 已根据内容主题和叙事密度给出页数建议。").trim(),
    source: "codex-analysis",
    analysisSummary: String(analysis.analysisSummary || "").trim(),
    confidence: String(analysis.confidence || "").trim()
  };
}

export function recommendTargetPageCount(documentData) {
  const structure = analyzeDocumentStructure(documentData);
  if (structure.outlineMode === "locked") {
    const firstPage = structure.pageMarkers[0]?.pageNo;
    const lastPage = structure.pageMarkers.at(-1)?.pageNo;
    const coverNote = structure.coverMode === "none" ? "，并保留无封面设定" : "";
    return {
      pageCount: structure.sourcePageCount,
      reason: `检测到连续 ${firstPage}-${lastPage} 逐页大纲，按现有 ${structure.sourcePageCount} 页结构拆分${coverNote}；页内小标题不会扩成新页面。`,
      source: "explicit-outline",
      ...structure
    };
  }

  const codexRecommendation = codexPageCountAnalysis(documentData);
  if (codexRecommendation) {
    return {
      pageCount: codexRecommendation.pageCount,
      reason: codexRecommendation.reason,
      source: codexRecommendation.source,
      analysisSummary: codexRecommendation.analysisSummary || "",
      confidence: codexRecommendation.confidence || "",
      ...structure
    };
  }

  const characters = Number(documentData?.stats?.characters) || 0;
  const lines = Number(documentData?.stats?.lines) || 0;
  const headings = Number(documentData?.stats?.headings) || 0;
  if (!characters && !lines && !headings) {
    return {
      pageCount: defaultTargetPageCount,
      reason: "文档读取完成后，会按内容长度和主题密度推荐页数。",
      source: "default",
      ...structure
    };
  }

  // Reserve cover, agenda and close, then estimate one coherent subject per body page.
  const contentEstimate = characters ? Math.ceil(characters / 550) + 3 : 0;
  const lineEstimate = lines ? Math.ceil(lines / 45) + 3 : 0;
  const structureEstimate = headings ? Math.ceil(headings * 0.75) + 3 : 0;
  const pageCount = normalizeTargetPageCount(
    Math.max(6, contentEstimate, lineEstimate, structureEstimate),
    defaultTargetPageCount
  );
  const evidence = [
    characters ? `${characters.toLocaleString()} 字` : "",
    lines ? `${lines} 行` : "",
    headings ? `${headings} 个标题` : ""
  ].filter(Boolean).join(" · ");

  return {
    pageCount,
    reason: `根据当前文档的 ${evidence} 重新估算，含封面、目录和结尾页，正文按单页一个主题组织。`,
    source: "content-estimate",
    ...structure
  };
}

export function effectiveTargetPageCount(styleProfile, documentData, fallback = defaultTargetPageCount) {
  if (styleProfile?.targetPageCountMode !== "custom") {
    return recommendTargetPageCount(documentData).pageCount;
  }
  return normalizeTargetPageCount(styleProfile?.targetPageCount, fallback);
}

export function resolveDocumentPagePlan(documentData, styleProfile = {}, fallback = defaultTargetPageCount) {
  const recommendation = recommendTargetPageCount(documentData);
  const isCustom = styleProfile?.targetPageCountMode === "custom";
  const storedTargetPageCount = normalizeTargetPageCount(styleProfile?.targetPageCount, null);
  const hasDocumentStats = ["characters", "lines", "headings"]
    .some((key) => Number(documentData?.stats?.[key]) > 0);
  const hasResolvedRecommendation = recommendation.outlineMode === "locked"
    || documentData?.pageCountAnalysis?.status === "ready"
    || hasDocumentStats;
  const targetPageCount = isCustom
    ? normalizeTargetPageCount(styleProfile?.targetPageCount, fallback)
    : hasResolvedRecommendation
      ? recommendation.pageCount
      : storedTargetPageCount || recommendation.pageCount;
  const outlineLocked = recommendation.outlineMode === "locked"
    && targetPageCount === recommendation.sourcePageCount;
  const detectedCoverMode = recommendation.coverMode || "auto";

  return {
    targetPageCount,
    targetPageCountMode: isCustom ? "custom" : "recommended",
    outlineMode: outlineLocked ? "locked" : "adaptive",
    coverMode: detectedCoverMode,
    sourcePageCount: recommendation.sourcePageCount,
    sourcePageMarkers: outlineLocked ? recommendation.pageMarkers : []
  };
}

export function pageAllocationPrompt() {
  const cloud = editorialRule('pageAllocationPrompt');
  if (cloud !== null) return cloud;
  return [
    "页面分配：讲述结构决定原文内容的顺序和组织关系，目标页数决定拆分粒度，内容详略决定每页保留的信息；三者均不得产生文档外内容。",
    "先按原文独立主题建立内容单元，再按所选讲述结构排序，最后分配到指定总页数；封面如有使用计入总数，不机械预留目录或总结页。",
    "页数偏少时：先合并同主题或紧密相关的相邻单元，再按详略模式省略低相关补充内容和压缩措辞；保留核心事实及其时间、对象、口径和必要条件，不把无关主题挤在一页。",
    "页数偏多时：仅展开原文已有的独立子主题、数据分项、步骤或案例；同一单元分多页时每页承载不同原文信息，不把同一事实换句话重复。",
    "材料不足时：先减少每页信息量、保留合理留白，不要求填满模块；如果确实没有足够的独立原文信息组成目标页数，直接说明材料不足，不输出空白页、重复页或新增观点凑页。",
    "每页围绕一个主题或紧密相关的问题，页与页按原文已有联系衔接，不自行新增因果、风险、建议或总结。"
  ].join("\n");
}

// Model startup and a transient reconnect can consume the old 60-second limit.
// Page-count analysis has its own bounded budget, independent of split stages.
export function pageCountAnalysisTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(600_000, Math.max(1_000, parsed)) : 180_000;
}
