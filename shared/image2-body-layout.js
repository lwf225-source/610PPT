import { IMAGE2_LAYOUT_KINDS } from './image2-layouts.js';

const aliases = {
  'side-by-side-comparison': 'comparison-grid',
  'layered-framework': 'layered-architecture',
  'flow-or-relationship': 'process-flow',
  'decision-matrix': 'comparison-grid',
  'phased-roadmap': 'roadmap',
  'closing-statement': 'conclusion'
};

// Image2 can draw an authored composition without a corresponding native
// renderer. Never turn its prose into a native layout identifier or truncate it.
export function image2BodyDesignSpec(page = {}, normalize) {
  const plan = page.image2Plan || {};
  const previous = page.designSpec || {};
  const requested = String(plan.compositionKind || previous.layoutKind || 'content-cards').trim();
  const mapped = aliases[requested] || requested;
  const known = IMAGE2_LAYOUT_KINDS.includes(mapped);
  const fallback = normalize(previous, page.pageType, page.visualPlan);
  const descriptions = [
    plan.compositionKind ? (!known ? requested : '') : previous.layout,
    plan.visualIntent || (!plan.compositionKind ? page.visualPlan : '')
  ].filter(Boolean);
  return {
    ...fallback,
    layoutKind: known ? mapped : 'image2-freeform',
    layout: [...new Set(descriptions)].join('；') || previous.layout || fallback.layout,
    hierarchy: previous.hierarchy || fallback.hierarchy,
    spacing: known ? previous.spacing || fallback.spacing : '按本页构图组织区块，保持外部安全边距、清楚的层级与阅读顺序，不强制等宽卡片或等距网格。',
    contentDensity: plan.density || previous.contentDensity || fallback.contentDensity,
    takeawayMode: plan.takeawayMode ?? previous.takeawayMode
  };
}

// Narrow translations of obsolete generated feedback. Keep the stored source
// and all other user requests intact; do not apply this to visible copy.
export function normalizeImage2RepairFeedback(value = '') {
  return String(value)
    .replaceAll('长标题只能换行或精简', '长标题只能换行，保持锁定文案完整')
    .replaceAll('底部结论区及密度范围', '文字清晰可读，结论位置按本页视觉计划')
    .replaceAll('标题分隔线的起点、垂直位置', '分隔线的线宽与颜色；位置及文字间距自由安排');
}
