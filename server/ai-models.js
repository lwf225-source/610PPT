import { spawn } from 'node:child_process';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeApiBaseUrl } from './ai-settings.js';
import { cloudMode, readCloudDeviceStatus } from './runtime-adapter.js';

const problem = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
const modelId = (value) => typeof value === 'string' && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value) ? value : '';
// /models supplies IDs, not modality/Structured Outputs support. Intersect its
// live result with families supported by this workflow; never invent options.
// Sources: OpenAI model catalog and image-generation guide, checked 2026-09-07.
const textFamily = /^gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?|5(?:\.[1245])?(?:-mini|-nano|-pro)?|5\.6-(?:sol|terra|luna)|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/;
// DMX exposes gpt-image-2-03 in its live catalog; retain the exact provider ID.
// Discovery is only eligibility for selection, not proof of successful generation.
const imageFamily = /^gpt-image-2(?:-03|-\d{4}-\d{2}-\d{2})?$/;
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function classifyApiModels(data) {
  if (!Array.isArray(data)) throw problem('API 未返回有效的模型列表');
  const unique = new Map();
  for (const model of data) {
    const id = modelId(model?.id);
    if (id && !(model.shutdown_date && /^\d{4}-\d{2}-\d{2}$/.test(model.shutdown_date) && model.shutdown_date <= new Date().toISOString().slice(0, 10))) unique.set(id, model);
  }
  const text = [], image = [];
  for (const [id, model] of unique) {
    const input = model.input_modalities || model.inputModalities || model.modalities?.input;
    const output = model.output_modalities || model.outputModalities || model.modalities?.output;
    const capabilities = model.capabilities || {};
    const explicitText = Array.isArray(input) && input.includes('text') && input.includes('image')
      && Array.isArray(output) && output.includes('text') && capabilities.structured_outputs === true;
    const explicitImage = Array.isArray(input) && input.includes('image') && Array.isArray(output) && output.includes('image')
      && Array.isArray(model.supported_sizes) && model.supported_sizes.includes('2048x1152');
    const textDenied = (Array.isArray(input) && (!input.includes('image') || !input.includes('text')))
      || (Array.isArray(output) && !output.includes('text')) || capabilities.structured_outputs === false;
    const imageDenied = (Array.isArray(input) && !input.includes('image'))
      || (Array.isArray(output) && !output.includes('image'))
      || (Array.isArray(model.supported_sizes) && !model.supported_sizes.includes('2048x1152'));
    if (!textDenied && (explicitText || textFamily.test(id))) text.push({ id, label: id });
    if (!imageDenied && (explicitImage || imageFamily.test(id))) image.push({ id, label: id });
  }
  const sort = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true });
  return { text: text.sort(sort), image: image.sort(sort), total: unique.size,
    excluded: unique.size - new Set([...text, ...image].map(model => model.id)).size };
}

export async function listApiModels(settings, { fetchImpl = fetch, signal } = {}) {
  const baseUrl = normalizeApiBaseUrl(settings.openai.baseUrl);
  if (!settings.openai.apiKey) throw problem('请先填写 API Key，再拉取模型', 400);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${settings.openai.apiKey}` },
      redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
  } catch { throw problem('模型列表拉取失败，请检查 API 地址和网络（不允许重定向）'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw problem(`模型列表拉取失败（HTTP ${response.status}）${[401, 403].includes(response.status) ? '，请检查 API Key 和账号权限' : ''}`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw problem('API 模型列表格式无效'); }
  return { provider: 'openai', ...classifyApiModels(payload.data), source: 'api-models', fetchedAt: new Date().toISOString() };
}

export function normalizeCodexModels(data) {
  if (!Array.isArray(data)) throw problem('Codex 返回了无效模型列表');
  const seen = new Set();
  return data.flatMap((model) => {
    if (!model || typeof model !== 'object') return [];
    const id = modelId(model.model || model.id);
    const input = model.inputModalities || ['text', 'image'];
    if (!id || seen.has(id) || model.hidden || !Array.isArray(input) || !input.includes('text') || !input.includes('image')) return [];
    seen.add(id);
    return [{ id, label: id, isDefault: Boolean(model.isDefault),
      reasoningEfforts: [...new Set((Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(item => item?.reasoningEffort).filter(item => efforts.has(item)))],
      defaultReasoningEffort: efforts.has(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null }];
  });
}

export function readCodexModels(binary, { spawnImpl = spawn, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnImpl(binary, ['app-server', '--config', 'mcp_servers={}', '--config', 'plugins={}',
      '--config', 'features.apps=false', '--config', 'web_search="disabled"', '--config', 'model_provider="openai"', '--config', 'model_providers={}'],
    { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', settled = false, id = 1, pages = 0;
    const models = [], cursors = new Set();
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 1000); killer.unref();
      child.once('exit', () => clearTimeout(killer));
      error ? reject(error) : resolve(normalizeCodexModels(models));
    };
    const timer = setTimeout(() => finish(problem('Codex 模型列表读取超时，请检查登录状态后重试')), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on('error', () => finish(problem('Codex 模型服务连接已关闭')));
    child.on('error', error => finish(Object.assign(problem('无法启动 Codex 模型服务，请检查程序路径'), { code: error.code })));
    child.on('exit', () => { if (!settled) finish(problem('Codex 未返回模型列表，请检查版本与登录状态')); });
    child.stderr.on('data', () => {}); // Never echo process diagnostics or credentials.
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) return finish(problem('Codex 模型列表响应过大'));
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        if (message.error) return finish(problem('Codex 无法列出模型，请检查版本与登录状态'));
        if (id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: ++id, method: 'model/list', params: { limit: 100, includeHidden: false } });
        } else {
          if (!Array.isArray(message.result?.data)) return finish(problem('Codex 返回了无效模型列表'));
          models.push(...message.result.data);
          const cursor = message.result.nextCursor;
          if (!cursor) return finish();
          if (++pages > 20 || cursors.has(cursor)) return finish(problem('Codex 模型分页响应无效'));
          cursors.add(cursor);
          send({ id: ++id, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
        }
      }
    });
    send({ id, method: 'initialize', params: { clientInfo: { name: '610ppt_model_picker', title: '610PPT', version: '1.0.0' } } });
  });
}

export async function listAiModels(settings, { candidates = [], ...options } = {}) {
  if (settings.provider === 'openai') return listApiModels(settings, options);
  if (cloudMode()) {
    const readStatus = options.cloudStatusReader || readCloudDeviceStatus;
    const signal = AbortSignal.any([AbortSignal.timeout(options.cloudRefreshTimeoutMs ?? 45000), ...(options.signal ? [options.signal] : [])]);
    let device;
    try {
      device = await readStatus({ refreshModels: true, signal });
      if (!device?.online) throw problem('请先启动并配对本地 Codex 连接器', 409);
      if (!device.capabilities?.loggedIn) throw problem('本地 Codex 尚未登录，请在连接器中完成登录', 409);
      if (!(device.capabilities.protocolVersion >= 2)) throw problem('请更新并重启本地连接器，再刷新模型列表', 409);
      const requestedAt = device.refreshModelsRequestedAt;
      if (!requestedAt) throw problem('云端尚不支持刷新模型，请更新网关后重试', 409);
      while (Number(device.capabilities?.modelsRefreshCompletedAt || 0) < requestedAt) {
        await delay(options.cloudRefreshPollMs ?? 500, undefined, { signal });
        const next = await readStatus({ signal });
        if (!next?.online || next.id !== device.id) throw problem('本地连接器已断开或切换，请重新刷新模型列表', 409);
        if (!next.capabilities?.loggedIn) throw problem('本地 Codex 尚未登录，请在连接器中完成登录', 409);
        device = next;
      }
    } catch (error) {
      if (signal.aborted) throw problem('本地连接器刷新模型列表超时，请检查 Codex 登录状态和网络后重试', 409);
      throw error;
    }
    const models = normalizeCodexModels(device.capabilities.models || []);
    if (!models.length) throw problem('本地 Codex 未返回可用模型，请检查账号权限后重新刷新', 409);
    const rawFetchedAt = device.capabilities.modelsFetchedAt;
    const fetchedAt = typeof rawFetchedAt === 'number' ? rawFetchedAt : Date.parse(rawFetchedAt);
    return { provider: 'local-codex', models, total: models.length, source: 'local-device', fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 && fetchedAt <= 8640000000000000 ? new Date(fetchedAt).toISOString() : new Date().toISOString() };
  }
  for (const binary of settings.codex.binary ? [settings.codex.binary] : candidates) {
    try {
      const models = await readCodexModels(binary, options);
      return { provider: 'local-codex', models, total: models.length, source: 'codex-model-list', fetchedAt: new Date().toISOString() };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw problem('未找到本地 Codex，请检查程序路径');
}
