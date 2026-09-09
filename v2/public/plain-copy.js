// The plain editor contains audience-visible copy only. Field ownership stays
// internal so ordinary wording edits can preserve the existing page structure.
export function plainCopySlots(copy = {}) {
  const slots = [];
  const add = (path, text, limit = 260) => {
    if (typeof text === "string" && text.trim()) slots.push({ path, text, limit });
  };
  add(["subtitle"], copy.subtitle, 180);
  add(["lead"], copy.lead);
  (copy.modules || []).forEach((m, i) => {
    add(["modules", i, "label"], m.label, 80);
    add(["modules", i, "headline"], m.headline, 160);
    add(["modules", i, "body"], m.body);
    (m.items || []).forEach((text, j) => add(["modules", i, "items", j], text, 180));
  });
  add(["example"], copy.example);
  (copy.evidence || []).forEach((text, i) => add(["evidence", i], text, 240));
  add(["boundary"], copy.boundary);
  (copy.bottomTakeaways || []).forEach((text, i) => add(["bottomTakeaways", i], text, 180));
  if (copy.schemaVersion === "1.0") {
    const known = new Set([copy.title, ...slots.map((slot) => slot.text)]);
    (copy.verbatimText || []).forEach((text, i) => {
      if (!known.has(text)) add(["verbatimText", i], text);
    });
  }
  return slots;
}

export function plainTextDraft(page = {}) {
  if (page.copyBlueprint) return {
    title: page.copyBlueprint.title || page.title || "",
    bodyText: plainCopySlots(page.copyBlueprint).map((slot) => slot.text).join("\n\n")
  };
  const content = (page.blocks || []).filter((b) => !["title", "headline", "标题", "主标题"].includes(b.role)).map((b) => b.text).filter(Boolean);
  return { title: page.title || "", bodyText: content.length ? content.join("\n\n") : [page.subtitle, page.displayText].filter(Boolean).join("\n\n") };
}
