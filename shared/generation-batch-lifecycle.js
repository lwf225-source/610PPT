export function generationBatchCanSettle(payload = {}) {
  const pending = Math.max(0, Number(payload.pending || 0));
  const activePageNos = Array.isArray(payload.activePageNos) ? payload.activePageNos.filter(Boolean) : [];
  return pending === 0 && activePageNos.length === 0;
}
