const escape = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const pending = (preview) => ["queued", "running"].includes(preview?.status);

export function exportPreviewMarkup(preview, { error = "", busy = false, artifactUrl } = {}) {
  if (!preview) return "";
  const ready = preview.status === "ready" || (!preview.jobId && (preview.montage || preview.slides?.length));
  const status = error ? "预览状态暂不可用，稍后自动重连" : ready ? "导出预览已就绪" : preview.status === "failed" ? "后台预览生成失败" : preview.status === "running" ? "后台正在生成预览" : preview.status === "queued" ? "后台预览排队中" : "导出预览尚未生成";
  const slides = Array.isArray(preview.slides) ? preview.slides.filter((slide) => typeof slide === "string" && slide) : [];
  return `<section class="export-preview-status" aria-label="导出后台预览" style="flex-basis:100%;min-width:0;overflow-wrap:anywhere">
    <p role="status"><strong>${status}</strong> · 不影响下载 PPTX</p>
    ${preview.status === "failed" && !error ? `<p>${escape(preview.error || "预览服务未完成，可单独重试。")}</p>` : ""}
    ${preview.status === "failed" && preview.jobId ? `<button id="retryExportPreview" class="button secondary" type="button" ${busy ? "disabled" : ""}>${busy ? "正在重试预览" : "仅重试预览"}</button>` : ""}
    ${ready ? `<details><summary>查看导出预览${slides.length ? `（${slides.length} 页）` : ""}</summary>
      ${preview.montage ? `<a href="${escape(artifactUrl(preview.montage))}" target="_blank" rel="noopener">查看整套拼图</a>` : ""}
      ${slides.length ? `<ol>${slides.map((slide, index) => `<li><a href="${escape(artifactUrl(slide))}" target="_blank" rel="noopener">查看第 ${index + 1} 页</a></li>`).join("")}</ol>` : ""}</details>` : ""}
  </section>`;
}

// Preview polling has its own lifecycle: a completed/downloadable export stays completed.
export function createExportPreviewController({ request, onChange, setTimer = setTimeout, clearTimer = clearTimeout, interval = 2000 }) {
  let binding = null, timer = null, epoch = 0, busy = false, error = "";
  const notify = () => onChange({ binding, preview: binding?.preview, busy, error });
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = () => {
    stopTimer();
    if (binding && (pending(binding.preview) || error)) timer = setTimer(() => { timer = null; void refresh(); }, interval);
  };
  async function refresh(method = "GET") {
    if (!binding || busy) return;
    const current = binding, token = epoch;
    busy = true;
    if (method === "POST") notify();
    try {
      const result = await request(`/api/v2/projects/${encodeURIComponent(current.projectSlug)}/export-previews/${encodeURIComponent(current.preview.jobId)}`, {
        method,
        ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(10000) } : {})
      });
      if (token !== epoch) return;
      const preview = result?.preview;
      if (!preview || preview.jobId !== current.preview.jobId || (preview.projectSlug && preview.projectSlug !== current.projectSlug)) throw new Error("预览响应不属于当前项目或任务");
      binding.preview = preview;
      error = "";
    } catch (failure) {
      if (token !== epoch) return;
      error = failure.message || "暂时无法读取预览状态";
    } finally {
      if (token === epoch) { busy = false; notify(); schedule(); }
    }
  }
  return {
    bind(next) {
      const eligible = next?.projectSlug && next?.taskId && next?.preview?.jobId && (!next.preview.projectSlug || next.preview.projectSlug === next.projectSlug);
      const key = eligible ? JSON.stringify([next.projectSlug, next.taskId, next.preview.jobId]) : "";
      if (key === (binding?.key || "")) return;
      epoch++; stopTimer(); busy = false; error = "";
      binding = key ? { ...next, key } : null;
      // One GET refreshes restored ready/failed jobs; only pending or network errors keep polling.
      if (binding) timer = setTimer(() => { timer = null; void refresh(); }, 0);
    },
    snapshot() { return { busy, error }; },
    retry() { if (binding?.preview?.status !== "failed") return Promise.resolve(); stopTimer(); return refresh("POST"); },
    dispose() { epoch++; stopTimer(); binding = null; busy = false; error = ""; }
  };
}
