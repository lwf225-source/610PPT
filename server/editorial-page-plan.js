import { ALL_NARRATIVE_ROLES, NARRATIVE_NEUTRAL_ROLES, narrativeContractFor, validateNarrativeStructure } from "../shared/narrative-contracts.js";
import { PAGE_COMMUNICATION_TASKS } from "../shared/content-outline-quality.js";
import { sourceBlockIdsForReference } from "../shared/source-grounding.js";
import { normalizeConsultingCopyBlueprint } from "../shared/consulting-copy-ir.js";

export const EDITORIAL_PAGE_PLAN_VERSION = "1.0";
export const EDITORIAL_EXECUTION_VERSION = "compact-planned-v4";
const text = { type: "string" };
const strings = { type: "array", items: text };
const insightKeys = ["people", "events", "decisions", "metrics", "artifacts", "constraints", "terms", "tensions", "quotes"];

export function buildEditorialPagePlanSchema(expectedPageCount, { narrativeMode, compact = false } = {}) {
  const roles = narrativeMode ? [...new Set([...NARRATIVE_NEUTRAL_ROLES, ...narrativeContractFor(narrativeMode).stages.map((stage) => stage.id)])] : ALL_NARRATIVE_ROLES;
  const fields = { pageNo: text, pageRole: { type: "string", enum: roles }, communicationTask: { type: "string", enum: PAGE_COMMUNICATION_TASKS }, title: text, oneSentenceAnswer: text, argumentUnitIds: strings, sourceRefs: strings, fromPrevious: text, toNext: text };
  if (compact) delete fields.sourceRefs;
  return { type: "object", additionalProperties: false, required: ["title", "sourceSummary", "sourceInsights", "pages", "notes"], properties: {
    title: text, sourceSummary: text, sourceInsights: { type: "object", additionalProperties: false, required: insightKeys, properties: Object.fromEntries(insightKeys.map((key) => [key, strings])) },
    pages: { type: "array", minItems: expectedPageCount, maxItems: expectedPageCount, items: { type: "object", additionalProperties: false, required: Object.keys(fields), properties: fields } }, notes: strings
  } };
}

// The map already owns verified quotations. Do not ask the planner to retype
// them once per page. Explicit values remain subject to the existing validator.
export function hydrateEditorialPlan(plan, argumentMap) {
  const units = new Map((argumentMap?.units || []).map(unit => [unit.id, unit]));
  return { ...plan, pages: plan?.pages?.map(page => ({ ...page,
    sourceRefs: page.sourceRefs === undefined
      ? [...new Set((page.argumentUnitIds || []).flatMap(id => units.get(id)?.sourceRefs || []))]
      : page.sourceRefs
  })) };
}

export function compactEditorialBatchSchema(fullSchema, group) {
  const schema = structuredClone(fullSchema);
  const page = schema.properties.pages.items;
  const omit = (value, keys) => {
    for (const key of keys) delete value.properties[key];
    value.required = value.required.filter(key => !keys.includes(key));
  };
  schema.properties.pages.minItems = schema.properties.pages.maxItems = group.length;
  page.properties.pageNo = { type: "string", enum: group.map(page => page.pageNo) };
  omit(page, ["pageRole", "communicationTask", "relationship"]);
  omit(page.properties.copyBlueprint, ["status", "title", "oneSentenceAnswer", "bridgeToNext", "verbatimText"]);
  // Flexible slot maxima allow different page structures. The prompt and copy
  // validators enforce the combined 24-item budget; each slot retains 260 chars.
  const copy = page.properties.copyBlueprint.properties;
  copy.modules.maxItems = 8;
  copy.modules.items.properties.items.maxItems = 8;
  copy.evidence.maxItems = 8;
  copy.bottomTakeaways.maxItems = 1;
  for (const key of ["subtitle", "lead", "example", "boundary"]) copy[key].maxLength = 260;
  for (const key of ["label", "headline", "body"]) copy.modules.items.properties[key].maxLength = 260;
  for (const items of [copy.modules.items.properties.items, copy.evidence, copy.bottomTakeaways]) items.items.maxLength = 260;
  return schema;
}

export function hydrateEditorialBatch(payload, group) {
  const locked = new Map(group.map(page => [page.pageNo, page]));
  return { ...payload, pages: payload?.pages?.map(page => {
    const plan = locked.get(page.pageNo);
    if (!plan) return page; // Wrong/extra pages must still fail the merge check.
    const copy = { status: "authored", title: plan.title, oneSentenceAnswer: plan.oneSentenceAnswer,
      bridgeToNext: plan.toNext, ...page.copyBlueprint };
    // Only derive omitted text; do not silently accept an incorrect explicit lock.
    if (copy.verbatimText === undefined) copy.verbatimText = normalizeConsultingCopyBlueprint(copy).verbatimText;
    return { pageRole: plan.pageRole, communicationTask: plan.communicationTask,
      relationship: { fromPrevious: plan.fromPrevious, toNext: plan.toNext }, ...page, copyBlueprint: copy };
  }) };
}

export function selectEditorialBatchRepairs(payload, issues) {
  const selected = new Set();
  for (const issue of issues || []) {
    const id = /^(P\d{2})\s/.exec(String(issue))?.[1];
    if (!id || !payload?.pages?.some(page => page.pageNo === id)) return [];
    selected.add(id);
  }
  return (payload?.pages || []).filter(page => selected.has(page.pageNo)).map(page => page.pageNo);
}

export function validateEditorialPagePlan(plan, { expectedPageCount, argumentMap, sourceDocument, narrativeMode, coverMode, contentDetailMode }) {
  const issues = [];
  const pages = Array.isArray(plan?.pages) ? plan.pages : [];
  const units = new Map((argumentMap?.units || []).map((unit) => [unit.id, unit]));
  const allowedRoles = new Set([...NARRATIVE_NEUTRAL_ROLES, ...narrativeContractFor(narrativeMode).stages.map((stage) => stage.id)]);
  if (!plan?.title || !plan?.sourceSummary) issues.push("整套 PagePlan 缺少标题或来源摘要");
  if (pages.length !== expectedPageCount) issues.push(`PagePlan 需要 ${expectedPageCount} 页，实际 ${pages.length}`);
  pages.forEach((page, index) => {
    const id = `P${String(index + 1).padStart(2, "0")}`;
    if (page.pageNo !== id) issues.push(`${id} PagePlan 页码不连续`);
    if (!page.title || (!page.oneSentenceAnswer && !NARRATIVE_NEUTRAL_ROLES.includes(page.pageRole))) issues.push(`${id} PagePlan 缺少锁定标题或一句话判断`);
    if (!ALL_NARRATIVE_ROLES.includes(page.pageRole) || !PAGE_COMMUNICATION_TASKS.includes(page.communicationTask)) issues.push(`${id} PagePlan 角色或论证任务无效`);
    if (!allowedRoles.has(page.pageRole)) issues.push(`${id} PagePlan 角色不属于所选讲述策略`);
    if (!Array.isArray(page.argumentUnitIds) || (!page.argumentUnitIds.length && !NARRATIVE_NEUTRAL_ROLES.includes(page.pageRole))) issues.push(`${id} 没有分配论证单元`);
    for (const unitId of page.argumentUnitIds || []) {
      if (!units.has(unitId)) issues.push(`${id} 分配了不存在的论证单元 ${unitId}`);
    }
  });
  if (contentDetailMode === "detailed") {
    const assigned = new Set(pages.filter((page) => page.pageRole !== "cover").flatMap((page) => page.argumentUnitIds || []));
    const missing = (argumentMap?.units || [])
      .filter((unit) => unit.type !== "transition" && !assigned.has(unit.id))
      .map((unit) => unit.id);
    if (missing.length) issues.push(`详细展示正文未分配论证单元：${missing.join("、")}`);
  }
  if (coverMode !== "none" && pages[0]?.pageRole !== "cover") issues.push("PagePlan P01 必须是封面");
  if (coverMode === "none" && pages.some((page) => page.pageRole === "cover")) issues.push("PagePlan 禁止新增封面");
  if (pages.every((page) => allowedRoles.has(page.pageRole))) issues.push(...validateNarrativeStructure(pages.map((page) => ({ ...page, narrativeRole: page.pageRole, mainPoint: page.oneSentenceAnswer })), narrativeMode, { strictCoverage: false, strictSequence: false }).issues);
  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}

export function selectPagePlanRepairs(plan, issues) {
  const ids = new Set();
  for (const issue of issues || []) {
    const id = /^(P\d{2})\s/.exec(String(issue))?.[1];
    if (!id || !plan.pages.some((page) => page.pageNo === id)) return [];
    ids.add(id);
  }
  if (ids.size > Math.min(5, Math.ceil(plan.pages.length / 2))) return [];
  return plan.pages.filter((page) => ids.has(page.pageNo)).map((page) => page.pageNo);
}

export function mergePagePlanRepairs(plan, repaired, pageNos) {
  if (!Array.isArray(repaired?.pages) || repaired.pages.length !== pageNos.length
    || repaired.pages.some((page, index) => page.pageNo !== pageNos[index])) throw new Error("PagePlan定向修复页码不匹配");
  const replacement = new Map(repaired.pages.map((page) => [page.pageNo, page]));
  return { ...plan, pages: plan.pages.map((page) => replacement.get(page.pageNo) || page) };
}

export function editorialPageBatches(pages, requestedSize = 3) {
  const size = Math.max(3, Math.min(5, Number(requestedSize) || 3));
  const groups = [];
  for (let start = 0; start < pages.length; start += size) groups.push(pages.slice(start, start + size));
  return groups;
}

export function sourceForEditorialBatch(pages, argumentMap, sourceDocument) {
  const selected = new Set(pages.flatMap((page) => [
    ...(page.sourceRefs || []),
    ...(argumentMap?.units || []).filter((unit) => page.argumentUnitIds.includes(unit.id)).flatMap((unit) => unit.sourceRefs || [])
  ]).flatMap((reference) => sourceBlockIdsForReference(reference, sourceDocument)));
  return { ...sourceDocument, blocks: sourceDocument.blocks.filter((block) => selected.has(block.id)) };
}

export function mergeEditorialBatches(plan, batches) {
  const pages = batches.flatMap((batch) => batch?.pages || []);
  if (pages.length !== plan.pages.length) throw new Error("分组文案缺页，未形成完整大纲");
  for (const [index, page] of pages.entries()) {
    const locked = plan.pages[index];
    if (page.pageNo !== locked.pageNo || page.pageRole !== locked.pageRole || page.communicationTask !== locked.communicationTask
      || page.copyBlueprint?.title !== locked.title || page.copyBlueprint?.oneSentenceAnswer !== locked.oneSentenceAnswer) {
      throw new Error(`${locked.pageNo} 分组文案改动了锁定 PagePlan，未应用任何页面`);
    }
    // Neighbour boundaries are authored once in the plan and cannot drift by batch.
    page.relationship = { fromPrevious: locked.fromPrevious, toNext: locked.toNext };
    page.copyBlueprint.bridgeToNext = locked.toNext;
  }
  return { title: plan.title, sourceSummary: plan.sourceSummary, sourceInsights: plan.sourceInsights, pages, notes: plan.notes || [] };
}

export async function mapEditorialWithConcurrency(items, limit, mapper, signal) {
  const results = new Array(items.length);
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = 0;
  let firstError;
  const workers = Array.from({ length: Math.min(Math.max(1, Math.min(3, Number(limit) || 2)), items.length) }, async () => {
    while (cursor < items.length && !combinedSignal.aborted) {
      const index = cursor++;
      try { results[index] = await mapper(items[index], index, combinedSignal); }
      catch (error) { firstError ||= error; controller.abort(error); }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  combinedSignal.throwIfAborted();
  return results;
}
