import { referencePreviewUrl } from "./reference-preview.js";
const DRAFT_KEY = "610ppt-style-reference-draft-v1";
const roles = { cover: "封面", directory: "目录", content: "正文", data: "数据", process: "流程", conclusion: "结论" };
const statusLabels = { uploaded: "已上传 · 将在下一步分析", uploading: "正在上传", parsing: "正在解析页面", analyzing: "正在识别风格", ready: "参考已就绪", failed: "解析未完成" };

export function createStyleReferenceUpload({ root, fileInput = root.querySelector("#referenceFile"), api, onChange, onNotice, onAttach, currentProject }) {
  let reference = null;
  let epoch = 0;
  let pollTimer = null;
  let busy = false;
  let uploading = false;
  let selected = new Set();
  let selectionDirty = false;
  let roleOverrides = {};
  const $ = (id) => root.querySelector(`#${id}`);
  const remember = (id) => { try { id ? localStorage.setItem(DRAFT_KEY, id) : localStorage.removeItem(DRAFT_KEY); } catch {} };
  const stopPoll = () => { clearTimeout(pollTimer); pollTimer = null; };
  const notify = () => onChange?.(reference, { busy, selectionDirty });
  const imageUrl = (page) => referencePreviewUrl(page.previewUrl || `/api/v2/style-references/${encodeURIComponent(reference.id)}/pages/${encodeURIComponent(page.id)}/image`);

  function render() {
    $("referenceEmpty").hidden = Boolean(reference);
    $("referenceDetails").hidden = !reference;
    $("referenceUpload").disabled = busy;
    $("referenceUpload").textContent = reference ? "替换参考" : "上传图片、PPT 或 PDF";
    $("referenceRemove").hidden = !reference;
    $("referenceRemove").disabled = busy;
    $("referenceStatus").textContent = busy ? "正在处理参考" : reference ? statusLabels[reference.status] || "正在处理" : "仅用于视觉风格与排版";
    $("referenceStatus").dataset.mode = reference?.status === "failed" ? "failed" : reference?.status === "ready" ? "connected" : "neutral";
    if (!reference) return;
    $("referenceName").textContent = reference.name || (reference.files || []).map((file) => file.name || file.fileName).filter(Boolean).join("、") || "我的参考风格";
    const previewWarnings = [...new Set((reference.pages || []).flatMap((page) => page.metadata?.warnings || []).filter((message) => message.includes("可能缺失")))];
    $("referenceError").textContent = reference.error?.message || reference.error || previewWarnings.join(" ");
    $("referenceRetry").hidden = true;
    $("referenceRetry").disabled = busy;
    const summary = reference.summary || reference.analysis?.summary || "";
    $("referenceSummary").textContent = typeof summary === "string" ? summary : "";
    const pages = $("referencePages");
    pages.replaceChildren();
    (reference.pages || []).forEach((page, index) => {
      const label = document.createElement("label");
      label.className = `reference-page ${selected.has(page.id) ? "selected" : ""}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(page.id);
      input.disabled = busy || reference.status !== "ready" || !page.analysis;
      input.setAttribute("aria-label", `参考第 ${index + 1} 页`);
      input.addEventListener("change", () => {
        input.checked ? selected.add(page.id) : selected.delete(page.id);
        selectionDirty = true;
        label.classList.toggle("selected", input.checked);
        updateSelection();
        notify();
      });
      const image = document.createElement("img");
      image.src = imageUrl(page); image.alt = `参考第 ${index + 1} 页`; image.loading = "lazy";
      const text = document.createElement("span");
      text.textContent = `${index + 1} · ${roles[page.role] || "页面"}`;
      const roleSelect = document.createElement("select");
      roleSelect.setAttribute("aria-label", `第 ${index + 1} 页用途`);
      roleSelect.disabled = busy || reference.status !== "ready" || !page.analysis;
      Object.entries(roles).forEach(([value, name]) => { const option = document.createElement("option"); option.value = value; option.textContent = name; roleSelect.append(option); });
      roleSelect.value = roleOverrides[page.id] || page.role || "content";
      roleSelect.addEventListener("change", () => { roleOverrides[page.id] = roleSelect.value; selectionDirty = true; updateSelection(); notify(); });
      label.append(input, image, text, roleSelect);
      pages.append(label);
    });
    updateSelection();
  }

  function updateSelection() {
    $("referenceSelectionCount").textContent = reference?.status === "ready" ? `已选 ${selected.size} / ${reference?.pages?.length || 0} 页作为参考` : "默认自动挑选代表页，无需手动设置";
    $("referenceSave").disabled = busy || !["uploaded", "ready", "failed"].includes(reference?.status) || (reference?.status === "ready" && selected.size === 0) || !selectionDirty;
    $("referenceSave").textContent = selectionDirty ? "保存参考设置" : "参考设置已保存";
    $("referenceNote").disabled = busy || !["uploaded", "ready", "failed"].includes(reference?.status);
    $("referencePageNumbers").disabled = busy || !["uploaded", "failed"].includes(reference?.status);
    $("referencePageNumbersField").hidden = reference?.status === "ready";
  }

  async function receive(next, { attach = false } = {}) {
    const receivingEpoch = epoch;
    if (attach) await onAttach?.(next?.id || null);
    if (receivingEpoch !== epoch) return;
    reference = next;
    selected = new Set(next?.selectedPageIds || []);
    selectionDirty = false;
    roleOverrides = {};
    $("referenceNote").value = next?.note || "";
    $("referencePageNumbers").value = (next?.pageNumbers || []).join(", ");
    if (!currentProject()) remember(next?.id || "");
    render(); notify();
  }

  async function poll(id, run) {
    if (run !== epoch) return;
    try {
      const result = await api(`/api/v2/style-references/${encodeURIComponent(id)}`);
      if (run !== epoch) return;
      await receive(result.reference);
      if (!["uploaded", "ready", "failed"].includes(reference.status)) pollTimer = setTimeout(() => void poll(id, run), 1800);
    } catch (error) {
      if (run !== epoch) return;
      $("referenceError").textContent = `读取进度失败：${error.message}`;
      pollTimer = setTimeout(() => void poll(id, run), 4000);
    }
  }

  async function load(id) {
    const run = ++epoch; stopPoll(); busy = false; uploading = false;
    if (!id) { await receive(null); return; }
    try {
      const result = await api(`/api/v2/style-references/${encodeURIComponent(id)}`);
      if (run !== epoch) return;
      await receive(result.reference);
      if (!["uploaded", "ready", "failed"].includes(reference.status)) void poll(id, run);
    } catch (error) {
      if (run !== epoch) return;
      await receive(null); onNotice?.(`参考读取失败：${error.message}`, "warning");
    }
  }

  async function upload(files) {
    if (!files.length || busy) return;
    if (files.some((file) => !/\.(png|jpe?g|webp|pptx|pdf)$/i.test(file.name))) return onNotice?.("请选择 PNG、JPG、WebP 图片、PPTX 或 PDF 文件。", "warning");
    if (files.length > 1 && files.some((file) => /\.(pptx|pdf)$/i.test(file.name))) return onNotice?.("一次上传一份 PPTX 或 PDF，或多张同一风格的图片。", "warning");
    if (files.length > 30 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) return onNotice?.("一次最多上传 30 张图片，总大小不超过 64 MB。", "warning");
    if (files.some((file) => file.size > 40 * 1024 * 1024)) return onNotice?.("单个参考文件不能超过 40 MB。", "warning");
    const run = ++epoch; stopPoll(); busy = true; uploading = true; render(); notify();
    const project = currentProject();
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      const result = await api("/api/v2/style-references/upload", { method: "POST", body: form });
      const next = result.reference;
      if (run !== epoch || project !== currentProject()) return;
      await receive(next, { attach: true });
      if (next.status !== "uploaded") void poll(next.id, run);
    } catch (error) {
      if (run === epoch) onNotice?.(error.message, "error");
    } finally {
      if (run === epoch) { busy = false; uploading = false; render(); notify(); }
      fileInput.value = "";
    }
  }

  function chooseFiles() {
    if (busy) return;
    fileInput.value = "";
    fileInput.click();
  }
  $("referenceUpload").addEventListener("click", chooseFiles);
  fileInput.addEventListener("change", (event) => void upload([...event.target.files]));
  $("referencePageNumbers").addEventListener("input", () => { selectionDirty = true; updateSelection(); notify(); });
  $("referenceNote").addEventListener("input", () => { selectionDirty = true; updateSelection(); notify(); });
  $("referenceSave").addEventListener("click", async () => {
    if (!reference || (reference.status === "ready" && !selected.size) || busy) return;
    const run = epoch; busy = true; render(); notify();
    try {
      const ready = reference.status === "ready";
      const raw = $("referencePageNumbers").value.trim();
      const pageNumbers = raw ? raw.split(/[,，、\s]+/).map(Number) : [];
      if (pageNumbers.some((page) => !Number.isInteger(page) || page < 1 || page > 30)) throw new Error("参考页码请填写 1–30 的数字，用逗号分隔");
      const result = await api(`/api/v2/style-references/${encodeURIComponent(reference.id)}/${ready ? "selection" : "configuration"}`, {
        method: "POST", body: JSON.stringify(ready ? { selectedPageIds: [...selected], note: $("referenceNote").value, roles: roleOverrides } : { pageNumbers, note: $("referenceNote").value })
      });
      if (run === epoch) await receive(result.reference, { attach: true });
    } catch (error) { if (run === epoch) onNotice?.(error.message, "error"); }
    finally { if (run === epoch) { busy = false; render(); notify(); } }
  });
  $("referenceRetry").addEventListener("click", async () => {
    if (!reference || busy) return;
    const run = ++epoch; stopPoll(); busy = true; render();
    try {
      const result = await api(`/api/v2/style-references/${encodeURIComponent(reference.id)}/retry`, { method: "POST", body: "{}" });
      if (run === epoch) { await receive(result.reference); void poll(reference.id, run); }
    } catch (error) { if (run === epoch) onNotice?.(error.message, "error"); }
    finally { if (run === epoch) { busy = false; render(); notify(); } }
  });
  $("referenceRemove").addEventListener("click", async () => {
    if (busy) return;
    const run = ++epoch; stopPoll(); busy = true;
    try { await onAttach?.(null); if (run === epoch) await receive(null); }
    catch (error) { if (run === epoch) onNotice?.(error.message, "error"); }
    finally { if (run === epoch) { busy = false; render(); notify(); } }
  });
  render();
  return {
    load, chooseFiles, get: () => reference, isDirty: () => selectionDirty, isBusy: () => busy, isUploading: () => uploading,
    async restoreDraft() { let id = ""; try { id = localStorage.getItem(DRAFT_KEY) || ""; } catch {} if (id) await load(id); },
    clearDraft() { remember(""); },
    dispose() { epoch++; stopPoll(); }
  };
}
