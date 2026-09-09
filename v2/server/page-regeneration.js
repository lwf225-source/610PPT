export function preparePageRegeneration(deck = {}, requestedPageNo = "", feedback = "") {
  const pageNo = String(requestedPageNo || "").trim();
  const generationInstruction = String(feedback || "").trim();
  if (generationInstruction.length < 2) {
    return { error: "请先填写 AI 修改提示词", status: 400 };
  }

  const pages = Array.isArray(deck.pages) ? [...deck.pages] : [];
  const pageIndex = pages.findIndex((page) => [page.pageNo, page.id].includes(pageNo));
  if (pageIndex < 0) return { error: "未找到要重新生成的页面", status: 404 };

  const currentPage = pages[pageIndex];
  const pageId = currentPage.id || currentPage.pageNo || pageNo;
  const regenerationPreviewImage = currentPage.finalImage || currentPage.regenerationPreviewImage || null;
  pages[pageIndex] = {
    ...currentPage,
    generationInstruction,
    regenerationPreviewImage,
    finalImage: null,
    imagePath: null,
    generationStatus: "queued"
  };

  const generationJobs = { ...(deck.generationJobs || {}) };
  delete generationJobs[pageId];
  if (currentPage.pageNo) delete generationJobs[currentPage.pageNo];

  return {
    pageId,
    pageNo: currentPage.pageNo || pageNo,
    deck: {
      ...deck,
      pages,
      generationJobs,
      qaReport: null,
      exportManifest: null
    }
  };
}

export function prepareQaPageRegenerations(deck = {}, selections = []) {
  let preparedDeck = deck;
  const pageIds = [];
  const pageNos = [];
  for (const selection of selections) {
    const prepared = preparePageRegeneration(preparedDeck, selection?.pageNo, selection?.feedback);
    if (prepared.error) return prepared;
    preparedDeck = prepared.deck;
    pageIds.push(prepared.pageId);
    pageNos.push(prepared.pageNo);
  }
  return { deck: preparedDeck, pageIds, pageNos };
}
