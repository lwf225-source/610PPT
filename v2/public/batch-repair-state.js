function pageNoOf(page = {}) {
  return String(page.pageNo || page.id || "").trim();
}

function taskOperation(task = {}) {
  return String(task.operation || task.input?.operation || "");
}

function scopedPageNos(task = {}) {
  return new Set([
    ...(task.input?.pageIds || []),
    ...(task.activePageNos || []),
    ...(task.pages || []).map(pageNoOf),
    ...(task.completedPageNos || []),
    ...(task.failedPages || []).map((item) => String(item?.pageNo || item?.pageId || ""))
  ].map(String).filter(Boolean));
}

function activePageNos(task = {}) {
  const concurrency = Math.max(1, Number(task.concurrency) || 1);
  return new Set((task.activePageNos || []).map(String).filter(Boolean).slice(0, concurrency));
}

export function batchRepairState(task = null, page = {}, { excludedPageNos = [] } = {}) {
  if (task?.kind !== "generation" || taskOperation(task) !== "qa-batch-regeneration") return null;
  const pageNo = pageNoOf(page);
  if (new Set((excludedPageNos || []).map(String)).has(pageNo)) return null;
  if (!pageNo || !scopedPageNos(task).has(pageNo)) return null;

  const taskPage = (task.pages || []).find((item) => pageNoOf(item) === pageNo) || {};
  const failed = taskPage.generationStatus === "failed"
    || (task.failedPages || []).some((item) => [item?.pageNo, item?.pageId].map(String).includes(pageNo));
  if (failed) return { key: "failed", label: "修复失败" };

  const completed = taskPage.generationStatus === "generated"
    || (task.completedPageNos || []).map(String).includes(pageNo);
  if (completed) return { key: "completed", label: "修复完成" };

  if (["paused", "cancelled"].includes(task.status) || taskPage.generationStatus === "cancelled") {
    return { key: "stopped", label: "修复已中断" };
  }
  if (task.status === "failed") return { key: "failed", label: "修复未完成" };

  if (["queued", "running"].includes(task.status)
    && (taskPage.generationStatus === "generating" || activePageNos(task).has(pageNo))) {
    return { key: "generating", label: "修复中" };
  }

  return { key: "queued", label: "排队中" };
}

export function batchRepairCounts(task = null, pages = [], options = {}) {
  const counts = { queued: 0, generating: 0, completed: 0, failed: 0, stopped: 0, total: 0 };
  for (const page of pages || []) {
    const repair = batchRepairState(task, page, options);
    if (!repair) continue;
    counts[repair.key] += 1;
    counts.total += 1;
  }
  return counts;
}
