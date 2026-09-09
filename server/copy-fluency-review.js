import { consultingCopyBlocks } from '../shared/consulting-copy-ir.js';
import { reviewInstructions } from '../shared/editorial-rule-runtime.js';
import { editorialReviewDefaults } from '../shared/editorial-review-defaults.js';

export const COPY_FLUENCY_VERSION = 'copy-fluency-v1';
export const COPY_FLUENCY_APPLY_VERSION = 'retain-unsafe-edits-v1';
const unsafeEdit = message => Object.assign(new Error(message), { code: 'FLUENCY_UNSAFE_EDIT' });

// Only visible strings are editable. References, page structure and internal
// claims never become model-controlled paths.
export function fluencyReviewPages(outline) {
  return outline.pages.map(page => {
    const copy = page.copyBlueprint;
    const fields = [];
    const add = (path, text) => { if (typeof text === 'string' && text.trim()) fields.push({ path, text }); };
    for (const key of ['title', 'subtitle', 'lead']) add(key, copy[key]);
    (copy.modules || []).forEach((module, i) => {
      for (const key of ['label', 'headline', 'body']) add(`modules.${i}.${key}`, module[key]);
      (module.items || []).forEach((text, j) => add(`modules.${i}.items.${j}`, text));
    });
    add('example', copy.example);
    (copy.evidence || []).forEach((text, i) => add(`evidence.${i}`, text));
    add('boundary', copy.boundary);
    (copy.bottomTakeaways || []).forEach((text, i) => add(`bottomTakeaways.${i}`, text));
    return { pageNo: page.pageNo, fields };
  });
}

export function buildFluencyReviewSchema(outline) {
  const pageNos = outline.pages.map(page => page.pageNo);
  return {
    type: 'object', additionalProperties: false, required: ['checkedPageNos', 'edits'],
    properties: {
      checkedPageNos: { type: 'array', minItems: pageNos.length, maxItems: pageNos.length, items: { type: 'string', enum: pageNos } },
      edits: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['pageNo', 'path', 'before', 'after', 'reason'],
        properties: {
          pageNo: { type: 'string', enum: pageNos }, path: { type: 'string' },
          before: { type: 'string' }, after: { type: 'string' }, reason: { type: 'string' }
        }
      } }
    }
  };
}

export function buildFluencyReviewPrompt(outline, sourceText, rulePayload) {
  const name = outline.contentDetailMode === 'detailed' ? 'codex-fluency-detailed' : 'codex-fluency-focus';
  return [
    reviewInstructions(name, rulePayload, editorialReviewDefaults[name]),
    '原文（只用于理解原意）：', sourceText,
    '待检查页面：', JSON.stringify(fluencyReviewPages(outline))
  ].join('\n');
}

const numericTokens = text => text.match(/[+-]?\d+(?:[.,]\d+)*(?:[%％])?/g) || [];

export function applyFluencyReview(outline, review) {
  const pages = fluencyReviewPages(outline);
  if (JSON.stringify(review?.checkedPageNos) !== JSON.stringify(pages.map(page => page.pageNo)) || !Array.isArray(review?.edits)) {
    throw new Error('语句检查未覆盖全部页面');
  }
  const next = structuredClone(outline);
  const seen = new Set();
  for (const edit of review.edits) {
    const index = pages.findIndex(page => page.pageNo === edit.pageNo);
    const field = pages[index]?.fields.find(field => field.path === edit.path);
    const key = `${edit.pageNo}:${edit.path}`;
    if (!field || seen.has(key) || edit.before !== field.text || typeof edit.after !== 'string' || !edit.reason?.trim()) {
      throw new Error('语句检查返回了无效字段或不匹配的原句');
    }
    seen.add(key);
    if (!edit.after.trim() && ['title', 'boundary'].includes(edit.path)) throw unsafeEdit('语句检查不能清空标题或限定条件');
    if (edit.after === edit.before || edit.after.length > Math.max(260, edit.before.length)) throw new Error('语句检查返回了无效替换文案');
    // Reject changed quantities before applying anything to the caller's data.
    if (edit.after.trim() && JSON.stringify(numericTokens(edit.before)) !== JSON.stringify(numericTokens(edit.after))) {
      throw unsafeEdit('语句检查修改了数字，未应用文案');
    }
    const parts = edit.path.split('.');
    const leaf = parts.pop();
    let target = next.pages[index].copyBlueprint;
    for (const part of parts) target = target[part];
    target[leaf] = edit.after.trim();
  }
  for (const [index, page] of next.pages.entries()) {
    const fields = fluencyReviewPages({ pages: [page] })[0].fields;
    for (const edit of review.edits.filter(edit => edit.pageNo === page.pageNo && !edit.after.trim())) {
      if (numericTokens(edit.before).length && !fields.some(field => field.text === edit.before)) {
        throw unsafeEdit('语句检查删除了含数字的独有信息');
      }
    }
    const hadBody = pages[index].fields.some(field => /^(modules\.|evidence\.)/.test(field.path));
    if (hadBody && !fields.some(field => /^(modules\.|evidence\.)/.test(field.path))) throw unsafeEdit('语句检查清空了正文');
    if (review.edits.some(edit => edit.pageNo === page.pageNo)) {
      page.copyBlueprint.verbatimText = consultingCopyBlocks(page.copyBlueprint).map(block => block.text);
    }
  }
  return next;
}

// A rejected editorial suggestion must not delete the original or discard
// independently safe suggestions. Coverage, identity and path errors stay fatal.
export function reviewFluencyEdits(outline, review) {
  applyFluencyReview(outline, { ...review, edits: Array.isArray(review?.edits) ? [] : review?.edits });
  const accepted = [], rejectedEdits = [], seen = new Set();
  let result = structuredClone(outline);
  for (const edit of review.edits) {
    const key = `${edit?.pageNo}:${edit?.path}`;
    if (seen.has(key)) throw new Error('语句检查返回了重复字段');
    seen.add(key);
    try {
      // Validate against all accepted edits together: a later deletion cannot
      // remove the only remaining copy that justified an earlier deletion.
      result = applyFluencyReview(outline, { ...review, edits: [...accepted, edit] });
      accepted.push(edit);
    } catch (error) {
      if (error.code !== 'FLUENCY_UNSAFE_EDIT') throw error;
      rejectedEdits.push({ ...edit, rejectionReason: error.message, action: 'retained-original' });
    }
  }
  return { outline: result, checkedPageNos: [...review.checkedPageNos], edits: accepted, rejectedEdits };
}
