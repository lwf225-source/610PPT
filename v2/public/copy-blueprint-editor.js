const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function blueprintVisibleText(copy) {
  return [copy.title, copy.subtitle, copy.lead, ...(copy.modules || []).flatMap((module) => [module.label, module.headline, module.body, ...(module.items || [])]), copy.example, ...(copy.evidence || []), copy.boundary, ...(copy.bottomTakeaways || [])].filter((text) => typeof text === "string" && text.trim());
}

export function editedBlueprintLock(copy, original) {
  const visible = blueprintVisibleText(copy);
  const oldVisible = new Set(blueprintVisibleText(original));
  const legacyExtra = original.schemaVersion === "1.0" ? (original.verbatimText || []).filter((text) => !oldVisible.has(text)) : [];
  return [...visible, ...legacyExtra];
}

export function sourceReferencePreview(reference, sourceDocument) {
  const match = String(reference ?? "").trim().match(/^\[?(S\d{4,})(?:-(S\d{4,}))?\]?\s*[|｜:]\s*(.+)$/s);
  if (!match) return { blocks: [], quote: "", error: "引用格式需为 S0001 | 原文摘录；相邻跨块可用 S0001-S0002。" };
  const registry = Array.isArray(sourceDocument?.blocks) ? sourceDocument.blocks : [];
  const start = registry.findIndex((block) => block.id === match[1]);
  const end = registry.findIndex((block) => block.id === (match[2] || match[1]));
  if (start < 0 || end < start || end - start > 1 || (end > start && registry[start].end !== registry[end].start)) {
    return { blocks: [], quote: match[3].trim(), error: "未找到该源块，或引用范围不是相邻连续的两块。" };
  }
  const blocks = registry.slice(start, end + 1).map((block) => ({ id: String(block.id), text: String(block.text ?? "") }));
  const quote = match[3].trim();
  const compact = (text) => text.normalize("NFKC").replace(/\s+/g, "");
  const quoteLocated = compact(quote).length >= 4 && compact(blocks.map((block) => block.text).join("")).includes(compact(quote));
  return { blocks, quote, quoteLocated, citation: `${match[1]}${match[2] ? `-${match[2]}` : ""} | ${quote}`, error: quoteLocated ? "" : "当前摘录未在这些源块中定位，请对照原文修改引用。" };
}

export function sourceReviewForPage({ copy, sourceGrounding, sourceDocument, pageNo = "", edited = false }) {
  const registered = sourceDocument?.schemaVersion === "1.0" && /^[a-f0-9]{64}$/.test(sourceDocument?.sourceHash || "") && Array.isArray(sourceDocument?.blocks) && sourceDocument.blocks.length > 0 && new Set(sourceDocument.blocks.map((block) => block.id)).size === sourceDocument.blocks.length;
  const isThisPage = (message) => String(message).startsWith(pageNo) && !/^\d/.test(String(message).slice(pageNo.length));
  const issues = (sourceGrounding?.issues || []).filter((message) => pageNo && isThisPage(message));
  const warnings = (sourceGrounding?.warnings || []).filter((message) => pageNo && isThisPage(message));
  const checks = (sourceGrounding?.checks || []).filter((check) => check.scope === pageNo || check.scope?.startsWith(`${pageNo}:`));
  const references = [];
  const add = (values, scope) => (Array.isArray(values) ? values : []).forEach((reference) => references.push({ reference: String(reference), scope, preview: sourceReferencePreview(reference, sourceDocument) }));
  add(copy?.sourceRefs, "页面来源");
  (copy?.modules || []).forEach((module, index) => add(module.sourceRefs, `模块 ${index + 1} 来源`));
  let status;
  if (!registered) status = sourceDocument ? "原文登记表无效，无法核验" : "未核验：旧项目未登记原文源块";
  else if (edited || sourceGrounding?.status === "editor-draft") status = "文案已修改，保存后重新核验";
  else if (issues.length || checks.some((check) => !check.valid)) status = "本页引用核验未通过";
  else if ((sourceGrounding?.status === "references-verified" && sourceGrounding.valid !== false) || (checks.length && checks.every((check) => check.valid))) status = "本页引用出处已匹配（上次保存结果）";
  else status = "未核验：尚无本页已保存的核验结果";
  return { registered, status, issues, warnings, references, limitation: sourceGrounding?.limitation || "仅核验原文出处与摘录匹配，不等同于事实真值、因果推断或数字统计口径已经确认。" };
}

export function mountCopyBlueprintEditor(host, blueprint, { onDirty = () => {}, sourceGrounding = null, sourceDocument = null, pageNo = "", compact = false } = {}) {
  const original = structuredClone(blueprint);
  let draft = structuredClone(blueprint);
  const originalLegacyText = original.schemaVersion === "1.0" ? (original.verbatimText || []).filter((text) => !blueprintVisibleText(original).includes(text)) : [];
  const legacyText = [...originalLegacyText];
  const isEdited = () => JSON.stringify(draft) !== JSON.stringify(original) || JSON.stringify(legacyText) !== JSON.stringify(originalLegacyText);
  const get = (path) => path.reduce((value, key) => value?.[key], draft);
  const set = (path, value) => { const owner = path.slice(0, -1).reduce((item, key) => item[key], draft); owner[path.at(-1)] = value; };
  const pathAttr = (path) => escape(JSON.stringify(path));
  const field = (label, path, { multiline = false, id = "" } = {}) => `<label><span>${escape(label)}</span>${multiline ? `<textarea aria-label="${escape(label)}" rows="2" data-copy-path="${pathAttr(path)}">${escape(get(path))}</textarea>` : `<input aria-label="${escape(label)}" ${id ? `id="${id}"` : ""} data-copy-path="${pathAttr(path)}" value="${escape(get(path))}" />`}</label>`;
  const list = (label, path) => `<section class="copy-list"><div class="copy-section-heading"><span>${escape(label)}</span><button class="button ghost small" type="button" data-copy-add-list="${pathAttr(path)}">添加${escape(label)}</button></div>${(get(path) || []).map((text, index) => `<div class="copy-list-row"><input aria-label="${escape(label)} ${index + 1}" data-copy-path="${pathAttr([...path, index])}" value="${escape(text)}" /><button type="button" class="button ghost small" aria-label="删除${escape(label)} ${index + 1}" data-copy-remove-list="${pathAttr(path)}" data-index="${index}">删除</button></div>`).join("")}</section>`;
  const populated = (path) => { const value = get(path); return Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim()); };
  const optionalFields = (entries, label) => {
    const present = entries.filter((entry) => populated(entry.path));
    const empty = entries.filter((entry) => !populated(entry.path));
    const renderEntry = (entry) => entry.list ? list(entry.label, entry.path) : field(entry.label, entry.path, entry.options);
    return present.map(renderEntry).join("") + (empty.length ? `<details class="copy-internal-fields copy-optional-fields"><summary>${escape(label)}</summary>${empty.map(renderEntry).join("")}</details>` : "");
  };
  function compactContent() {
    const extras = [
      { label: "案例", path: ["example"], options: { multiline: true } },
      { label: "证据", path: ["evidence"], list: true },
      { label: "适用范围与限制", path: ["boundary"], options: { multiline: true } },
      { label: "结论", path: ["bottomTakeaways"], list: true }
    ];
    return `<div class="structured-copy-editor compact-copy-editor">
      ${field("标题", ["title"], { id: "pageTitleInput" })}
      ${optionalFields([
        { label: "副标题", path: ["subtitle"], options: { id: "pageSubtitleInput" } },
        { label: "开场说明", path: ["lead"], options: { multiline: true } }
      ], "添加副标题或开场说明")}
      <div class="copy-section-heading"><h4>内容</h4><button type="button" class="button ghost small" data-copy-add-module>添加内容段</button></div>
      <div class="copy-modules">${(draft.modules || []).map((module, index) => `<section class="copy-module" data-module-index="${index}">
        <div class="copy-section-heading"><h4>第 ${index + 1} 段</h4><button type="button" class="button ghost small" data-copy-remove-module="${index}" aria-label="删除第 ${index + 1} 段">删除</button></div>
        ${field("重点", ["modules", index, "headline"])}
        ${optionalFields([
          { label: "模块名", path: ["modules", index, "label"] },
          { label: "说明", path: ["modules", index, "body"], options: { multiline: true } },
          { label: "条目", path: ["modules", index, "items"], list: true }
        ], "添加模块名、说明或条目")}
      </section>`).join("")}</div>
      <details class="copy-internal-fields copy-supplemental-content" ${extras.some((entry) => populated(entry.path)) ? "open" : ""}><summary>补充内容（案例、证据、限制与结论）</summary>
        ${optionalFields(extras, "添加其他补充内容")}
      </details>
      <details class="copy-internal-fields"><summary>来源引用</summary>${list("页面来源", ["sourceRefs"])}${(draft.modules || []).map((module, index) => list(`第 ${index + 1} 段来源`, ["modules", index, "sourceRefs"])).join("")}</details>
      <div data-source-review></div>
      <details class="copy-internal-fields"><summary>写作依据（不会显示在页面上）</summary>${field("读者关心的问题", ["audienceQuestion"], { multiline: true })}${field("核心回答", ["oneSentenceAnswer"], { multiline: true })}${field("组织思路", ["pageLogic"])}${field("与下一页的衔接", ["bridgeToNext"], { multiline: true })}</details>
      ${legacyText.length ? `<details class="copy-internal-fields" open><summary>旧版保留文字</summary><p class="copy-editor-hint">以下旧版文字仍会保留在页面中，清空可移除对应文字。</p>${legacyText.map((text, index) => `<label><span>保留文字 ${index + 1}</span><textarea aria-label="保留文字 ${index + 1}" rows="2" data-copy-legacy="${index}">${escape(text)}</textarea></label>`).join("")}</details>` : ""}
    </div>`;
  }
  function render() {
    host.innerHTML = compact ? compactContent() : `<div class="structured-copy-editor">
      <p class="copy-editor-hint">按语义结构编辑。模块、条目、证据与来源分别保存；内部判断和转场不会作为正文上屏。</p>
      <div data-source-review></div>
      ${field("主标题", ["title"], { id: "pageTitleInput" })}${field("副标题", ["subtitle"], { id: "pageSubtitleInput" })}
      ${field("页首判断（上屏，可留空）", ["lead"], { multiline: true })}
      <div class="copy-section-heading"><h4>内容模块</h4><button type="button" class="button ghost small" data-copy-add-module>添加模块</button></div>
      <div class="copy-modules">${(draft.modules || []).map((module, index) => `<section class="copy-module" data-module-index="${index}"><div class="copy-section-heading"><h4>模块 ${index + 1}</h4><button type="button" class="button ghost small" data-copy-remove-module="${index}" aria-label="删除模块 ${index + 1}">删除模块</button></div>
        <div class="copy-field-pair">${field("模块角色", ["modules", index, "role"])}${field("栏目名称", ["modules", index, "label"])}</div>
        ${field("模块判断", ["modules", index, "headline"])}${field("解释正文", ["modules", index, "body"], { multiline: true })}
        ${list("条目", ["modules", index, "items"])}${list("模块来源", ["modules", index, "sourceRefs"])}</section>`).join("")}</div>
      ${field("案例", ["example"], { multiline: true })}${list("证据", ["evidence"])}${field("适用边界", ["boundary"], { multiline: true })}${list("底部结论", ["bottomTakeaways"])}${list("页面来源", ["sourceRefs"])}
      <details class="copy-internal-fields"><summary>内部编辑依据（不上屏）</summary>${field("受众问题", ["audienceQuestion"], { multiline: true })}${field("一句话答案", ["oneSentenceAnswer"], { multiline: true })}${field("页面逻辑", ["pageLogic"])}${field("衔接下一页", ["bridgeToNext"], { multiline: true })}</details>
      ${original.schemaVersion === "1.0" && (original.verbatimText || []).some((text) => !blueprintVisibleText(original).includes(text)) ? `<p class="copy-editor-hint">旧版附加锁定文字仍保留，结构编辑不会自动删除。</p>` : ""}
      <p class="copy-capacity" role="status"></p>
    </div>`;
    refreshCapacity();
    refreshSourceReview();
  }
  function refreshCapacity() {
    if (compact) return;
    const count = blueprintVisibleText(draft).length;
    host.querySelector(".copy-capacity").textContent = `当前上屏文字 ${count} 项 / 建议最多 24 项。来源引用不计入上屏文字。`;
  }
  function refreshSourceReview() {
    const target = host.querySelector("[data-source-review]");
    const wasOpen = Boolean(target.querySelector("details")?.open);
    const review = sourceReviewForPage({ copy: draft, sourceGrounding, sourceDocument, pageNo, edited: isEdited() });
    target.innerHTML = `<details class="copy-internal-fields" data-source-review-details ${wasOpen ? "open" : ""}>
      <summary>原文引用核验 · ${escape(review.status)}</summary>
      <p class="copy-editor-hint" data-source-limitation>${escape(review.limitation)}</p>
      ${!review.registered ? '<p class="copy-editor-hint">现有来源文字仍保留；没有原文登记表不代表引用已核验。此区不会自动补建或修改登记表。</p>' : '<p class="copy-editor-hint">引用格式：S0001 | 原文逐字摘录；相邻跨块使用 S0001-S0002 | 原文逐字摘录。原文登记表为只读。</p>'}
      ${review.issues.length ? `<div role="note"><strong>本页待修正引用</strong><ul>${review.issues.map((message) => `<li>${escape(message)}</li>`).join("")}</ul></div>` : ""}
      ${review.warnings.length ? `<div role="note" data-source-warnings><strong>上次保存时本页数字与口径提醒</strong><ul>${review.warnings.map((message) => `<li>${escape(message)}</li>`).join("")}</ul></div>` : ""}
      <div class="copy-list">${review.references.map((item, index) => `<details data-source-reference="${index}" style="overflow-wrap:anywhere"><summary>${escape(item.scope)} · ${escape(item.reference)}</summary>
        ${item.preview.error ? `<p class="copy-editor-hint">${escape(item.preview.error)}</p>` : ""}
        ${item.preview.blocks.map((block) => `<section><strong>${escape(block.id)} · 原文（只读）</strong><pre data-source-block="${escape(block.id)}" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto">${escape(block.text)}</pre></section>`).join("")}
        <button type="button" class="button ghost small" data-source-copy="${index}" ${item.preview.quoteLocated ? "" : "disabled"}>复制源块ID与摘录</button>
      </details>`).join("") || '<p class="copy-editor-hint">本页暂无来源引用。</p>'}</div>
      <p class="copy-editor-hint" role="status" data-source-copy-status></p>
    </details>`;
  }
  const dirty = () => { onDirty(isEdited()); refreshCapacity(); refreshSourceReview(); };
  host.addEventListener("input", (event) => {
    if (compact && event.target.dataset.copyLegacy !== undefined) {
      legacyText[Number(event.target.dataset.copyLegacy)] = event.target.value;
      dirty();
      return;
    }
    if (!event.target.dataset.copyPath) return;
    set(JSON.parse(event.target.dataset.copyPath), event.target.value);
    dirty();
  });
  host.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-source-copy")) {
      const review = sourceReviewForPage({ copy: draft, sourceGrounding, sourceDocument, pageNo });
      const preview = review.references[Number(button.dataset.sourceCopy)]?.preview;
      if (!preview?.quoteLocated || button.disabled) return;
      const status = host.querySelector("[data-source-copy-status]");
      void (async () => {
        try {
          await host.ownerDocument.defaultView.navigator.clipboard.writeText(preview.citation);
          status.textContent = "源块 ID 与原文摘录已复制。";
        } catch {
          const fallback = host.ownerDocument.createElement("textarea");
          fallback.readOnly = true;
          fallback.setAttribute("aria-label", "待复制的源块 ID 与摘录");
          fallback.value = preview.citation;
          status.textContent = "浏览器未开放剪贴板，请复制以下只读引用：";
          status.append(fallback);
          fallback.select();
        }
      })();
      return;
    }
    let changed = true;
    if (button.hasAttribute("data-copy-add-module")) (draft.modules ||= []).push({ role: "point", label: "", headline: "", body: "", items: [], sourceRefs: [] });
    else if (button.hasAttribute("data-copy-remove-module")) draft.modules.splice(Number(button.dataset.copyRemoveModule), 1);
    else if (button.dataset.copyAddList) { const path = JSON.parse(button.dataset.copyAddList); set(path, [...(get(path) || []), ""]); }
    else if (button.dataset.copyRemoveList) get(JSON.parse(button.dataset.copyRemoveList)).splice(Number(button.dataset.index), 1);
    else changed = false;
    if (changed) { render(); dirty(); }
  });
  render();
  return {
    isDirty: isEdited,
    read: () => {
      if (!isEdited()) return structuredClone(original);
      const copy = structuredClone(draft);
      copy.status = "edited";
      copy.verbatimText = JSON.stringify(legacyText) === JSON.stringify(originalLegacyText) ? editedBlueprintLock(copy, original) : [...blueprintVisibleText(copy), ...legacyText.filter((text) => text.trim())];
      return copy;
    }
  };
}
