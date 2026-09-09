// Keep previous artifacts for review; never present stale images as accepted.
export function invalidateEditedPage(deck, pageNo) {
  const isEdited = (page) => [page.id, page.pageNo].includes(pageNo);
  const edited = deck.pages.find(isEdited);
  const anchors = { ...(deck.styleAnchors || {}) };
  const editedAnchorKinds = Object.entries(anchors).filter(([, anchor]) => [edited?.id, edited?.pageNo].includes(anchor?.pageId)).map(([kind]) => kind);
  for (const kind of editedAnchorKinds) anchors[kind] = { ...anchors[kind], status: "stale", confirmedAt: null };
  const jobs = { ...(deck.generationJobs || {}) };
  const pages = deck.pages.map((page) => {
    const affected = isEdited(page) || (editedAnchorKinds.includes("content") && page.pageNo !== anchors.cover?.pageId);
    if (!affected) return page;
    for (const key of [page.id, page.pageNo]) {
      if (jobs[key]) jobs[key] = { ...jobs[key], status: "stale", statusText: "文案或母版已变化，需重新生成" };
    }
    return { ...page, regenerationPreviewImage: page.finalImage || page.regenerationPreviewImage || null,
      finalImage: null, imagePath: null, generationStatus: "stale", reviewStatus: "needs-review", reviewedAt: null };
  });
  return { ...deck, pages, generationJobs: jobs,
    styleAnchors: deck.styleAnchors ? anchors : deck.styleAnchors,
    previousImage2RenderPlan: deck.image2RenderPlan || deck.previousImage2RenderPlan || null,
    image2RenderPlan: null, qaReport: null, exportManifest: null };
}
