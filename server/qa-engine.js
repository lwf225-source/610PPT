import path from "node:path";
import fssync from "node:fs";
import { validateMasterPack } from "../shared/master-packs.js";
import {
  IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION,
  validateImageRenderPlan
} from "../shared/image2-render-plan.js";
import { normalizeContentDetailMode } from "../shared/content-detail-contracts.js";
import { isNearDuplicateText, semanticTextKey, slideText } from "./content-text-utils.js";
import { stripInternalProductionNotes as legacyStripInternalProductionNotes } from "./codex-integration.js";

const deps = {};
const stripInternalProductionNotes = (...args) => (deps.stripInternalProductionNotes || legacyStripInternalProductionNotes)(...args);

export function configureQaEngine(injected = {}) {
  Object.assign(deps, injected);
}

function createQaIssue({ id, category, severity = "medium", message, page = null, index = null, evidence = "", suggestion = "", hardBlock = false }) {
  const pageNo = page ? deps.pageNoForPage(page, index || 0) : null;
  return {
    id,
    category,
    severity,
    message,
    pageId: page?.id || pageNo || null,
    pageNo,
    title: page?.title || "",
    evidence,
    suggestion,
    ...(hardBlock ? { hardBlock: true } : {})
  };
}

function pageBlockTexts(page) {
  return (page.blocks || [])
    .map((block) => deps.cleanDisplayText(block.text || ""))
    .filter(Boolean);
}

function pageTextSurface(page) {
  return [
    page.title,
    page.task,
    page.mainPoint,
    page.visualPlan,
    page.visualPrompt,
    ...pageBlockTexts(page),
    ...(page.assetNeeds || [])
  ].map((item) => deps.cleanDisplayText(item || "")).filter(Boolean).join("\n");
}

function hasInternalPageMark(text = "") {
  return /(^|[\s（(【\[])(P\d{1,3})([\s:：、.)）】\]]|$)/i.test(String(text || ""));
}

function hasReadableTextRisk(text = "") {
  return /�|□{2,}|undefined|null|\bTODO\b|lorem ipsum/i.test(String(text || ""));
}

function hasFakeLogoRisk(text = "") {
  const source = String(text || "");
  const positive = /(生成|绘制|放置|制作|加上|带有).{0,14}(logo|Logo|LOGO|标志|商标)|(?:logo|Logo|LOGO|标志|商标).{0,12}(仿|伪造|真实|官方)/i.test(source);
  const guarded = /(不|不要|禁止|无).{0,8}(logo|Logo|LOGO|标志|商标)|官方或商店|真实素材|来源|占位/i.test(source);
  return positive && !guarded;
}

function semanticDuplicatePairsForPage(page) {
  const exactEntries = (page.blocks || [])
    .filter((block) => !/^headline$/i.test(String(block.role || "")))
    .map((block) => ({ role: block.role || "正文", text: block.text || "" }))
    .filter((entry) => semanticTextKey(entry.text).length >= 8);
  const exactSeen = new Map();
  const exactPairs = [];
  for (const entry of exactEntries) {
    const key = semanticTextKey(entry.text);
    const previous = exactSeen.get(key);
    if (previous) exactPairs.push({ left: previous, right: entry, exact: true });
    else exactSeen.set(key, entry);
  }

  const entries = [
    { role: "标题", text: page.title || "" },
    ...((page.blocks || [])
      .filter((block) => /^(?:subtitle|conclusion|bottom-conclusion|judgment|result)$/i.test(String(block.role || "")))
      .map((block) => ({ role: block.role, text: block.text || "" }))),
    { role: "主判断", text: page.mainPoint || "" }
  ].filter((entry) => semanticTextKey(entry.text).length >= 8);
  const pairs = [...exactPairs];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (!isNearDuplicateText(entries[left].text, entries[right].text, 0.72)) continue;
      pairs.push({ left: entries[left], right: entries[right], exact: false });
    }
  }
  return pairs;
}

export function shouldFlagDenseImageOnlyText({ page, visibleTextLength = 0, longestBlock = 0, contentDetailMode = "focus" } = {}) {
  return page?.editableMode === "image-only"
    && normalizeContentDetailMode(contentDetailMode) !== "detailed"
    && ((page.blocks || []).length > 6 || visibleTextLength > 160 || longestBlock > 38);
}

function buildPageQaIssues(pages, options = {}) {
  const issues = [];
  const contentDetailMode = normalizeContentDetailMode(options.contentDetailMode);
  pages.forEach((page, index) => {
    const blocks = page.blocks || [];
    const blockTexts = pageBlockTexts(page);
    const title = deps.cleanDisplayText(page.title || "");
    const headlineBlocks = blocks.filter((block) => /headline|title|标题/.test(block.role || ""));
    const headlineMatches = headlineBlocks.some((block) => {
      const text = deps.cleanDisplayText(block.text || "");
      return text && title && (text.includes(title) || title.includes(text));
    });
    const surface = pageTextSurface(page);
    const visibleTextLength = [title, ...blockTexts].join("").length;
    const longestBlock = blockTexts.reduce((max, text) => Math.max(max, text.length), 0);
    const duplicatePairs = semanticDuplicatePairsForPage(page);

    if (!title) {
      issues.push(createQaIssue({
        id: "missing-title",
        category: "title-consistency",
        severity: "high",
        message: "页面缺少标题",
        page,
        index,
        suggestion: "为 PageIR 填写稳定页面标题。"
      }));
    } else if (headlineBlocks.length === 0) {
      issues.push(createQaIssue({
        id: "missing-headline-block",
        category: "title-consistency",
        severity: "medium",
        message: "PageIR 缺少 headline/title 内容块",
        page,
        index,
        evidence: title,
        suggestion: "补充 headline 内容块，确保导出和 prompt 使用同一标题组件。"
      }));
    } else if (!headlineMatches) {
      issues.push(createQaIssue({
        id: "headline-title-mismatch",
        category: "title-consistency",
        severity: "medium",
        message: "页面标题与 headline 内容块不一致",
        page,
        index,
        evidence: headlineBlocks.map((block) => block.text).join(" / "),
        suggestion: "让页面标题和 headline 内容块保持同一主标题。"
      }));
    }

    if (hasInternalPageMark(title) || blockTexts.some(hasInternalPageMark)) {
      issues.push(createQaIssue({
        id: "internal-page-mark",
        category: "internal-page-mark",
        severity: "medium",
        message: "标题或展示文字疑似包含 P01/P02 内部页码",
        page,
        index,
        evidence: [title, ...blockTexts].filter(hasInternalPageMark).slice(0, 2).join(" / "),
        suggestion: "页码只保留在 PageIR 的 pageNo 或文件名，不进入最终页面文字。"
      }));
    }

    if (shouldFlagDenseImageOnlyText({ page, visibleTextLength, longestBlock, contentDetailMode })) {
      issues.push(createQaIssue({
        id: "dense-image-only-text",
        category: "readability",
        severity: "medium",
        message: "image-only 页文字过密，生图后可读性风险高",
        page,
        index,
        evidence: `${blocks.length} 个内容块，约 ${visibleTextLength} 字`,
        suggestion: "减少最终图中的可见文字，或重新编译该页视觉计划；详细事实保留在内容大纲和备注中。"
      }));
    }

    if (duplicatePairs.length) {
      const pair = duplicatePairs[0];
      issues.push(createQaIssue({
        id: "semantic-copy-duplication",
        category: "semantic-repetition",
        severity: pair.exact ? "high" : "medium",
        message: pair.exact ? "页面存在重复展示内容" : "标题、主判断或结论存在近义重复",
        page,
        index,
        evidence: `${pair.left.role}：${slideText(pair.left.text, 42)} / ${pair.right.role}：${slideText(pair.right.text, 42)}`,
        suggestion: pair.exact
          ? "删除重复内容，并从该页来源证据中补回缺失的信息。"
          : "标题保留结论，正文改为证据，底部结论改为新的业务含义。"
      }));
    }

    if (hasReadableTextRisk(surface)) {
      issues.push(createQaIssue({
        id: "text-readability-risk",
        category: "readability",
        severity: "medium",
        message: "PageIR 文本疑似包含占位、乱码或未清理内容",
        page,
        index,
        evidence: surface.match(/�|□{2,}|undefined|null|\bTODO\b|lorem ipsum/i)?.[0] || "",
        suggestion: "清理乱码、占位符和未定义字段后再导出。"
      }));
    }

    if (hasFakeLogoRisk(surface)) {
      issues.push(createQaIssue({
        id: "fake-logo-risk",
        category: "logo-policy",
        severity: "medium",
        message: "页面描述疑似要求生成或伪造 Logo",
        page,
        index,
        evidence: surface.slice(0, 120),
        suggestion: "改为官方素材占位或用户后续自行贴入真实 Logo。"
      }));
    }

  });
  return issues;
}

function buildImage2PlanIssues(deck = {}) {
  const pages = deck.pages || [];
  const plan = deck.image2RenderPlan;
  const issues = [];
  const validation = validateImageRenderPlan(plan, deck.contentOutline);

  for (const message of validation.issues || []) {
    issues.push(createQaIssue({
      id: `image2-render-plan-${issues.length + 1}`,
      category: "image2-visual-plan",
      severity: "high",
      message: "Image2 整套视觉计划未通过校验",
      evidence: message,
      suggestion: "按当前内容大纲和风格重新编译整套视觉计划。"
    }));
  }

  const anchors = deck.styleAnchors || {};
  const expectedContentPage = pages.find((page, index) => {
    const pageNo = deps.pageNoForPage(page, index);
    const planned = plan?.pages?.find((item) => item.pageNo === pageNo);
    return planned && !["cover", "directory"].includes(planned.masterRole);
  });
  const expectedContentPageNo = expectedContentPage
    ? deps.pageNoForPage(expectedContentPage, pages.indexOf(expectedContentPage))
    : null;
  const anchorChecks = [
    { key: "cover", anchor: anchors.cover, expectedPageNo: pages.length ? deps.pageNoForPage(pages[0], 0) : null, label: "封面" },
    { key: "content", anchor: anchors.content, expectedPageNo: expectedContentPageNo, label: "正文视觉母版" }
  ];
  for (const item of anchorChecks) {
    const isReady = item.key === "cover"
      ? ["generated", "confirmed"].includes(item.anchor?.status)
      : item.anchor?.status === "confirmed";
    if (!item.anchor || item.anchor.pageId !== item.expectedPageNo || !isReady || !item.anchor.assetPath) {
      const isCover = item.key === "cover";
      issues.push(createQaIssue({
        id: `image2-${item.key}-anchor-not-confirmed`,
        category: "image2-anchors",
        severity: "high",
        message: isCover ? `${item.label}视觉锚点尚未生成` : `${item.label}视觉锚点尚未确认`,
        evidence: `${item.anchor?.pageId || "未生成"} / ${item.anchor?.status || "缺失"}`,
        suggestion: isCover
          ? `先生成${item.label}锚点，再生成正文视觉母版。`
          : `先确认${item.label}，再生成剩余页面。`
      }));
    }
  }

  const planPages = plan?.pages || [];
  const consecutiveRuns = [];
  let currentRun = [];
  for (const planPage of planPages) {
    const previous = currentRun[currentRun.length - 1];
    if (!previous || previous.compositionKind === planPage.compositionKind) currentRun.push(planPage);
    else {
      if (currentRun.length >= 3) consecutiveRuns.push(currentRun);
      currentRun = [planPage];
    }
  }
  if (currentRun.length >= 3) consecutiveRuns.push(currentRun);
  for (const run of consecutiveRuns) {
    issues.push(createQaIssue({
      id: `image2-composition-repeat-${run[0].pageNo}`,
      category: "image2-visual-rhythm",
      severity: "medium",
      message: `连续 ${run.length} 页使用相同构图`,
      evidence: `${run[0].compositionKind}：${run.map((page) => page.pageNo).join(" / ")}`,
      suggestion: "保持同一视觉系统，但为相邻页面分配不同的信息构图。"
    }));
  }
  const bottomBarPages = planPages.filter((page) => page.takeawayMode === "bottom-bar");
  if (planPages.length && bottomBarPages.length / planPages.length > 0.35) {
    issues.push(createQaIssue({
      id: "image2-bottom-bar-overuse",
      category: "image2-visual-rhythm",
      severity: "medium",
      message: "底部总结条使用过多",
      evidence: `${bottomBarPages.length}/${planPages.length} 页`,
      suggestion: "仅在需要独立收束判断的页面使用底部总结条，其余改用行内或侧注。"
    }));
  }

  const planByPageNo = new Map(planPages.map((page) => [page.pageNo, page]));
  const generationJobs = deps.existingGenerationJobs(deck);
  pages.forEach((page, index) => {
    const pageNo = deps.pageNoForPage(page, index);
    const pagePlan = planByPageNo.get(pageNo);
    if (!pagePlan) return;
    const job = generationJobs[page.id || pageNo];
    if (job?.qualityGate?.kind === "image2-visual-master" && job.qualityGate.status !== "passed") {
      issues.push(createQaIssue({
        id: `image2-visual-master-gate-${pageNo}`,
        category: "image2-visual-master-gate",
        severity: "high",
        message: "页面未通过正文视觉母版一致性门禁",
        page,
        index,
        evidence: job.qualityGate.audit?.feedback || job.qualityGate.audit?.evidence || job.error || "未通过整页视觉母版复检",
        suggestion: "使用同一正文视觉母版作为第一张参考图定向重绘，并通过整页一致性复检后再导出。",
        hardBlock: true
      }));
    }
    if (job?.image2PlanSignature && job.image2PlanSignature !== pagePlan.promptSignature) {
      issues.push(createQaIssue({
        id: `image2-page-plan-stale-${pageNo}`,
        category: "image2-page-plan-binding",
        severity: "high",
        message: "最终图对应的逐页视觉计划已过期",
        page,
        index,
        evidence: pageNo,
        suggestion: "按当前视觉计划重新生成该页。"
      }));
    }
    const isAnchorPage = pageNo === anchors.cover?.pageId || pageNo === anchors.content?.pageId;
    if (!isAnchorPage && page.finalImage?.path) {
      const contentDependency = job?.anchorDependencies?.find((item) => item.kind === "content-anchor");
      const contractValid = job?.contentAnchorContractVersion === IMAGE2_CONTENT_ANCHOR_CONTRACT_VERSION
        && job?.contentAnchorPageId === anchors.content?.pageId
        && job?.contentAnchorSignature === anchors.content?.signature
        && job?.contentAnchorReferencePath === anchors.content?.assetPath
        && contentDependency?.pageId === anchors.content?.pageId
        && contentDependency?.signature === anchors.content?.signature
        && job?.contentAnchorContract?.referenceRole === "strict-style-master"
        && (job?.styleReferencePaths || [])[0] === anchors.content?.assetPath
        && String(job?.prompt || "").includes("【正文视觉母版合同");
      if (!contractValid) {
        issues.push(createQaIssue({
          id: `image2-content-anchor-contract-${pageNo}`,
          category: "image2-anchor-binding",
          severity: "high",
          message: "最终图没有把当前正文视觉母版绑定为第一优先级参考",
          page,
          index,
          evidence: `${job?.contentAnchorPageId || "无正文视觉母版"} / ${job?.contentAnchorContractVersion || "无合同版本"}`,
          suggestion: `使用正文视觉母版 ${anchors.content?.pageId || "未确认"} 作为第一张参考图重新生成本页。`
        }));
      }
      const previousPage = pages[index - 1];
      const previousPageNo = previousPage ? deps.pageNoForPage(previousPage, index - 1) : null;
      const previousImage = previousPage?.finalImage?.path;
      const previousIsFixedAnchor = previousPageNo === anchors.cover?.pageId || previousPageNo === anchors.content?.pageId;
      if (previousImage && !previousIsFixedAnchor && (job?.styleReferencePaths || []).includes(previousImage)) {
        issues.push(createQaIssue({
          id: `image2-previous-page-anchor-${pageNo}`,
          category: "image2-anchor-binding",
          severity: "high",
          message: "本页错误引用了上一张生成页",
          page,
          index,
          evidence: previousImage,
          suggestion: "移除上一页引用，只保留正文视觉母版、封面锚点、角色母版和字形参考。"
        }));
      }
    }
  });

  return issues;
}

export function buildQaIssueGroups(issues = []) {
  const labels = {
    "title-consistency": "标题一致性",
    readability: "文字可读性",
    "layout-capacity": "版式容量",
    "internal-page-mark": "内部页码",
    "logo-policy": "Logo 规则",
    "export-mode-policy": "导出策略",
    "final-images": "最终图",
    preview: "渲染预览",
    structure: "结构完整性",
    "visual-system": "视觉约束"
  };
  labels["layout-diversity"] = "版式多样性";
  labels["content-density"] = "内容密度";
  labels["content-coverage"] = "内容覆盖率";
  labels["semantic-repetition"] = "语义重复";
  labels["master-pack"] = "母版套装";
  labels["image2-visual-plan"] = "Image2 视觉计划";
  labels["image2-anchors"] = "双视觉锚点";
  labels["image2-page-plan-binding"] = "逐页视觉计划绑定";
  labels["image2-anchor-binding"] = "正文视觉母版绑定";
  labels["image2-visual-master-gate"] = "正文视觉母版门禁";
  labels["image2-visual-rhythm"] = "整套构图节奏";
  const grouped = new Map();
  for (const issue of issues) {
    const key = issue.category || "structure";
    const current = grouped.get(key) || {
      id: key,
      label: labels[key] || key,
      severity: issue.severity,
      count: 0,
      pages: [],
      issues: []
    };
    current.count += 1;
    if (issue.pageNo && !current.pages.includes(issue.pageNo)) current.pages.push(issue.pageNo);
    current.issues.push(issue);
    if (issue.severity === "high") current.severity = "high";
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export function buildQaReport(deck, imagePaths = []) {
  const pages = deck.pages || [];
  const hasSemanticCover = pages.length > 0 && deps.isSemanticCoverPage(pages[0]);
  const imageOnlyPages = pages.filter((page) => page.editableMode === "image-only");
  const nonImageOnlyPages = pages.filter((page) => page.editableMode !== "image-only");
  const finalImageMap = deps.buildFinalImageMap(deck, imagePaths);
  const missingPrompts = pages.filter((page) => !page.prompt);
  const pageOrderIssues = pages.filter((page, index) => deps.pageNumberFromPage(page) !== index + 1);
  const missingImageOnlyPages = finalImageMap.filter((item) => item.editableMode === "image-only" && !item.exists);
  const boundFinalImages = finalImageMap.filter((item) => item.exists).length;
  const latestPreview = deck.exportManifest?.latest?.preview;
  const latestExport = deck.exportManifest?.latest;
  const exportMode = latestExport?.mode || "";
  const requiresFinalImages = true;
  const hasImage2TypographyRole = Boolean(
    deck.styleBible?.fontProfile?.family
    && deck.styleBible?.typography
    && Object.keys(deck.styleBible.typography).length >= 8
  );
  const image2Consistency = deps.image2PromptConsistencyIssues(deck);
  const staleImageJobs = Object.values(deps.existingGenerationJobs(deck)).filter((job) => job?.status === "stale");
  const pageIssues = buildPageQaIssues(pages, { contentDetailMode: deck.styleProfile?.contentDetailMode });
  const image2PlanIssues = buildImage2PlanIssues(deck);
  const masterPackIssues = validateMasterPack(deck).map((issue) => createQaIssue({
    id: issue.id,
    category: "master-pack",
    severity: "high",
    message: issue.message,
    page: issue.page,
    index: issue.index,
    suggestion: "重新应用项目锁定的母版套装，并为该页选择正确的母版角色。"
  }));
  const exportModeIssues = [];
  if (latestExport?.mode === "image-only" && (latestExport.editableLayouts?.length || latestExport.editableText)) {
    exportModeIssues.push(createQaIssue({
      id: "image-only-export-has-editable-records",
      category: "export-mode-policy",
      severity: "medium",
      message: "image-only 导出记录不应包含可编辑对象",
      evidence: latestExport.pptx || "",
      suggestion: "image-only PPTX 只允许最终整页图铺满页面。"
    }));
  }
  if (latestExport?.pptx && latestExport.mode !== "image-only") {
    exportModeIssues.push(createQaIssue({ id: "retired-export-mode", category: "export-mode-policy", severity: "high",
      message: "当前版本只支持整页图 PPTX，请重新导出", evidence: latestExport.mode || "unknown" }));
  }
  const issues = [];

  if (!pages.length) issues.push(createQaIssue({ id: "empty-deck", category: "structure", severity: "high", message: "deck 没有页面" }));
  if (pages.length && !hasSemanticCover) {
    issues.push(createQaIssue({
      id: "missing-semantic-cover",
      category: "structure",
      severity: "high",
      message: "P01 不是可识别的低密度封面",
      page: pages[0],
      evidence: `${pages[0]?.pageType || "未指定"} / ${pages[0]?.narrativeRole || "未指定"} / ${pages[0]?.designSpec?.layoutKind || "未指定"}`,
      suggestion: "把 P01 改为 cover，只保留整套标题、副标题和少量项目信息。"
    }));
  }
  if (pageOrderIssues.length) issues.push(createQaIssue({ id: "page-order", category: "structure", severity: "medium", message: `${pageOrderIssues.length} 页页码或顺序不连续`, evidence: pageOrderIssues.map((page, index) => deps.pageNoForPage(page, index)).slice(0, 8).join(" / ") }));
  if (missingPrompts.length) issues.push(createQaIssue({ id: "missing-prompts", category: "structure", severity: "medium", message: `${missingPrompts.length} 页缺少 image2 prompt`, evidence: missingPrompts.map((page, index) => deps.pageNoForPage(page, index)).slice(0, 8).join(" / ") }));
  if (nonImageOnlyPages.length) issues.push(createQaIssue({ id: "retired-page-mode", category: "export-mode-policy", severity: "high", message: `${nonImageOnlyPages.length} 页仍使用已停用的可编辑导出模式`, evidence: nonImageOnlyPages.map((page, index) => deps.pageNoForPage(page, index)).slice(0, 8).join(" / ") }));
  image2Consistency.forEach((issue) => {
    issues.push(createQaIssue({
      id: `image2-${issue.type}-${issue.pageNo}`,
      category: "image2-style-consistency",
      severity: "high",
      message: issue.type === "conflicting-style"
        ? `${issue.pageNo} 的逐页视觉方案与当前整套风格冲突`
        : `${issue.pageNo} 尚未绑定当前整套风格协议`,
      page: issue.page,
      evidence: issue.evidence,
      suggestion: "重新保存当前风格，让工作台重编逐页视觉提示词后再生成图片。"
    }));
  });
  if (staleImageJobs.length) {
    issues.push(createQaIssue({
      id: "image2-stale-final-images",
      category: "image2-style-consistency",
      severity: "high",
      message: `${staleImageJobs.length} 页最终图对应的是旧提示词或旧风格`,
      evidence: staleImageJobs.map((job) => job.pageNo).slice(0, 8).join(" / "),
      suggestion: "按当前风格协议重新生成这些页面，再执行整套检查。"
    }));
  }
  if (requiresFinalImages && missingImageOnlyPages.length) {
    issues.push(createQaIssue({
      id: "missing-image-only-finals",
      category: "final-images",
      severity: "high",
      message: `${missingImageOnlyPages.length} 个 image-only 页面缺少绑定的最终整页图`,
      evidence: missingImageOnlyPages.map((item) => item.pageNo).slice(0, 8).join(" / "),
      suggestion: "先生成并导入这些页面的最终整页图，再导出 image-only PPTX。"
    }));
  }
  if (deck.exportManifest?.latest?.pptx && latestPreview?.status !== "ready") {
    issues.push(createQaIssue({ id: "preview-not-ready", category: "preview", severity: "medium", message: `渲染预览未通过：${latestPreview?.error || "尚未生成预览"}` }));
  }
  issues.push(...pageIssues, ...exportModeIssues, ...masterPackIssues, ...image2PlanIssues);
  const titleIssues = pageIssues.filter((issue) => issue.category === "title-consistency");
  const readabilityIssues = pageIssues.filter((issue) => issue.category === "readability");
  const internalMarkIssues = pageIssues.filter((issue) => issue.category === "internal-page-mark");
  const logoIssues = pageIssues.filter((issue) => issue.category === "logo-policy");
  const modePolicyIssues = issues.filter((issue) => issue.category === "export-mode-policy");
  const issueGroups = buildQaIssueGroups(issues);

  return {
    generatedAt: new Date().toISOString(),
    status: issues.some((issue) => issue.severity === "high") ? "needs-fix" : "ready",
    summary: {
      totalPages: pages.length,
      imageOnlyPages: imageOnlyPages.length,
      nonImageOnlyPages: pages.filter((page) => page.editableMode !== "image-only").length,
      selectedImages: imagePaths.length,
      boundFinalImages,
    },
    checks: [
      { id: "page-order", label: "页数和顺序已结构化", passed: pages.length > 0 && pageOrderIssues.length === 0 },
      { id: "semantic-cover", label: "P01 是真正的低密度封面", passed: hasSemanticCover },
      { id: "style-profile", label: "风格配置已写入", passed: Boolean(deck.styleProfile?.id) },
      { id: "image2-style-bible", label: "Image2 整套风格协议已锁定", passed: Boolean(deck.styleBible?.signature) },
      { id: "image2-typography-role", label: "Image2 已绑定统一字体角色和字号层级", passed: hasImage2TypographyRole },
      { id: "image2-style-consistency", label: "逐页提示词没有混入其他风格", passed: image2Consistency.length === 0 },
      { id: "image2-render-plan", label: "Image2 整套视觉计划已通过校验", passed: !image2PlanIssues.some((issue) => issue.category === "image2-visual-plan") },
      { id: "image2-dual-anchors", label: "封面与正文双锚点已确认", passed: !image2PlanIssues.some((issue) => issue.category === "image2-anchors") },
      { id: "image2-page-plan-binding", label: "最终图绑定当前逐页视觉计划", passed: !image2PlanIssues.some((issue) => issue.category === "image2-page-plan-binding") },
      { id: "image2-visual-rhythm", label: "整套页面构图有节奏变化", passed: !image2PlanIssues.some((issue) => issue.category === "image2-visual-rhythm") },
      { id: "image2-final-image-freshness", label: "最终图对应当前风格提示词", passed: staleImageJobs.length === 0 },
      { id: "typography-scale", label: "字号层级已写入", passed: Boolean(deck.typographyScale && Object.keys(deck.typographyScale).length >= 8) },
      { id: "title-consistency", label: "标题组件一致", passed: titleIssues.length === 0 },
      { id: "readable-text", label: "页面文字密度可读", passed: readabilityIssues.length === 0 },
      { id: "editable-mode", label: "所有页面均使用整页图", passed: pages.every((page) => page.editableMode === "image-only") },
      { id: "prompt-records", label: "逐页 image2 prompt 已生成", passed: missingPrompts.length === 0 },
      { id: "final-images", label: "image-only 页已有最终图", passed: !requiresFinalImages || missingImageOnlyPages.length === 0 },
      { id: "final-image-binding", label: "最终图已按页面绑定", passed: !requiresFinalImages || boundFinalImages > 0 || !imageOnlyPages.length },
      { id: "no-internal-page-mark", label: "最终文字不含内部页码", passed: internalMarkIssues.length === 0 },
      { id: "no-fake-logo", label: "不伪造 Logo", passed: logoIssues.length === 0 },
      { id: "export-mode-policy", label: "导出模式符合可编辑边界", passed: modePolicyIssues.length === 0 },
      { id: "render-preview", label: "导出后渲染预览已记录", passed: !deck.exportManifest?.latest?.pptx || latestPreview?.status === "ready" }
    ],
    issueGroups,
    pageIssues,
    issues
  };
}

export function normalizeQaScopePageNos(deck = {}, requestedPageNos = []) {
  const requested = new Set((requestedPageNos || []).map(String).filter(Boolean));
  if (!requested.size) return [];
  return (deck.pages || [])
    .map((page, index) => String(page.pageNo || page.id || `P${String(index + 1).padStart(2, "0")}`))
    .filter((pageNo) => requested.has(pageNo));
}

export function filterQaIssuesForPageScope(issues = [], pageNos = []) {
  const scope = new Set((pageNos || []).map(String).filter(Boolean));
  if (!scope.size) return [...(issues || [])];
  return (issues || []).filter((issue) => scope.has(String(issue?.pageNo || "")));
}

const EXPORT_REFRESHABLE_QA_ISSUES = new Set([
  "preview-not-ready",
  "image-only-export-has-editable-records",
  "retired-export-mode"
]);

export function isUnwaivableQaIssue(issue = {}) {
  return issue?.hardBlock === true
    || (issue?.severity === "high" && ["image2-visual-audit-title", "image2-visual-master-gate"].includes(String(issue?.category || "")));
}

export function finalExportReadiness(deck, imagePaths = [], options = {}) {
  const pages = deck?.pages || [];
  const unreviewedPages = pages.filter((page) => page.reviewStatus !== "approved");
  const qaReport = buildQaReport(deck, imagePaths);
  const targetMode = options.targetMode || deck.exportManifest?.latest?.mode || "";
  const refreshableIssues = (qaReport.issues || []).filter((issue) => (
    EXPORT_REFRESHABLE_QA_ISSUES.has(issue.id)
  ));
  const blockingIssues = (qaReport.issues || []).filter((issue) => (
    issue.severity === "high"
    && !refreshableIssues.includes(issue)
  ));
  const persistedHardBlockingIssues = (deck?.qaReport?.issues || []).filter(isUnwaivableQaIssue);
  const allBlockingIssues = [...blockingIssues];
  for (const issue of persistedHardBlockingIssues) {
    if (!allBlockingIssues.some((candidate) => candidate.id === issue.id && candidate.pageNo === issue.pageNo)) {
      allBlockingIssues.push(issue);
    }
  }
  const unwaivableIssues = allBlockingIssues.filter(isUnwaivableQaIssue);
  const waivableIssues = allBlockingIssues.filter((issue) => !isUnwaivableQaIssue(issue));
  const blockers = [];
  if (unreviewedPages.length) {
    blockers.push(`${unreviewedPages.length} 页尚未逐页确认`);
  }
  if (unwaivableIssues.length) {
    const affectedPages = [...new Set(unwaivableIssues.map((issue) => issue.pageNo).filter(Boolean))];
    blockers.push(`${unwaivableIssues.length} 个正文视觉母版硬门槛未通过${affectedPages.length ? `（${affectedPages.join(" / ")}）` : ""}`);
  }
  if (waivableIssues.length && !options.allowQaIssues) {
    const affectedPages = [...new Set(waivableIssues.map((issue) => issue.pageNo).filter(Boolean))];
    blockers.push(`${waivableIssues.length} 个高风险问题未解决${affectedPages.length ? `（${affectedPages.join(" / ")}）` : ""}`);
  }
  return {
    ready: pages.length > 0 && blockers.length === 0,
    blockers,
    unreviewedPages: unreviewedPages.map((page, index) => deps.pageNoForPage(page, index)),
    blockingIssues: allBlockingIssues,
    unwaivableIssues,
    qaIssuesAcknowledged: Boolean(options.allowQaIssues),
    refreshableIssues,
    qaReport
  };
}

export function buildExportManifest(deck, additions = {}) {
  const previousHistory = deck.exportManifest?.history || deck.exportHistory || [];
  const shouldAppend = Boolean(additions?.mode && additions?.pptx);
  const history = shouldAppend
    ? [additions, ...previousHistory.filter((item) => item.pptx !== additions.pptx)].slice(0, 30)
    : previousHistory;
  return {
    deckId: deck.deckId,
    project: deck.project,
    updatedAt: new Date().toISOString(),
    exportModes: {
      imageOnly: "整页图铺满 PPTX"
    },
    latest: shouldAppend ? additions : (deck.exportManifest?.latest || additions),
    history
  };
}
