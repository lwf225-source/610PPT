const escape = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const ACTIVE = new Set(["queued", "running", "cancelling", "committing"]);
export function projectHistoryBusy(tasks = [], projectSlug = "") {
  return tasks.some((task) => (!projectSlug || (task.projectSlug || task.input?.projectSlug) === projectSlug) && (ACTIVE.has(task.status) || (!["completed", "failed", "cancelled", "paused"].includes(task.status) && ["cancelling", "committing"].includes(task.phase))));
}
export function historyRestorePayload(history, revisionId) {
  const revision = history?.revisions?.find((item) => item.revisionId === revisionId);
  if (!revision || revision.isCurrent || revision.kind === "current") throw new Error("请选择一个非当前历史版本");
  if (!history.projectId || !Number.isSafeInteger(history.currentRevision)) throw new Error("历史版本缺少当前项目修订号，请刷新列表");
  return { revisionId, projectId: history.projectId, expectedRevision: history.currentRevision };
}
export function tasksAfterHistoryRestore(tasks = [], deck = {}) {
  const restoredAt = Date.parse(deck?.historyRestore?.restoredAt || "");
  if (!Number.isFinite(restoredAt)) return tasks;
  return tasks.filter((task) => Date.parse(task.createdAt || "") > restoredAt);
}

export function createProjectHistoryDialog({ document, request, onRestored, isBusy = () => false }) {
  const dialog = document.createElement("dialog");
  dialog.id = "projectHistoryDialog";
  dialog.className = "project-history-dialog";
  dialog.setAttribute("aria-labelledby", "projectHistoryTitle");
  document.body.append(dialog);
  let project = null, history = null, selected = "", confirming = false, loading = false, restoring = false, blocked = false, stale = false, error = "", epoch = 0;
  const close = () => { if (restoring) return; epoch++; dialog.close(); };
  dialog.addEventListener("cancel", (event) => { if (restoring) event.preventDefault(); else epoch++; });
  const render = () => {
    const busy = blocked || isBusy(project?.slug);
    const revisions = history?.revisions || [];
    const choice = revisions.find((item) => item.revisionId === selected);
    dialog.innerHTML = `<section class="project-history-shell">
      <header><div><span class="eyebrow">已提交历史</span><h3 id="projectHistoryTitle">${escape(project?.title || "项目")} · 历史版本</h3></div><button class="button secondary" data-history-close type="button" ${restoring ? "disabled" : ""}>关闭</button></header>
      <p class="history-boundary">仅恢复文案与配置为新版本，旧图仅参考，需要重新确认风格、生成并验收；不会删除当前历史。</p>
      <p role="status" class="history-status">${loading ? "正在读取已提交历史…" : error ? escape(error) : busy ? "项目有运行中的任务，暂不能恢复；请等待任务结束后刷新。" : `当前存储修订 ${history?.currentRevision ?? "—"} · ${revisions.length} 条已提交记录`}</p>
      <div class="project-history-list">${revisions.map((item) => `<label class="project-history-item"><input type="radio" name="history-revision" value="${escape(item.revisionId)}" ${selected === item.revisionId ? "checked" : ""} ${loading || restoring || busy || stale || item.isCurrent || item.kind === "current" ? "disabled" : ""}><span><strong>修订 ${escape(item.storageRevision)}${item.isCurrent || item.kind === "current" ? " · 当前版本" : ""}</strong><span>${escape(item.title || "未命名文稿")}</span><small>${escape(item.pageCount)} 页 · ${escape(item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN") : "时间未记录")}</small></span></label>`).join("") || (!loading ? '<p class="empty-state">暂无可验证的已提交历史。未提交候选快照不会列入恢复列表。</p>' : "")}</div>
      ${history?.ignored?.length ? `<small class="history-ignored">${history.ignored.length} 个缺少提交依据或校验不通过的快照未列入。</small>` : ""}
      ${confirming && choice ? `<section class="history-confirm" aria-label="二次确认恢复"><strong>确认将修订 ${escape(choice.storageRevision)} 的文案与配置恢复为新版本？</strong><p>当前修订 ${escape(history.currentRevision)} 会保留。恢复后回到拆页文案，旧图与旧导出不会作为新版本完成依据。</p><div><button class="button secondary" data-history-back type="button" ${restoring ? "disabled" : ""}>返回选择</button><button class="button primary" data-history-confirm type="button" ${restoring || busy || stale ? "disabled" : ""}>${restoring ? "正在恢复…" : "确认恢复为新版本"}</button></div></section>` : ""}
      <footer><button class="button secondary" data-history-refresh type="button" ${loading || restoring ? "disabled" : ""}>刷新列表</button><button class="button primary" data-history-select type="button" ${!choice || choice.isCurrent || loading || restoring || busy || stale || confirming ? "disabled" : ""}>恢复所选版本</button></footer>
    </section>`;
    dialog.querySelector("[data-history-close]").addEventListener("click", close);
    dialog.querySelector("[data-history-refresh]").addEventListener("click", () => { void load(); });
    dialog.querySelectorAll('[name="history-revision"]').forEach((input) => input.addEventListener("change", () => { selected = input.value; confirming = false; render(); }));
    dialog.querySelector("[data-history-select]").addEventListener("click", () => { if (!busy && !stale) { confirming = true; render(); } });
    dialog.querySelector("[data-history-back]")?.addEventListener("click", () => { confirming = false; render(); });
    dialog.querySelector("[data-history-confirm]")?.addEventListener("click", () => { void restore(); });
  };
  async function load() {
    if (restoring) return;
    const token = ++epoch, selectedProject = project;
    loading = true; confirming = false; selected = ""; error = ""; render();
    try {
      const [result, taskResult] = await Promise.all([
        request(`/api/v2/projects/${encodeURIComponent(selectedProject.slug)}/history`),
        request(`/api/v2/projects/${encodeURIComponent(selectedProject.slug)}/tasks?limit=50`)
      ]);
      if (token !== epoch) return;
      if (result.projectSlug !== selectedProject.slug || !Array.isArray(result.revisions)) throw new Error("历史响应与当前项目不匹配");
      history = result; stale = false;
      blocked = Boolean(result.projectBusy) || projectHistoryBusy(taskResult.tasks || []);
    } catch (failure) { if (token === epoch) { error = `读取历史失败：${failure.message}，请刷新列表。`; stale = true; } }
    finally { if (token === epoch) { loading = false; render(); } }
  }
  async function restore() {
    if (restoring || loading || stale || blocked || isBusy(project?.slug) || !confirming) return;
    const selectedProject = project, token = epoch;
    const body = historyRestorePayload(history, selected);
    restoring = true; error = ""; render();
    try {
      const result = await request(`/api/v2/projects/${encodeURIComponent(selectedProject.slug)}/history/restore`, { method: "POST", body: JSON.stringify(body) });
      if (token !== epoch) return;
      if (!result.deck || (result.deck.project?.slug || result.deck.projectSlug) !== selectedProject.slug) throw new Error("恢复响应项目不匹配，请重新打开项目核对");
      await onRestored(result, selectedProject);
      dialog.close();
    } catch (failure) {
      if (token !== epoch) return;
      stale = failure.status === 409 || failure.statusCode === 409;
      error = stale ? "项目已有更新或仍有任务运行，本次恢复未覆盖新版本。请刷新列表后重新选择，系统不会自动重试。" : `恢复未完成：${failure.message}`;
    } finally { if (token === epoch) { restoring = false; render(); } }
  }
  return {
    open(next) { if (restoring) return; project = { ...next }; history = null; selected = ""; blocked = false; stale = false; confirming = false; dialog.showModal(); void load(); },
    refreshBusy() { if (dialog.open) render(); },
    dispose() { epoch++; dialog.remove(); }
  };
}
