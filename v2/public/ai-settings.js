const $ = (id) => document.getElementById(id);
const dialog = $("aiSettingsDialog");
const form = $("aiSettingsForm");
let loaded = false;
let busy = false;
let loadState;
let saved;
let catalogs = {};
let selection = {};
const groups = {
  openai: { ids: ["aiApiModel", "aiImageModel"], search: "aiApiModelSearch", button: "fetchApiModels", status: "aiApiModelsStatus" },
  "local-codex": { ids: ["aiCodexModel"], search: "aiCodexModelSearch", button: "fetchCodexModels", status: "aiCodexModelsStatus" }
};
const effortLabels = { none: "无", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大", ultra: "极高" };

function status(message, mode = "") {
  $("aiSettingsStatus").textContent = message;
  $("aiSettingsStatus").dataset.mode = mode;
}
function checks(items = []) {
  const list = $("aiSettingsChecks");
  list.replaceChildren();
  list.hidden = !items.length;
  for (const item of items) {
    const entry = document.createElement("li");
    const label = document.createElement("strong");
    const detail = document.createElement("span");
    label.textContent = item.label;
    detail.textContent = `${{ passed: "已通过", failed: "未通过", unverified: "未验证" }[item.status] || "未验证"}${item.message ? ` · ${item.message}` : ""}`;
    entry.dataset.mode = item.status;
    entry.append(label, detail);
    list.append(entry);
  }
}
function setBusy(value, operation = "") {
  busy = value;
  form.dataset.operation = value ? operation : "";
  $("aiSettingsFields").disabled = value || !loaded;
  if ($("aiRuntimeFields")) $("aiRuntimeFields").disabled = value && operation !== "load";
  $("saveAiSettings").disabled = value || !loaded;
  $("testAiSettings").disabled = value || !loaded;
  $("closeAiSettings").disabled = value && operation !== "load";
  form.setAttribute("aria-busy", String(value));
}
function provider() { return form.elements.aiProvider.value; }
function hasApiKey() {
  return Boolean($("aiApiKey").value.trim() || (saved?.openai.hasApiKey && !$("aiClearKey").checked));
}
function updateProvider() {
  const api = provider() === "openai";
  const showApiModels = api && hasApiKey();
  $("aiOpenaiPanel").hidden = !api;
  $("aiApiModels").hidden = !showApiModels;
  $("aiCodexPanel").hidden = api;
  $("aiBaseUrl").required = api;
  $("aiApiModel").required = showApiModels;
  $("aiImageModel").required = showApiModels;
  $("aiCodexModel").required = !api;
  // An invalid choice in the inactive provider must not block saving this one.
  for (const [kind, group] of Object.entries(groups)) {
    for (const id of group.ids) $(id).disabled = kind !== provider() || !catalogs[kind]?.data || (kind === "openai" && !showApiModels);
  }
  $("aiCodexReasoning").disabled = api || !catalogs["local-codex"]?.data;
}
function modelRows(kind, id) {
  const data = catalogs[kind]?.data;
  return (kind === "local-codex" ? data?.models : id === "aiApiModel" ? data?.text : data?.image) || [];
}
function renderModels(kind) {
  const group = groups[kind];
  const query = $(group.search).value.trim().toLowerCase();
  for (const id of group.ids) {
    const select = $(id), current = selection[id] || "", rows = modelRows(kind, id);
    select.replaceChildren(new Option(rows.length ? "请选择模型" : "暂无可选模型", ""));
    if (current && !catalogs[kind]?.data) {
      const option = new Option(`${current}（当前配置 · 待拉取）`, current);
      option.disabled = true;
      select.add(option);
    }
    for (const row of rows) {
      const matches = row.id.toLowerCase().includes(query);
      if (matches || row.id === current) select.add(new Option(`${row.id}${!matches ? "（已选）" : ""}`, row.id));
    }
    select.value = current;
  }
  updateProvider();
}
function renderReasoning(changedModel = false) {
  const select = $("aiCodexReasoning");
  const model = modelRows("local-codex", "aiCodexModel").find(row => row.id === selection.aiCodexModel);
  let current = select.value || saved?.codex.reasoningEffort || "medium";
  const choices = model?.reasoningEfforts || [];
  if (changedModel && !choices.includes(current)) current = model?.defaultReasoningEffort || choices[0] || "";
  select.replaceChildren();
  for (const value of choices) select.add(new Option(effortLabels[value] || value, value));
  if (current && !choices.includes(current)) {
    const option = new Option(`${effortLabels[current] || current}（${model ? "不支持" : "待拉取"}）`, current);
    option.disabled = true;
    select.add(option);
  }
  select.value = current;
  select.setCustomValidity(model && !choices.includes(current) ? "请选择该模型支持的推理强度" : "");
}
function invalidate(kind) {
  catalogs[kind]?.controller?.abort();
  catalogs[kind] = {};
  $(groups[kind].button).disabled = false;
  $(groups[kind].status).textContent = kind === "openai" ? "填写 API 地址和 Key 后拉取模型。" : "从本地 Codex 读取可用模型。";
  renderModels(kind);
  if (kind === "local-codex") renderReasoning();
}
function populate(settings, reset = false) {
  saved = settings;
  form.elements.aiProvider.value = settings.provider;
  $("aiBaseUrl").value = settings.openai.baseUrl;
  selection = { aiApiModel: settings.openai.model, aiImageModel: settings.openai.imageModel, aiCodexModel: settings.codex.model };
  $("aiApiKey").value = "";
  $("aiClearKey").checked = false;
  $("aiClearKey").parentElement.hidden = !settings.openai.hasApiKey;
  $("aiKeyHint").textContent = settings.openai.hasApiKey ? "已保存密钥。留空保留，填写新密钥可替换。" : "密钥只保存在本机服务端，不会回显。";
  $("aiApiKey").placeholder = settings.openai.hasApiKey ? "已配置 · 留空保留" : "输入 API Key";
  $("aiCodexBinary").value = settings.codex.binary || "";
  $("aiCodexReasoning").replaceChildren(new Option(settings.codex.reasoningEffort, settings.codex.reasoningEffort));
  for (const kind of Object.keys(groups)) {
    if (reset) { $(groups[kind].search).value = ""; invalidate(kind); }
    else renderModels(kind);
  }
  renderReasoning();
  updateProvider();
}
function connection(kind = provider()) {
  return kind === "openai"
    ? { provider: kind, openai: { baseUrl: $("aiBaseUrl").value.trim(), apiKey: $("aiApiKey").value.trim(), clearApiKey: $("aiClearKey").checked } }
    : { provider: kind, codex: { binary: $("aiCodexBinary").value.trim() } };
}
function candidate() {
  return { provider: provider(),
    openai: { ...connection("openai").openai, model: selection.aiApiModel || saved.openai.model, imageModel: selection.aiImageModel || saved.openai.imageModel },
    codex: { ...connection("local-codex").codex, model: selection.aiCodexModel || saved.codex.model,
      reasoningEffort: $("aiCodexReasoning").value || saved.codex.reasoningEffort } };
}
async function request(suffix = "", method = "GET", settings, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(method === "GET"
    ? "读取配置超时。请确认 610PPT 本地运行端已启动，或切换 ChatGPT API。"
    : "请求超时，当前操作未自动重试。请确认连接后再操作。")), method === "GET" ? 15000 : 65000);
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  // Also bound bridges/adapters that fail to propagate fetch cancellation.
  const abortable = promise => new Promise((resolve, reject) => {
    if (combined.aborted) { reject(combined.reason); return; }
    const abort = () => reject(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
  });
  try {
  const response = await abortable(fetch(`/api/v2/settings/ai${suffix}`, { method, cache: "no-store",
    headers: settings ? { "Content-Type": "application/json" } : {},
    body: settings ? JSON.stringify({ settings }) : undefined,
    signal: combined }));
  const result = await abortable(response.json().catch(() => ({})));
  if (!response.ok) throw new Error(result.error || "设置服务暂时不可用，请稍后重试");
  return result;
  } finally { clearTimeout(timeout); }
}
async function fetchModels(kind) {
  if (!loaded || busy) return;
  invalidate(kind);
  const group = groups[kind];
  if (kind === "openai" && (!$("aiApiKey").value.trim() && (!saved.openai.hasApiKey || $("aiClearKey").checked))) {
    $(group.status).textContent = "请先填写 API Key，再拉取模型。";
    return;
  }
  const state = { controller: new AbortController() };
  catalogs[kind] = state;
  $(group.button).disabled = true;
  $(group.status).textContent = "正在拉取模型…";
  try {
    const result = await request("/models", "POST", connection(kind), state.controller.signal);
    if (catalogs[kind] !== state || !dialog.open) return;
    state.data = result;
    const previousCodexModel = selection.aiCodexModel;
    for (const id of group.ids) {
      const rows = modelRows(kind, id);
      if (!rows.some(row => row.id === selection[id])) selection[id] = rows[0]?.id || "";
    }
    renderModels(kind);
    if (kind === "local-codex") renderReasoning(previousCodexModel !== selection.aiCodexModel);
    $(group.status).textContent = kind === "openai"
      ? `已拉取 ${result.total} 个模型，文案/视觉可选 ${result.text.length} 个，生图可选 ${result.image.length} 个。`
      : `已读取 ${result.models.length} 个支持文字与图片理解的模型。`;
    if (group.ids.some(id => !modelRows(kind, id).some(row => row.id === selection[id]))) {
      $(group.status).textContent += " 部分用途暂无可选模型，请检查账号模型权限。";
    }
  } catch (error) {
    if (catalogs[kind] === state && dialog.open) $(group.status).textContent = `${error.message}，可重试。`;
  } finally {
    if (catalogs[kind] === state) { $(group.button).disabled = false; state.controller = null; }
  }
}
function validateModels() {
  const kind = provider(), group = groups[kind], data = catalogs[kind]?.data;
  if (catalogs[kind]?.controller && !data) {
    status("请先完成模型拉取；如拉取失败，请重试。", "error"); return false;
  }
  if (data && group.ids.some(id => !modelRows(kind, id).some(row => row.id === selection[id]))) {
    status("请选择列表中可用的模型。", "error"); return false;
  }
  const originalConnection = kind === "openai"
    ? $("aiBaseUrl").value.trim() === saved.openai.baseUrl && !$("aiApiKey").value.trim()
    : $("aiCodexBinary").value.trim() === (saved.codex.binary || "");
  if (!data && (kind !== saved.provider || !originalConnection)) {
    status("请先拉取当前接入方式的模型，再选择并保存。", "error"); return false;
  }
  return form.reportValidity();
}
$("openAiSettings").addEventListener("click", async () => {
  if (dialog.open) return;
  const state = { controller: new AbortController() }; loadState = state;
  loaded = false; form.reset(); checks(); updateProvider(); dialog.showModal(); setBusy(true, "load");
  status("正在读取配置…");
  try {
    const result = await request("", "GET", undefined, state.controller.signal);
    if (loadState !== state || !dialog.open) return;
    populate(result.settings, true); loaded = true;
    status("配置保存在本机。拉取模型和连接测试不会保存修改。");
  } catch (error) { if (loadState === state && dialog.open) status(error.message, "error"); }
  finally { if (loadState === state) { loadState = null; setBusy(false); } }
  if (loaded) void fetchModels(provider());
});
$("closeAiSettings").addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", (event) => { if (busy && form.dataset.operation !== "load") event.preventDefault(); });
dialog.addEventListener("close", () => {
  loadState?.controller.abort(); loadState = null; setBusy(false);
  for (const state of Object.values(catalogs)) state.controller?.abort();
  catalogs = {}; $("aiApiKey").value = "";
});
const codexHelp = $("aiCodexPanel").querySelector(".ai-settings-help");
if (codexHelp) codexHelp.textContent = "先安装并启动 610PPT 本地运行端，再使用本机已登录的 Codex，无需 API Key。仅打开 Codex 不能建立连接。";
form.addEventListener("input", (event) => {
  if (Object.values(groups).some(group => event.target.id === group.search)) return;
  checks(); status("有未保存的修改。");
});
for (const radio of form.querySelectorAll('[name="aiProvider"]')) radio.addEventListener("change", () => {
  updateProvider();
  if (!catalogs[provider()]?.data && !catalogs[provider()]?.controller) void fetchModels(provider());
});
for (const [kind, group] of Object.entries(groups)) {
  $(group.button).addEventListener("click", () => void fetchModels(kind));
  $(group.search).addEventListener("input", () => renderModels(kind));
  $(group.search).addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });
  for (const id of group.ids) $(id).addEventListener("change", () => {
    selection[id] = $(id).value;
    if (id === "aiCodexModel") renderReasoning(true);
  });
}
$("aiCodexReasoning").addEventListener("change", () => $("aiCodexReasoning").setCustomValidity(""));
$("aiCodexBinary").addEventListener("input", () => invalidate("local-codex"));
$("aiBaseUrl").addEventListener("input", () => invalidate("openai"));
$("aiApiKey").addEventListener("input", () => {
  if ($("aiApiKey").value) $("aiClearKey").checked = false;
  invalidate("openai");
});
$("aiClearKey").addEventListener("change", () => {
  if ($("aiClearKey").checked) $("aiApiKey").value = "";
  invalidate("openai");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !loaded || !validateModels()) return;
  const settings = candidate();
  setBusy(true); status("正在保存…");
  try {
    const result = await request("", "PUT", settings);
    populate(result.settings);
    status("设置已保存，后续 AI 请求将使用新配置。", "success");
  } catch (error) { status(error.message, "error"); }
  finally { setBusy(false); }
});
$("testAiSettings").addEventListener("click", async () => {
  if (busy || !loaded || !validateModels()) return;
  const settings = candidate();
  setBusy(true); status("正在测试连接…"); checks();
  try {
    const result = await request("/test", "POST", settings);
    status(`${result.message || (result.ok ? "基础连接正常" : "连接失败")}。连接测试不会保存配置。`, result.ok ? "success" : "error");
    checks(result.checks || []);
  } catch (error) { status(error.message, "error"); }
  finally { setBusy(false); }
});
