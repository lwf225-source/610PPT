export function assertCommittedSplit(deck, { projectSlug, projectId, expectedRevision, targetPageCount } = {}) {
  const pages = deck?.pages;
  const revision = Number(deck?.storageRevision ?? deck?.revision ?? 0);
  const ids = Array.isArray(pages) ? pages.map((page) => page.pageNo || page.id) : [];
  if (!pages?.length || !deck.project?.slug || revision < 1
    || ids.some((id) => !id) || new Set(ids).size !== ids.length
    || pages.some((page) => !String(page.title || "").trim())) {
    throw new Error("拆页未返回已提交的完整页面，不能标记完成");
  }
  if (projectSlug && deck.project.slug !== projectSlug) throw new Error("拆页返回了其他项目，已拒绝完成");
  if (projectId && (deck.project.id || deck.deckId) !== projectId) throw new Error("拆页项目身份不一致");
  if (expectedRevision !== undefined && revision <= Number(expectedRevision)) throw new Error("拆页没有提交新版本");
  if (targetPageCount && pages.length !== Number(targetPageCount)) throw new Error("拆页结果页数与任务设置不符");
  if (deck.analysisProvider?.contentValidation?.valid !== true) throw new Error("拆页未返回完整页面结果");
}
