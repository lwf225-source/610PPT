import { cloudMode, assertCloudApiUrl } from './runtime-adapter.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });
const clean = (value, label, max = 256) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail(`${label}格式不正确`);
  return value.trim();
};
export function normalizeApiBaseUrl(value) {
  const raw = clean(value, 'API 地址', 2048);
  let url;
  try { url = new URL(raw); } catch { throw fail('请输入完整的 API Base URL'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'lewen.woa.com' || hostname.endsWith('.lewen.woa.com')) throw fail('此 API 地址禁止访问');
  if (url.username || url.password || url.search || url.hash) throw fail('API 地址不能包含账号、参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))) throw fail('API 地址须使用 HTTPS（本机服务可使用 HTTP）');
  assertCloudApiUrl(url);
  return url.href.replace(/\/+$/, '');
}
export function defaultAiSettings(overrides = {}) {
  return {
    provider: 'local-codex',
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', imageModel: 'gpt-image-2', apiKey: '', ...overrides.openai },
    codex: { binary: '', model: 'gpt-5.6-sol', reasoningEffort: 'medium', ...overrides.codex }
  };
}
export function mergeAiSettings(current, input = {}) {
  const patch = input.settings ?? input;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('设置格式不正确');
  const provider = patch.provider ?? current.provider;
  if (!['local-codex', 'openai'].includes(provider)) throw fail('请选择本地 Codex 或 OpenAI API');
  const api = patch.openai ?? {};
  const codex = patch.codex ?? {};
  const baseUrl = normalizeApiBaseUrl(api.baseUrl ?? current.openai.baseUrl);
  const model = clean(api.model ?? current.openai.model, 'API 模型');
  if (!model) throw fail('请填写 API 模型');
  const imageModel = clean(api.imageModel ?? current.openai.imageModel ?? 'gpt-image-2', '图片模型');
  if (!imageModel) throw fail('请填写图片模型');
  let apiKey = current.openai.apiKey;
  if (api.clearApiKey === true) apiKey = '';
  else if (api.apiKey !== undefined) apiKey = clean(api.apiKey, 'API Key', 4096) || apiKey;
  if (baseUrl !== current.openai.baseUrl && apiKey && !api.apiKey?.trim() && api.clearApiKey !== true) throw fail('更换 API 地址时请重新填写 API Key，避免将原密钥发送到新地址');
  const binary = cloudMode() ? process.env.PPT_WORKBENCH_CODEX_BIN || '' : clean(codex.binary ?? current.codex.binary, 'Codex 路径', 2048);
  if (binary && !path.isAbsolute(binary) && !/^[\w.-]+$/.test(binary)) throw fail('Codex 路径须为完整绝对路径或命令名');
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(binary)) throw fail('请选择 Codex 的 codex.exe，不能使用 CMD 或 PowerShell 启动脚本；也可留空自动检测');
  const codexModel = clean(codex.model ?? current.codex.model, 'Codex 模型');
  if (!codexModel) throw fail('请填写 Codex 模型');
  const reasoningEffort = codex.reasoningEffort ?? current.codex.reasoningEffort;
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort)) throw fail('推理强度无效');
  return { provider, openai: { baseUrl, model, imageModel, apiKey }, codex: { binary, model: codexModel, reasoningEffort } };
}
export function publicAiSettings(settings) {
  const { apiKey, ...openai } = settings.openai;
  return { provider: settings.provider, openai: { ...openai, hasApiKey: Boolean(apiKey) }, codex: { ...settings.codex, ...(cloudMode() ? { binary: '' } : {}) } };
}
export function createAiSettingsStore({ filePath, defaults = defaultAiSettings() }) {
  const snapshot = () => {
    try { return mergeAiSettings(defaults, JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(defaults); throw new Error('AI 设置文件无法读取，请检查本机配置文件'); }
  };
  return {
    filePath, snapshot, publicSettings: () => publicAiSettings(snapshot()),
    candidate: (input) => mergeAiSettings(snapshot(), input),
    save(input) {
      const next = mergeAiSettings(snapshot(), input);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filePath);
      } finally { fs.rmSync(temporary, { force: true }); }
      return publicAiSettings(next);
    }
  };
}

// Responses strict mode requires every object property; optional fields remain nullable.
export function strictOutputSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictOutputSchema);
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strictOutputSchema(value)]));
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required || []);
    result.properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key,
      required.has(key) ? strictOutputSchema(value) : { anyOf: [strictOutputSchema(value), { type: 'null' }] }
    ]));
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}

export async function requestOpenAiJson(settings, { prompt, schema, images = [], signal, timeoutMs = 300000, fetchImpl = fetch, onProviderEvent, stage = 'analysis' }) {
  const baseUrl = normalizeApiBaseUrl(settings.openai.baseUrl);
  const apiKey = settings.openai.apiKey;
  if (!apiKey) throw fail('请先在设置中填写 OpenAI API Key');
  signal?.throwIfAborted();
  const content = [{ type: 'input_text', text: prompt }];
  for (const [index, image] of images.entries()) {
    content.push({ type: "input_text", text: `附图 ${index + 1}：${typeof image === "string" ? image : image.label || [image.role, image.path].filter(Boolean).join(" / ") || "连接测试图"}。以下紧接的图片与此标识对应。` });
    if (image?.dataUrl && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl)) { content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' }); continue; }
    const imagePath = typeof image === 'string' ? image : image.path;
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(imagePath).toLowerCase()];
    if (!mime) throw fail('参考图片格式不支持 API 分析');
    const bytes = await fs.promises.readFile(imagePath);
    content.push({ type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}`, detail: 'high' });
  }
  const callSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  onProviderEvent?.({ stage, type: 'provider.started', provider: 'openai' });
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST', redirect: 'error', signal: callSignal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: settings.openai.model, store: false, input: [{ role: 'user', content }], text: { format: { type: 'json_schema', name: 'workbench_result', strict: true, schema: strictOutputSchema(schema) } } })
    });
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Error(callSignal.aborted ? 'OpenAI API 请求超时' : 'OpenAI API 连接失败，请检查地址和网络（不允许重定向）');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OpenAI API 请求失败（HTTP ${response.status}）${response.status === 401 ? '，请检查 API Key' : response.status === 429 ? '，请检查额度或稍后重试' : ''}`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('OpenAI API 返回了无法解析的响应'); }
  if (payload.status && payload.status !== 'completed') throw new Error('OpenAI API 未完成本次输出，请检查模型与输出限制');
  const output = payload.output_text ?? payload.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('OpenAI API 未返回有效 JSON，请确认模型支持 Structured Outputs'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('OpenAI API 输出结构不正确');
  onProviderEvent?.({ stage, type: 'provider.completed', provider: 'openai' });
  return result;
}

export async function testAiSettings(settings, { runProcess, candidates = [], cwd, fetchImpl = fetch }) {
  if (settings.provider === 'openai') {
    const fixture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=';
    const result = await requestOpenAiJson(settings, { prompt: 'A tiny test image is attached. Confirm you can accept image input and return {"ok":true}.', images: [{ dataUrl: fixture }], schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, timeoutMs: 45000, fetchImpl });
    if (result.ok !== true) throw new Error('模型未按要求完成图像输入和结构化输出测试');
    const checks = [
      { id: 'text', label: '文案与结构化输出', status: 'passed', message: '结构化请求已完成' },
      { id: 'vision', label: '参考图与成图审核', status: 'passed', message: '已接受测试图片并返回结构化结果' },
      { id: 'image', label: '整页生图', status: 'unverified', message: '未生成图片；实际生图能力将在首次任务时验证' }
    ];
    try {
      const response = await fetchImpl(`${normalizeApiBaseUrl(settings.openai.baseUrl)}/models/${encodeURIComponent(settings.openai.imageModel || 'gpt-image-2')}`, { headers: { Authorization: `Bearer ${settings.openai.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (response.ok) checks[2].message = '图片模型可访问；未执行生图，实际图片权限将在首次任务时验证';
      else if ([401, 403, 404].includes(response.status)) checks[2].message = `未确认图片模型访问权限（HTTP ${response.status}），请核对图片模型与账号权限`;
      await response.body?.cancel().catch(() => {});
    } catch { /* Model discovery may be unsupported by compatible endpoints. */ }
    return { ok: true, checks, message: '文案和图片输入连接通过；未消耗整页生图请求，生图能力待首次任务验证' };
  }
  for (const command of settings.codex.binary ? [settings.codex.binary] : candidates) {
    try {
      await runProcess(command, ['--version'], '', { cwd, timeoutMs: 10000, unsetEnv: ['ELECTRON_RUN_AS_NODE'] });
      try { await runProcess(command, ['login', 'status'], '', { cwd, timeoutMs: 10000, unsetEnv: ['ELECTRON_RUN_AS_NODE'] }); }
      catch { return { ok: false, message: '已找到 Codex，但未确认登录状态。请在终端运行 codex login 后重试' }; }
      return { ok: true, message: '本地 Codex 可用且已登录；模型权限将在实际任务时确认' };
    } catch { /* Try next installation; never return arbitrary process output. */ }
  }
  return { ok: false, message: '未找到可运行的 Codex，请检查命令路径或安装 Codex' };
}

export function aiSettingsFingerprint(settings) {
  const policy = settings.provider === 'openai'
    ? { provider: 'openai', baseUrl: settings.openai.baseUrl, model: settings.openai.model, imageModel: settings.openai.imageModel }
    : { provider: 'local-codex', ...settings.codex };
  return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

async function downloadGeneratedImage(value, baseUrl, signal, fetchImpl) {
  let url;
  try { url = new URL(value); } catch { throw new Error('生图服务返回的图片下载地址无效'); }
  // Only the configured API origin and the observed DMX image storage are trusted.
  // Never forward the API credential to a returned URL or follow redirects.
  const api = new URL(baseUrl);
  const isDmxStorage = ['dmxapi.cn', 'www.dmxapi.cn'].includes(api.hostname)
    && url.origin === 'https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com';
  if (url.username || url.password || url.hash || (url.origin !== api.origin && !isDmxStorage)) {
    throw new Error('生图服务返回了未支持的图片下载域名');
  }
  const maxBytes = 100 * 1024 * 1024;
  let response;
  try { response = await fetchImpl(url.href, { redirect: 'error', signal }); }
  catch {
    signal.throwIfAborted();
    throw new Error('图片已生成，但下载连接失败；未重复发起生图请求');
  }
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.ok ? '生成图片超过下载大小限制' : `图片已生成，但下载失败（HTTP ${response.status}）`);
  }
  if (!response.body) throw new Error('生图服务返回了空图片文件');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      length += chunk.byteLength;
      if (length > maxBytes) throw new Error('生成图片超过下载大小限制');
      chunks.push(Buffer.from(chunk));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function requestOpenAiImage(settings, { prompt, images = [], signal, timeoutMs = 420000, fetchImpl = fetch, onAttempt }) {
  const baseUrl = normalizeApiBaseUrl(settings.openai.baseUrl);
  if (!settings.openai.apiKey) throw fail('请先在设置中填写 OpenAI API Key');
  signal?.throwIfAborted();
  const params = { model: settings.openai.imageModel || 'gpt-image-2', prompt, n: 1, size: '2048x1152', quality: 'high', output_format: 'png' };
  let body = JSON.stringify(params);
  const headers = { Authorization: `Bearer ${settings.openai.apiKey}` };
  if (images.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) form.set(key, String(value));
    for (const image of images) {
      const imagePath = typeof image === 'string' ? image : image.path;
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(imagePath).toLowerCase()];
      if (!mime) throw fail('参考图片格式不支持 API 生图');
      const bytes = await fs.promises.readFile(imagePath);
      form.append('image[]', new Blob([bytes], { type: mime }), path.basename(imagePath));
    }
    body = form;
  } else headers['Content-Type'] = 'application/json';
  const callSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const endpoint = images.length ? 'edits' : 'generations';
  for (let attempt = 1; attempt <= 3; attempt++) {
    onAttempt?.(attempt);
    let response;
    try { response = await fetchImpl(`${baseUrl}/images/${endpoint}`, { method: 'POST', redirect: 'error', signal: callSignal, headers, body }); }
    catch {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error(callSignal.aborted ? 'OpenAI 生图超时；远端完成状态未知，请核对后再重试' : 'OpenAI 生图连接中断；未自动重复派发，请核对网络和远端状态');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Retry only an explicit rate-limit rejection. A 5xx may arrive after
      // the provider accepted the generation, so repeating POST could create
      // a second candidate (and charge) without the user's confirmation.
      if (attempt < 3 && response.status === 429) {
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); callSignal.removeEventListener('abort', aborted); resolve(); };
          const aborted = () => { clearTimeout(timer); callSignal.removeEventListener('abort', aborted); reject(new Error('OpenAI 生图请求已取消或超时')); };
          const timer = setTimeout(done, 500 * attempt);
          callSignal.addEventListener('abort', aborted, { once: true });
          if (callSignal.aborted) aborted();
        });
        continue;
      }
      throw new Error(`OpenAI 生图请求失败（HTTP ${response.status}）${response.status >= 500 ? '；远端完成状态未知，未自动重复派发，请核对后再重试' : response.status === 401 ? '，请检查 API Key' : response.status === 403 ? '，请检查图片模型权限或组织验证' : response.status === 400 ? '，请检查图片模型是否支持 2048×1152 和参考图输入' : ''}`);
    }
    let payload;
    try { payload = await response.json(); } catch { throw new Error('OpenAI 生图响应无法解析'); }
    const item = payload.data?.[0];
    const b64 = item?.b64_json;
    let bytes;
    if (typeof b64 === 'string' && b64.length) {
      if (b64.length > 140000000 || !/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(b64)) throw new Error('OpenAI 未返回有效 PNG 图片数据');
      bytes = Buffer.from(b64, 'base64');
    } else if (typeof item?.url === 'string' && item.url) {
      bytes = await downloadGeneratedImage(item.url, baseUrl, callSignal, fetchImpl);
    } else throw new Error('生图服务未返回图片内容或下载地址');
    if (bytes.length < 64 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('OpenAI 返回的图片不是有效 PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || Math.abs(width / height - 16 / 9) > 0.01) throw new Error('OpenAI 返回图片不是 16:9；已拒绝拉伸或裁切，请检查图片模型');
    signal?.throwIfAborted();
    return { bytes, attempts: attempt, model: params.model, width, height };
  }
}
