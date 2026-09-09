import { consultingCopyBlocks } from '../shared/consulting-copy-ir.js';
import { reviewInstructions } from '../shared/editorial-rule-runtime.js';
import { editorialReviewDefaults } from '../shared/editorial-review-defaults.js';

export const CONTENT_DETAIL_REVIEW_VERSION = 'content-detail-review-v2';
export const CONTENT_DETAIL_APPLY_VERSION = 'retain-protected-fields-v2';

const OMISSION_REASONS = ['duplicate', 'irrelevant', 'cover', 'short-source', 'capacity'];
const LIMITATION = '仅确定性核验原文引文、页面覆盖和字段结构；解释是否充分保留、改写是否受原文支持由模型判断，不等同于语义或事实已验证。';

// Enumerating existing leaves prevents model-controlled traversal and structural
// changes. Empty strings are intentionally included so missing explanation can
// be restored into an existing body field.
function reviewPages(outline) {
  return outline.pages.map(page => {
    const copy = page.copyBlueprint;
    const fields = [];
    const add = (path, text, editable = true) => {
      if (typeof text === 'string') fields.push({ path, text, editable });
    };
    add('title', copy.title, false);
    for (const key of ['subtitle', 'lead']) add(key, copy[key]);
    (copy.modules || []).forEach((module, i) => {
      add(`modules.${i}.label`, module.label, false);
      for (const key of ['headline', 'body']) add(`modules.${i}.${key}`, module[key]);
      (module.items || []).forEach((text, j) => add(`modules.${i}.items.${j}`, text));
    });
    add('example', copy.example);
    (copy.evidence || []).forEach((text, i) => add(`evidence.${i}`, text));
    add('boundary', copy.boundary);
    (copy.bottomTakeaways || []).forEach((text, i) => add(`bottomTakeaways.${i}`, text));
    return {
      pageNo: page.pageNo,
      pageRole: page.pageRole,
      pageLogic: copy.pageLogic,
      sourceRefs: copy.sourceRefs || page.sourceRefs || [],
      moduleSourceRefs: (copy.modules || []).map(module => module.sourceRefs || []),
      fields
    };
  });
}

export function buildContentDetailReviewSchema(outline) {
  const pageNos = outline.pages.map(page => page.pageNo);
  const string = { type: 'string' };
  return {
    type: 'object', additionalProperties: false, required: ['pageReviews', 'edits'],
    properties: {
      pageReviews: {
        type: 'array', minItems: pageNos.length, maxItems: pageNos.length,
        items: {
          type: 'object', additionalProperties: false, required: ['pageNo', 'reviewReason', 'points'],
          properties: {
            pageNo: { type: 'string', enum: pageNos },
            reviewReason: string,
            points: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['sourceQuote', 'decision', 'fieldPath', 'omissionReason', 'reason'],
                properties: {
                  sourceQuote: string,
                  decision: { type: 'string', enum: ['retained', 'omitted'] },
                  fieldPath: string,
                  omissionReason: { type: 'string', enum: ['', ...OMISSION_REASONS] },
                  reason: string
                }
              }
            }
          }
        }
      },
      edits: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          required: ['pageNo', 'path', 'before', 'after', 'reason', 'sourceQuote'],
          properties: {
            pageNo: { type: 'string', enum: pageNos }, path: string,
            before: string, after: string, reason: string, sourceQuote: string
          }
        }
      }
    }
  };
}

export function buildContentDetailReviewPrompt(outline, sourceText, rulePayload) {
  return [
    reviewInstructions('codex-detail-review', rulePayload, editorialReviewDefaults['codex-detail-review']),
    '原文：', String(sourceText || ''),
    '待检查页面：', JSON.stringify(reviewPages(outline))
  ].join('\n');
}

const nonempty = value => typeof value === 'string' && Boolean(value.trim());

function applyReview(outline, review, sourceText, retainProtectedFields = false) {
  const pages = reviewPages(outline);
  if (!Array.isArray(review?.pageReviews) || !Array.isArray(review?.edits)
    || new Set(pages.map(page => page.pageNo)).size !== pages.length
    || JSON.stringify(review.pageReviews.map(page => page?.pageNo)) !== JSON.stringify(pages.map(page => page.pageNo))) {
    throw new Error('详细展示检查未完整且唯一地覆盖全部页面');
  }
  const isSourceQuote = quote => nonempty(quote) && typeof sourceText === 'string' && sourceText.includes(quote);
  const next = structuredClone(outline);
  const seen = new Set();
  const accepted = [], rejectedEdits = [];
  const reject = (edit, reason) => {
    if (!retainProtectedFields) throw new Error(reason);
    rejectedEdits.push({ ...edit, rejectionReason: reason, action: 'retained-original' });
  };
  for (const edit of review.edits) {
    const index = pages.findIndex(page => page.pageNo === edit?.pageNo);
    const field = pages[index]?.fields.find(field => field.path === edit.path && field.editable);
    const key = `${edit?.pageNo}:${edit?.path}`;
    if (!field || seen.has(key) || edit.before !== field.text || !nonempty(edit.reason)
      || !isSourceQuote(edit.sourceQuote) || typeof edit.after !== 'string') {
      throw new Error('详细展示检查返回了无效字段、原句或原文引文');
    }
    const after = edit.after.trim();
    if (after === edit.before || after.length > Math.max(260, edit.before.length)) {
      throw new Error('详细展示检查返回了无效或过长的替换文案');
    }
    seen.add(key);
    if (edit.path === 'boundary' && nonempty(edit.before) && !after) {
      reject(edit, '详细展示检查不能清空限定条件');
      continue;
    }
    accepted.push(edit);
    const parts = edit.path.split('.');
    const leaf = parts.pop();
    let target = next.pages[index].copyBlueprint;
    for (const part of parts) target = target[part];
    target[leaf] = after;
  }
  // Recheck the combined result before allowing deletion of numeric context.
  // Restoring an unsafe deletion can only add information back to the page.
  for (const edit of [...accepted]) {
    if (edit.after.trim() || !/\d/.test(edit.before)) continue;
    const index = pages.findIndex(page => page.pageNo === edit.pageNo);
    if (reviewPages({ pages: [next.pages[index]] })[0].fields.some(field => field.text === edit.before)) continue;
    reject(edit, '详细展示检查删除了含数字的独有信息');
    const parts = edit.path.split('.');
    const leaf = parts.pop();
    let target = next.pages[index].copyBlueprint;
    for (const part of parts) target = target[part];
    target[leaf] = edit.before;
    accepted.splice(accepted.indexOf(edit), 1);
  }
  const finalPages = reviewPages(next);
  for (const [index, pageReview] of review.pageReviews.entries()) {
    const page = finalPages[index];
    const isCover = page.pageRole === 'cover' || page.pageLogic === 'cover';
    if (!nonempty(pageReview.reviewReason) || !Array.isArray(pageReview.points)
      || (!pageReview.points.length && !isCover && nonempty(sourceText))) throw new Error('详细展示检查缺少逐页原文信息点或检查说明');
    for (const [pointIndex, point] of pageReview.points.entries()) {
      if (!isSourceQuote(point?.sourceQuote) || !nonempty(point?.reason)) throw new Error(`详细展示检查的信息点缺少有效原文引文或理由：${page.pageNo} points.${pointIndex}.sourceQuote 必须逐字匹配原文，reason不能为空`);
      if (point.decision === 'retained') {
        if (point.omissionReason !== '' || !page.fields.some(field => field.path === point.fieldPath && nonempty(field.text))) {
          throw new Error('详细展示检查的保留信息未指向修改后有效可见字段');
        }
      } else if (point.decision === 'omitted') {
        if (point.fieldPath !== '' || !OMISSION_REASONS.includes(point.omissionReason)) throw new Error('详细展示检查缺少有效遗漏理由');
      } else throw new Error('详细展示检查返回了无效信息点决策');
    }
    const isBody = field => /^(modules\.|evidence\.)/.test(field.path) && nonempty(field.text);
    if (pages[index].fields.some(isBody) && !page.fields.some(isBody)) throw new Error('详细展示检查清空了正文');
    if (accepted.some(edit => edit.pageNo === page.pageNo)) {
      const blocks = consultingCopyBlocks(next.pages[index].copyBlueprint);
      if (blocks.length > 24) throw new Error('详细展示检查超过单页24项可见文字容量');
      next.pages[index].copyBlueprint.verbatimText = blocks.map(block => block.text);
    }
  }
  return { outline: next, edits: accepted, rejectedEdits };
}

export function applyContentDetailReview(outline, review, sourceText) {
  return applyReview(outline, review, sourceText).outline;
}

export function reviewContentDetailEdits(outline, review, sourceText) {
  const canonical = structuredClone(review);
  const quoteRepairs = [];
  // PDF extraction inserts line breaks/indentation inside otherwise exact quotes.
  // Locate a unique whitespace-only match, then restore the actual source span.
  // Wording, punctuation and digits must remain identical; no fuzzy matching.
  const positions = [];
  let compactSource = '';
  for (let i = 0; i < (sourceText || '').length; i++) {
    if (!/\s/.test(sourceText[i])) { compactSource += sourceText[i]; positions.push(i); }
  }
  const repair = (record, path) => {
    const quote = record?.sourceQuote;
    if (!nonempty(quote) || typeof sourceText !== 'string' || sourceText.includes(quote)) return;
    const compact = quote.replace(/\s/g, '');
    const start = compactSource.indexOf(compact);
    if (!compact || start < 0 || compactSource.indexOf(compact, start + 1) >= 0) return;
    const exact = sourceText.slice(positions[start], positions[start + compact.length - 1] + 1);
    const tokenShape = text => text.replace(/([A-Za-z0-9])\s+(?=[A-Za-z0-9])/g, '$1\u0000').replace(/\s/g, '');
    if (tokenShape(exact) !== tokenShape(quote)) return;
    record.sourceQuote = exact;
    quoteRepairs.push({ path, originalQuote: quote, sourceQuote: exact, reason: 'unique-whitespace-match' });
  };
  if (Array.isArray(canonical?.edits)) canonical.edits.forEach((edit, i) => repair(edit, `edits.${i}.sourceQuote`));
  if (Array.isArray(canonical?.pageReviews)) canonical.pageReviews.forEach((page, i) => {
    if (Array.isArray(page?.points)) page.points.forEach((point, j) => repair(point, `pageReviews.${i}.points.${j}.sourceQuote`));
  });
  try {
    return { ...applyReview(outline, canonical, sourceText, true), pageReviews: canonical.pageReviews, quoteRepairs };
  } catch (error) {
    const invalid = [];
    if (Array.isArray(canonical?.edits)) canonical.edits.forEach((edit, i) => {
      if (!nonempty(edit?.sourceQuote) || !sourceText?.includes(edit.sourceQuote)) invalid.push(`edits.${i} ${edit?.pageNo} ${edit?.path} sourceQuote`);
    });
    if (invalid.length) error.message += `：${invalid.join('；')} 必须逐字匹配原文`;
    throw error;
  }
}
