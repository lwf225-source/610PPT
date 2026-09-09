function sortPages(pages = []) {
  return [...pages].sort((left, right) => String(left.pageNo).localeCompare(String(right.pageNo), "zh-CN"));
}

function activeGenerationPageNos(task = null) {
  if (!["generation", "image2-compile"].includes(task?.kind) || !["queued", "running"].includes(task?.status)) return new Set();
  if (task?.operation === "page-regeneration" || task?.input?.operation === "page-regeneration") {
    const pageNo = String(task?.input?.pageIds?.[0] || task?.activePageNos?.[0] || task?.currentPage || "");
    return new Set(pageNo ? [pageNo] : []);
  }
  const concurrency = Math.max(1, Number(task.concurrency) || 1);
  return new Set((task.activePageNos || []).map(String).filter(Boolean).slice(0, concurrency));
}

function preparingImage2PageNo(task = null, pages = []) {
  if (task?.kind !== "image2-compile" || !["queued", "running"].includes(task?.status)) return "";
  const total = Math.max(0, Number(task.total || 0));
  const completed = Math.max(0, Number(task.completed || 0));
  if (total > 0 && completed >= total) return "";
  if (["anchor-ready", "generated", "generated-with-errors"].includes(task?.phase)) return "";
  const candidates = [task.currentPage, ...(task.anchorPageIds || [])].map(String).filter(Boolean);
  const page = candidates
    .map((candidate) => pages.find((item) => [item.pageNo, item.id].map(String).includes(candidate)))
    .find(Boolean) || pages[0];
  const taskPage = (task.pages || []).find((item) => [item.pageNo, item.id].some((id) => id && [page?.pageNo, page?.id].includes(id)));
  // Preparation is only a fallback before this page has public progress.
  // In particular an audit temporarily has no image-generation worker; that
  // must not reset the cover (or its retained image) to preparation.
  if (taskPage?.generationStatus || taskPage?.workStage) return "";
  return String(page?.pageNo || page?.id || "");
}

export function visiblePagesForState({ task = null, deckPages = [], imagePath = () => "" } = {}) {
  const currentTaskPages = sortPages(task?.pages || []);
  const splitInProgress = task?.kind === "split" && task?.status !== "completed";

  if (splitInProgress) {
    return currentTaskPages.map((page) => ({
      ...page,
      pageNo: page.pageNo || page.id,
      imagePath: imagePath(page)
    }));
  }

  const pages = new Map();
  for (const page of deckPages || []) {
    const pageNo = page.pageNo || page.id;
    if (pageNo) pages.set(pageNo, { ...page, pageNo, imagePath: imagePath(page) });
  }

  const completedSplit = task?.kind === "split" && task?.status === "completed";
  const taskGenerationIsActive = ["queued", "running"].includes(task?.status);
  const transientGenerationStatuses = new Set(["queued", "preparing", "generating", "writing"]);
  for (const page of currentTaskPages) {
    const pageNo = page.pageNo || page.id;
    if (!pageNo) continue;
    const deckPage = pages.get(pageNo);
    // Settled tasks are historical progress, not the current page inventory.
    // Structure edits renumber/remove pages only in the committed deck.
    if (!taskGenerationIsActive && !deckPage) continue;
    // A finished batch describes its old inputs, not the current anchor/copy
    // validity. Legacy retained images have importedAt but no updatedAt: when
    // that image was produced after this attempt began and is now stale, its
    // invalidation necessarily happened later too. A genuinely new attempt
    // begins after the retained image and is allowed to publish its result.
    const attemptStartedAt = Date.parse(task?.attemptStartedAt || task?.startedAt || task?.createdAt || "");
    const retainedAt = Date.parse(deckPage?.regenerationPreviewImage?.updatedAt || deckPage?.regenerationPreviewImage?.importedAt || "");
    if (!taskGenerationIsActive && ["generation", "image2-compile"].includes(task?.kind)
      && deckPage?.generationStatus === "stale" && deckPage.regenerationPreviewImage && !deckPage.finalImage
      && Number.isFinite(attemptStartedAt) && retainedAt > attemptStartedAt) continue;
    // A later committed image replaces this settled task's failed output.
    // Keep the historical failure in task history, not on the recovered page.
    if (!taskGenerationIsActive && ["generated", "imported"].includes(deckPage?.generationStatus) && imagePath(deckPage)
      && Date.parse(deckPage.finalImage?.importedAt) > Date.parse(task?.updatedAt || task?.createdAt)) continue;
    // A recovered candidate is newer than this settled task, even before QA
    // accepts it. Preserve its pending state and current diagnostic on the card.
    if (!taskGenerationIsActive && deckPage?.regenerationPreviewImage && imagePath(deckPage)
      && Date.parse(deckPage.regenerationPreviewImage.updatedAt) > Date.parse(task?.updatedAt || task?.createdAt)) continue;
    const mergedPage = completedSplit && deckPage
      ? { ...page, ...deckPage, pageNo, generationStatus: page.generationStatus || deckPage.generationStatus, imagePath: imagePath(deckPage) || imagePath(page) }
      : { ...(deckPage || {}), ...page, pageNo, imagePath: imagePath(page) || imagePath(deckPage) };
    if (!taskGenerationIsActive && transientGenerationStatuses.has(page.generationStatus)) {
      mergedPage.generationStatus = deckPage?.generationStatus || (mergedPage.imagePath ? "generated" : "failed");
    }
    pages.set(pageNo, mergedPage);
  }

  const sortedPages = sortPages([...pages.values()]);
  const activePageNos = activeGenerationPageNos(task);
  const preparingPageNo = activePageNos.size ? "" : preparingImage2PageNo(task, sortedPages);
  return sortPages(sortedPages.map((page) => {
    if (!activePageNos.has(String(page.pageNo))) return page;
    const livePage = currentTaskPages.find((item) => String(item.pageNo || item.id) === String(page.pageNo));
    if (["generated", "imported", "completed", "failed", "dispatched", "stale", "cancelled"].includes(livePage?.generationStatus)
      || ["qa-queued", "auditing", "binding", "generation-queued"].includes(livePage?.workStage)) return page;
    return { ...page, generationStatus: "generating" };
  }).map((page) => String(page.pageNo) === preparingPageNo
    ? { ...page, generationStatus: "preparing" }
    : page));
}

export function missingImagePageIdsForState({ task = null, deckPages = [], imagePath = () => "" } = {}) {
  return visiblePagesForState({ task, deckPages, imagePath })
    .filter((page) => !imagePath(page))
    .map((page) => page.id || page.pageNo)
    .filter((pageId, index, pageIds) => pageId && pageIds.indexOf(pageId) === index);
}
