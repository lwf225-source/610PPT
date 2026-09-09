function pageNumber(value = "") {
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

export function sortGenerationPageNos(pageNos = []) {
  return [...new Set((pageNos || []).map(String).filter(Boolean))]
    .sort((left, right) => pageNumber(left) - pageNumber(right) || left.localeCompare(right, "zh-CN"));
}

function terminalAction(job) {
  if (["generated", "imported", "dispatched"].includes(job?.status)) return "completed";
  if (job?.status === "failed") return "failed";
  return "";
}

// Jobs publish independently as soon as their state changes. Sorting stabilizes
// the event order within a snapshot; an unfinished earlier page never buffers
// a completed later page. The UI owns the stable card order.
export function orderedGenerationActions(jobs = {}, pageNos = [], emitted = {}) {
  const byPageNo = new Map(
    Object.values(jobs || {})
      .filter((job) => job?.pageNo)
      .map((job) => [String(job.pageNo), job])
  );
  const nextEmitted = { ...(emitted || {}) };
  const actions = [];

  for (const pageNo of sortGenerationPageNos(pageNos)) {
    const job = byPageNo.get(pageNo);
    const published = nextEmitted[pageNo] || "";
    if (["completed", "failed"].includes(published)) continue;
    if (!job) continue;

    const terminal = terminalAction(job);
    if (terminal) {
      if (published !== "started") actions.push({ type: "started", pageNo, job });
      actions.push({ type: terminal, pageNo, job });
      nextEmitted[pageNo] = terminal;
      continue;
    }

    if (job.status === "generating" && published !== "started") {
      actions.push({ type: "started", pageNo, job });
      nextEmitted[pageNo] = "started";
    }
  }

  return { actions, emitted: nextEmitted };
}
