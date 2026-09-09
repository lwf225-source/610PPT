// Browser-safe data accessor. The server installs one validated snapshot per
// process; browser tasks pass their captured payload explicitly instead.
let active = null;
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function installEditorialRules(payload) {
  if (active) throw new Error('运行中的规则快照不可替换');
  active = freeze(structuredClone(payload));
}
export function editorialRule(...keys) {
  if (!active) return null;
  let value = active;
  for (const key of keys) value = value?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error('云端规则缺少 ' + keys.join('.') + '，请更新规则后重试');
  return value;
}
export function reviewInstructions(name, payload, fallback) {
  if (payload) {
    const value = payload.promptTemplates?.[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error('云端审核规则缺少 ' + name);
    return value;
  }
  return editorialRule('promptTemplates', name) ?? fallback;
}
