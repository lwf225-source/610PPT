const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();

export function slideText(text = "", maxLength = 110) {
  const value = clean(text);
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

export function semanticTextKey(text = "") {
  return clean(text).toLowerCase().replace(/[\s。；;，,、：:！？!?（）()【】\[\]“”‘’'"·—\-]/g, "");
}

function bigrams(text = "") {
  const value = semanticTextKey(text);
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

export function isNearDuplicateText(left = "", right = "", threshold = 0.68) {
  const a = semanticTextKey(left), b = semanticTextKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length >= 0.62) return true;
  const leftGrams = bigrams(a), rightGrams = bigrams(b);
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  const union = new Set([...leftGrams, ...rightGrams]).size;
  return union ? intersection / union >= threshold : false;
}

export function metricRowFromText(text = "", index = 0) {
  const value = clean(text).replace(/^\d{1,2}[.、)]\s*/, "");
  const parts = value.split(/[｜|]/).map(clean).filter(Boolean);
  const source = parts.length >= 2 ? parts[1] : value;
  const match = source.match(/(?:RMB|人民币)?\s*(?:约|大约|近)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(B|M|亿元|亿|万元|万|元|%|个百分点)?/i);
  if (!match) return null;
  const label = parts.length >= 2 ? parts[0] : clean(value.slice(0, match.index).replace(/[：:，,\s]+$/, ""));
  if (!label || label.length > 28 || /做一份|页\s*PPT|第\s*\d+\s*页/.test(value)) return null;
  const unit = /亿元/.test(match[2] || "") ? "亿" : /万元/.test(match[2] || "") ? "万" : String(match[2] || "").toUpperCase();
  const growth = value.match(/同比(?:增长|上升|提升)?\s*([+-]?\d+(?:\.\d+)?)\s*%/i);
  const growthValue = growth ? Number(growth[1]) : null;
  return { label: label || `指标 ${index + 1}`, value: Number(match[1].replace(/,/g, "")), displayValue: `${match[1]}${unit}`,
    note: growth ? `同比 ${growthValue > 0 ? "+" : ""}${growthValue}%` : clean(parts.slice(2).join(" ") || value.slice((match.index || 0) + match[0].length)).slice(0, 28), growthValue };
}

export function metricRowIdentity(row = {}) {
  const label = semanticTextKey(row.label || "").replace(/^(?:关键指标|核心指标|指标)/, "").replace(/(?:规模|数据)$/, "");
  return `${label}|${semanticTextKey(String(row.displayValue ?? row.value ?? ""))}`;
}

export function uniqueMetricRows(rows = [], limit = 6) {
  const seen = new Set();
  return rows.filter((row) => { const key = metricRowIdentity(row); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, limit);
}
