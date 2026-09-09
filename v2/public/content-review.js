const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function contentSummary(page = {}) {
  const copy = page.copyBlueprint;
  const text = copy?.oneSentenceAnswer || page.mainPoint || copy?.lead || page.subtitle || page.displayText || "点击查看并修改本页内容";
  return String(text).split(/\n/)[0];
}

export function contentPreview(page = {}, fallback = "") {
  const copy = page.copyBlueprint;
  if (!copy) return `<div class="content-reading"><h3>${escape(page.title)}</h3>${page.subtitle ? `<p>${escape(page.subtitle)}</p>` : ""}<p class="content-preserve-lines">${escape(fallback)}</p></div>`;
  const paragraph = (text, cls = "") => text ? `<p class="${cls}">${escape(text)}</p>` : "";
  const items = (values) => values?.length ? `<ul>${values.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>` : "";
  const visible = [copy.title, copy.subtitle, copy.lead, ...(copy.modules || []).flatMap((m) => [m.label, m.headline, m.body, ...(m.items || [])]), copy.example, ...(copy.evidence || []), copy.boundary, ...(copy.bottomTakeaways || [])];
  const legacy = copy.schemaVersion === "1.0" ? (copy.verbatimText || []).filter((text) => !visible.includes(text)) : [];
  const sources = [...new Set([...(copy.sourceRefs || []), ...(copy.modules || []).flatMap((m) => m.sourceRefs || [])])];
  return `<div class="content-reading"><h3>${escape(copy.title)}</h3>${paragraph(copy.subtitle, "content-subtitle")}${paragraph(copy.lead)}
    ${(copy.modules || []).map((module) => `<section>${module.label ? `<h4>${escape(module.label)}</h4>` : ""}${paragraph(module.headline, "content-headline")}${paragraph(module.body)}${items(module.items)}</section>`).join("")}
    ${paragraph(copy.example)}${items(copy.evidence)}${paragraph(copy.boundary)}${items(copy.bottomTakeaways)}
    ${items(legacy)}${sources.length ? `<details class="content-sources"><summary>查看来源</summary>${items(sources)}</details>` : ""}</div>`;
}
