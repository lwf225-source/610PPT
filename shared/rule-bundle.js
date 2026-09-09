import crypto from 'node:crypto';

export const RULE_PROTOCOL = 1;
export const MAX_RULE_BYTES = 2 * 1024 * 1024;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200000;
const lines = value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(text);
export function ruleDigest(payload) { return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
export function validateRuleBundle(bundle) {
  const p = bundle?.payload;
  if (!p || p.protocol !== RULE_PROTOCOL || !/^[A-Za-z0-9._-]{1,100}$/.test(p.version || '') || !Number.isFinite(Date.parse(p.publishedAt))) throw new Error('云端规则版本不兼容');
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_RULE_BYTES || bundle.sha256 !== ruleDigest(p)) throw new Error('云端规则完整性校验失败');
  const c = p.image2?.cover, b = p.image2?.body, s = p.styleBible;
  if (!text(c?.version) || !text(c?.copyPrompt) || !lines(c?.visualBefore) || !lines(c?.visualAfter) || c?.designSpec?.layoutKind !== 'cover' ||
    !['layout', 'hierarchy', 'contentDensity', 'visualTreatment', 'spacing'].every(k => text(c.designSpec[k])) ||
    !text(b?.version) || !lines(b?.visual) || !lines(b?.audit)) throw new Error('云端页面契约不完整');
  if (!text(s?.version) || !s.fontProfile || !s.styleSystems || !s.typographyScale ||
    !['封面标题','正文页标题','副标题','模块标题','正文','图表标注','关键数字','页脚/备注','底部结论'].every(k => Number(s.typographyScale[k]) > 0)) throw new Error('云端字号风格规则不完整');
  const templates = p.promptTemplates;
  if (!templates || typeof templates !== 'object' || Array.isArray(templates) ||
    !['codex-analyze','codex-merge','codex-rewrite-page'].every(k => text(templates[k])) ||
    !Object.entries(templates).every(([k,v]) => /^[a-z0-9-]+$/.test(k) && text(v))) throw new Error('云端文案模板不完整');
  if (p.editorialProtocol !== undefined) {
    const modes = ['narrative','pyramid','instructional','showcase','briefing'];
    if (p.editorialProtocol !== 1 || !text(p.sourceOnlyContract) || !text(p.pageAllocationPrompt) ||
      !modes.every(mode => text(p.narrativeContracts?.[mode]) && ['focus','detailed'].every(detail => text(p.contentDetailContracts?.[detail]?.[mode]))) ||
      !['codex-detail-review','codex-fluency-focus','codex-fluency-detailed'].every(name => text(templates[name]))) throw new Error('云端内容与审核规则不完整或不兼容');
  }
  return bundle;
}
export function ruleBundleStatus(bundle, source = 'cloud') {
  return { source, version: bundle.payload.version, sha256: bundle.sha256, publishedAt: bundle.payload.publishedAt,
    coverVersion: bundle.payload.image2.cover.version, bodyVersion: bundle.payload.image2.body.version, styleVersion: bundle.payload.styleBible.version,
    editorialProtocol: bundle.payload.editorialProtocol || null };
}
