import crypto from "node:crypto";

// Offsets address the original extracted text; no head/tail truncation is used.
export function buildSourceDocument(input = "", { maxBlockCharacters = 1800 } = {}) {
  const text = String(input);
  const limit = Math.max(200, Math.min(8000, Number(maxBlockCharacters) || 1800));
  const blocks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + limit / 3) end = boundary + 1;
      // Never split a Unicode surrogate pair.
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const body = text.slice(start, end);
    blocks.push({ id: `S${String(blocks.length + 1).padStart(4, "0")}`, start, end, text: body });
    start = end;
  }
  return { schemaVersion: "1.0", sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
    characterCount: text.length, blocks };
}

export function formatSourceDocumentForPrompt(document) {
  return (document?.blocks || []).map((block) => `[${block.id}]\n${block.text}`).join("\n\n");
}

export function partitionSourceDocument(document, { maxCharacters = 24000 } = {}) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const block of document.blocks) {
    if (current.length && size + block.text.length > maxCharacters) {
      groups.push({ ...document, blocks: current }); current = []; size = 0;
    }
    current.push(block); size += block.text.length;
  }
  if (current.length) groups.push({ ...document, blocks: current });
  return groups;
}
