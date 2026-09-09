const compact = (text) => String(text ?? "").normalize("NFKC").replace(/\s+/g, "");

export function parseSourceReference(reference) {
  const match = String(reference ?? "").trim().match(/^\[?(S\d{4,})(?:-(S\d{4,}))?\]?\s*[|｜:]\s*(.+)$/s);
  return match ? { blockId: match[1], endBlockId: match[2] || match[1], quote: match[3].trim() } : null;
}

export function sourceBlockIdsForReference(reference, document) {
  const parsed = parseSourceReference(reference);
  if (!parsed) return [];
  const blocks = document?.blocks || [];
  const start = blocks.findIndex((block) => block.id === parsed.blockId);
  const end = blocks.findIndex((block) => block.id === parsed.endBlockId);
  if (start < 0 || end < start || end - start > 1) return [];
  if (end > start && blocks[start].end !== blocks[end].start) return [];
  return blocks.slice(start, end + 1).map((block) => block.id);
}

// Correct only a mechanically split quotation crossing the immediately cited
// block boundary. Never search arbitrary source blocks or change quote text.
export function canonicalizeOutlineSourceReferences(outline, document) {
  const value = structuredClone(outline);
  const corrections = [];
  const blocks = document?.blocks || [];
  const fix = (references, scope) => (references || []).map((reference) => {
    const parsed = parseSourceReference(reference);
    if (!parsed || parsed.blockId !== parsed.endBlockId || compact(parsed.quote).length < 4) return reference;
    const index = blocks.findIndex((block) => block.id === parsed.blockId);
    if (index < 0 || compact(blocks[index].text).includes(compact(parsed.quote))) return reference;
    for (const start of [index - 1, index]) {
      const first = blocks[start], second = blocks[start + 1];
      if (!first || !second || first.end !== second.start) continue;
      const left = compact(first.text), quote = compact(parsed.quote);
      const position = (left + compact(second.text)).indexOf(quote);
      if (position >= 0 && position < left.length && position + quote.length > left.length) {
        const corrected = `${first.id}-${second.id} | ${parsed.quote}`;
        corrections.push({ scope, from: reference, to: corrected });
        return corrected;
      }
    }
    return reference;
  });
  for (const unit of value.argumentMap?.units || []) unit.sourceRefs = fix(unit.sourceRefs, `argument:${unit.id}`);
  for (const page of value.pages || []) {
    if (page.sourceRefs) page.sourceRefs = fix(page.sourceRefs, page.pageNo);
    if (page.copyBlueprint) {
      page.copyBlueprint.sourceRefs = fix(page.copyBlueprint.sourceRefs, page.pageNo);
      for (const [index, module] of (page.copyBlueprint.modules || []).entries()) module.sourceRefs = fix(module.sourceRefs, `${page.pageNo}:module:${index + 1}`);
    }
  }
  return { value, corrections };
}

export function validateSourceReferences(references, document, { label = "来源", required = true } = {}) {
  const issues = [];
  const matches = [];
  const blocks = new Map((document?.blocks || []).map((block) => [block.id, block]));
  if (!Array.isArray(references) || (required && !references.length)) issues.push(`${label} 缺少可核验的原文引用`);
  for (const reference of Array.isArray(references) ? references : []) {
    const parsed = parseSourceReference(reference);
    if (!parsed) { issues.push(`${label} 引用必须为“源块ID | 原文逐字摘录”`); continue; }
    const ids = sourceBlockIdsForReference(reference, document);
    if (!ids.length) { issues.push(`${label} 引用了不存在、不连续或过宽的源块 ${parsed.blockId}-${parsed.endBlockId}`); continue; }
    const selected = ids.map((id) => blocks.get(id));
    if (compact(parsed.quote).length < 4) { issues.push(`${label} ${parsed.blockId} 摘录过短，无法支撑引用`); continue; }
    if (!compact(selected.map((block) => block.text).join("")).includes(compact(parsed.quote))) {
      issues.push(`${label} ${parsed.blockId} 摘录不在该原文块中`); continue;
    }
    matches.push({ ...parsed, blockIds: ids, start: selected[0].start, end: selected.at(-1).end });
  }
  return { valid: issues.length === 0, issues, matches };
}

function numericTokens(text) {
  return [...new Set((String(text ?? "").normalize("NFKC").match(/(?<![A-Za-z\d])[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|亿元|万元|万亿|亿|万|倍|元|人|家|个|天|年)?/gu) || [])
    .map((value) => value.replace(/[\s,]/g, "")))];
}

export function validateOutlineSourceGrounding(outline, document = outline?.sourceDocument) {
  if (!document) return { valid: true, status: "legacy-unverified", issues: [],
    warnings: ["旧项目来源尚未做源块核验；非空引用不代表事实已核实"], checks: [] };
  const issues = [];
  const warnings = [];
  const checks = [];
  if (document.schemaVersion !== "1.0" || !/^[a-f0-9]{64}$/.test(document.sourceHash || "") || !Array.isArray(document.blocks) || !document.blocks.length) {
    return { valid: false, status: "invalid-registry", issues: ["源文档登记表缺失或版本无效"], warnings, checks };
  }
  const ids = document.blocks.map((block) => block.id);
  if (new Set(ids).size !== ids.length) issues.push("源文档包含重复源块 ID");
  for (const unit of outline.argumentMap?.units || []) {
    const result = validateSourceReferences(unit.sourceRefs, document, { label: `论证 ${unit.id}`, required: !["transition", "conclusion"].includes(unit.type) });
    issues.push(...result.issues); checks.push({ scope: `argument:${unit.id}`, ...result });
  }
  for (const page of outline.pages || []) {
    const copy = page.copyBlueprint || {};
    const result = validateSourceReferences(copy.sourceRefs || page.sourceRefs, document, {
      label: page.pageNo, required: !["cover", "agenda"].includes(page.pageRole)
    });
    issues.push(...result.issues); checks.push({ scope: page.pageNo, ...result });
    const quotes = result.matches.map((match) => match.quote);
    for (const [index, module] of (copy.modules || []).entries()) {
      const moduleResult = validateSourceReferences(module.sourceRefs || [], document, { label: `${page.pageNo} 模块${index + 1}`, required: false });
      issues.push(...moduleResult.issues); quotes.push(...moduleResult.matches.map((match) => match.quote));
      checks.push({ scope: `${page.pageNo}:module:${index + 1}`, ...moduleResult });
    }
    const supported = new Set(numericTokens(quotes.join("\n")));
    const visible = copy.verbatimText || page.verbatimText || [page.title, ...(page.displayText || [])];
    const unsupported = numericTokens(visible.join("\n")).filter((token) => !supported.has(token));
    if (unsupported.length) warnings.push(`${page.pageNo} 数字或单位未在本页逐字引文中直接匹配：${unsupported.join("、")}；请核对换算、推导和统计口径`);
  }
  return { valid: issues.length === 0, status: issues.length ? "failed" : "references-verified", issues: [...new Set(issues)], warnings,
    checks, limitation: "仅核验原文出处、摘录和数字字面支持；不等同于事实真实性、因果推断或数字口径已获确认" };
}
