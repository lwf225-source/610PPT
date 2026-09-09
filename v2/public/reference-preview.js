function fileType(file = {}) {
  const extension = String(file.name || file.fileName || "").split(".").pop().toLowerCase();
  const type = String(file.type || "").toLowerCase();
  if (type === "pdf" || extension === "pdf") return "PDF";
  if (["ppt", "pptx"].includes(type) || ["ppt", "pptx"].includes(extension)) return "PPT";
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) return extension === "jpeg" ? "JPG" : extension.toUpperCase();
  return type === "image" || type.startsWith("image/") ? "图片" : "文件";
}

export function referencePreviewUrl(url, moduleUrl = import.meta.url) {
  const value = String(url || "");
  if (!/^\/api\//.test(value)) return value;
  const base = new URL(".", moduleUrl);
  // API responses are origin-relative; cloud deployments can mount the whole
  // workbench beneath /ppt/. Resolve that prefix before desktop bridge routing.
  if (!["http:", "https:"].includes(base.protocol) || base.pathname === "/") return value;
  return `${base.pathname.replace(/\/$/, "")}${value}`;
}

// Parsed pages also give PDF/PPT uploads a real preview once preparation finishes.
export function referencePreviewItems(reference, limit = 3) {
  const files = reference?.files || [];
  const pages = reference?.pages || [];
  const selected = new Set(reference?.selectedPageIds || []);
  const orderedPages = [...pages.filter((page) => selected.has(page.id)), ...pages.filter((page) => !selected.has(page.id))];
  const previews = orderedPages.filter((page) => page.thumbnailUrl || page.previewUrl).map((page) => {
    const file = files.find((entry) => entry.id === page.fileId) || files[0] || {};
    return { url: page.thumbnailUrl || page.previewUrl, label: fileType(file), name: `${file.name || reference.name || "参考文件"} · 第 ${page.pageNo || pages.indexOf(page) + 1} 页` };
  });
  if (previews.length) return previews.slice(0, limit);
  return (files.length ? files : [{}]).slice(0, limit).map((file) => ({
    url: file.thumbnailUrl || file.previewUrl || "",
    label: fileType(file), name: file.name || file.fileName || reference?.name || "参考文件"
  }));
}

export function renderReferencePreview(target, reference, resourceUrl = (url) => url) {
  for (const item of referencePreviewItems(reference)) {
    const frame = document.createElement("span");
    frame.className = "reference-preview-item";
    frame.title = item.name;
    const icon = document.createElement("span");
    icon.className = "reference-file-icon";
    icon.textContent = item.label;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", `${item.name}（${item.label}）`);
    frame.append(icon);
    if (item.url) {
      const image = document.createElement("img");
      image.alt = item.name;
      image.hidden = true;
      image.addEventListener("load", () => { icon.hidden = true; image.hidden = false; });
      image.addEventListener("error", () => { image.remove(); icon.hidden = false; });
      image.src = resourceUrl(referencePreviewUrl(item.url));
      frame.append(image);
    }
    target.append(frame);
  }
}
