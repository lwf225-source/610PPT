function pageNoOf(page = {}, index = 0) {
  return String(page.pageNo || page.id || `P${String(index + 1).padStart(2, "0")}`);
}

function currentVisibleImage(page = {}) {
  return page.finalImage || page.regenerationPreviewImage || null;
}

export function prepareDirectExportDeck(deck = {}) {
  const pages = Array.isArray(deck.pages) ? deck.pages : [];
  if (!pages.length) return { error: "当前项目没有可导出的页面", status: 409 };

  const missingPageNos = pages
    .map((page, index) => currentVisibleImage(page) ? "" : pageNoOf(page, index))
    .filter(Boolean);
  if (missingPageNos.length) {
    return {
      error: `还有 ${missingPageNos.length} 页没有可用成图：${missingPageNos.join("、")}`,
      status: 409,
      missingPageNos
    };
  }

  const usedFallbackPageNos = [];
  const exportPages = pages.map((page, index) => {
    if (page.finalImage) return page;
    usedFallbackPageNos.push(pageNoOf(page, index));
    return {
      ...page,
      finalImage: page.regenerationPreviewImage,
      imagePath: page.regenerationPreviewImage?.path || page.regenerationPreviewImage?.source || page.imagePath || null,
      generationStatus: "generated"
    };
  });

  return {
    deck: { ...deck, pages: exportPages },
    usedFallbackPageNos,
    missingPageNos: []
  };
}
