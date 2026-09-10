import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { runProcessWithInput } from '../server/process-runner.js';
import { generationDiagnostic } from '../server/generation-diagnostics.js';

const source = await fs.readFile(new URL('../server/codex-integration.js', import.meta.url), 'utf8');
const start = source.indexOf('function codexActionErrorMessage(');
const classify = vm.runInNewContext('(' + source.slice(start, source.indexOf('\nfunction buildCodexExecBaseArgs', start)) + ')', { deps: {} });
const app = await fs.readFile(new URL('../v2/public/app.js', import.meta.url), 'utf8');
const uiStart = app.indexOf('function image2FailurePresentation(');
const present = vm.runInNewContext('(' + app.slice(uiStart, app.indexOf('\nfunction ', uiStart + 1)) + ')', { pageImagePath: p => p.imagePath });
const event = error => JSON.stringify({ type: 'turn.failed', error });
const fixtures = [
  [{ stdout: event({ message: 'HTTP 401 unauthorized' }) }, /未登录/, 'authentication'],
  [{ stdout: event({ message: 'HTTP 429', code: 'insufficient_quota' }) }, /额度不足/, 'rateLimit'],
  [{ stderr: 'ERROR You have hit your usage limit' }, /使用上限/, 'rateLimit'],
  [{ stdout: event({ message: 'Too many requests', code: 'rate_limit_exceeded' }) }, /被限流/, 'rateLimit'],
  [{ stdout: event({ message: 'stream disconnected before completion' }) }, /连接中断/, 'network'],
  [{ stderr: 'ERROR fetch failed ECONNRESET' }, /连接中断/, 'network'],
  [{ stderr: 'Task exceeded 60000 ms execution limit' }, /生图超时/, 'timeout'],
  [{ stdout: event({ message: 'HTTP 503 Service unavailable' }) }, /模型服务暂时异常/],
  [{ stdout: event({ message: 'Model cannot be used', code: 'model_not_found' }) }, /模型不可用/],
  [{ stdout: JSON.stringify({ type: 'response.failed', response: { error: { code: 'content_policy_violation', message: 'Request rejected' } } }) }, /安全检查/],
  [{ stderr: 'ERROR No online local Codex connector' }, /连接器离线/],
  [{ stderr: 'ERROR HTTP 403 forbidden' }, /访问被拒绝/],
  [{ stderr: 'ERROR ENOSPC: no space left on device' }, /磁盘空间不足/],
  [{ stdout: event({ message: 'HTTP 401 unauthorized' }) + '\n' + event({ message: 'Turn failed' }) }, /未登录/],
  [{ stdout: event({ message: 'Turn failed' }), stderr: 'ERROR HTTP 503' }, /模型服务暂时异常/],
  [{ stderr: 'Connector did not return all requested outputs' }, /生图结果未回传/],
  [{}, /退出码 1.*未返回具体原因/],
  [{ stdout: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'HTTP 401 insufficient_quota PRIVATE_DOCUMENT' } }) }, /未返回具体原因/]
];
for (const [streams, expected, signal] of fixtures) {
  const error = Object.assign(new Error('Codex 退出码 1'), { code: 1 }, streams);
  const reason = classify(error, '生图');
  assert.match(reason, expected);
  const card = present({ generationStatus: 'failed', error: reason, imagePath: '/prior.png' });
  assert.match(card.summary + card.detail, expected, 'Actual cause survives presentation with a retained preview');
  assert.doesNotMatch(card.label, /校验/, 'A previous preview must not mislabel generation failure as QA failure');
  const diagnostic = generationDiagnostic({ job: { jobId: 'fixture' }, startedAt: new Date(), prompt: 'PRIVATE_DOCUMENT', error, failureReason: reason });
  assert.equal(diagnostic.failureReason, reason);
  assert.equal(diagnostic.errorCode, '1');
  if (signal) assert.equal(diagnostic.signals[signal], true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_DOCUMENT|aggregated_output/);
}
// Unclassified provider text must never become card copy or persisted metadata.
const privateSentinel = ['PRIVATE_DOCUMENT_EXCERPT', 'fixture@example.invalid',
  ['','Users','fixture','private.txt'].join('/'), 'credential=PRIVATE_ACCOUNT_SENTINEL'].join(' ');
for (const streams of [
  { message: privateSentinel },
  { stdout: event({ message: privateSentinel }) },
  { stderr: `ERROR ${privateSentinel}` }
]) {
  const error = Object.assign(new Error('Codex 退出码 1'), { code: 1 }, streams);
  const reason = classify(error, '生图');
  assert.match(reason, /无法分类的错误/);
  const persisted = generationDiagnostic({ job: {}, startedAt: new Date(), prompt: privateSentinel, error, failureReason: reason });
  const card = present({ error: reason });
  for (const output of [reason, JSON.stringify(persisted), JSON.stringify(card)]) {
    assert.doesNotMatch(output, /PRIVATE_DOCUMENT_EXCERPT|fixture@example|PRIVATE_ACCOUNT_SENTINEL/);
    assert.ok(!output.includes(['','Users','fixture'].join('/')));
  }
}
const privateCode = generationDiagnostic({ job: {}, startedAt: new Date(), prompt: '',
  error: { code: 'PRIVATE_ACCOUNT_SENTINEL' }, failureReason: classify(new Error('Unrecognized provider error'), '生图') });
assert.equal(privateCode.errorCode, null);
assert.doesNotMatch(JSON.stringify(privateCode), /PRIVATE_ACCOUNT_SENTINEL/);
for (const error of ['Codex 退出码 1', 'Codex 生图失败：Codex 退出码 1', 'Codex 生图 exited with code 1']) {
  const card = present({ error, imagePath: '/previous.png' });
  assert.equal(card.category, 'unknown-error');
  assert.match(card.summary, /旧任务记录未保存具体原因/);
  assert.equal(card.detail, error);
}
const qa = present({ error: '视觉校验超时', failureStage: 'quality-check', imagePath: '/candidate.png' });
assert.equal(qa.category, 'timeout');
assert.match(qa.summary, /视觉校验超时/);

// Real subprocess boundary, no model or network: stderr/stdout must survive
// the numeric exit code, become a readable explanation, and reach the card.
let processError;
try {
  await runProcessWithInput(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({type:"turn.failed",error:{code:"insufficient_quota",message:"HTTP 429"}}));process.exitCode=1;'], '', { timeoutMs: 3000 });
} catch (error) { processError = error; }
assert.equal(processError.code, 1);
assert.match(present({ error: classify(processError, '生图') }).summary, /额度不足/);
for (const name of ['runCodexImage2VisualAudit', 'runCodexImage2VisualMasterAudit']) {
  const a = source.indexOf(`async function ${name}(`);
  const b = source.indexOf('\nasync function ', a + 1);
  const audit = vm.runInNewContext('(' + source.slice(a, b).trim() + ')', {
    deps: { DATA_DIR: '/fixture', codexCandidates: () => ['codex'], runProcessWithInput: async () => {
      throw Object.assign(new Error('Codex 退出码 1'), { code: 1, stdout: event({ message: 'HTTP 429', code: 'insufficient_quota' }) });
    } }, crypto: { randomUUID: () => 'fixture' }, path: { join: (...p) => p.join('/'), isAbsolute: () => false },
    fs: { rm: async () => {} },
    ensureImage2VisualAuditSchemaFile: async () => '/fixture/schema.json',
    ensureImage2VisualMasterAuditSchemaFile: async () => '/fixture/schema.json',
    isolatedCodexRuntime: async () => ({ runtimeDir: '/fixture', imageArgs: [], imageLabels: [] }),
    buildCodexExecBaseArgs: () => [], CODEX_TOOLLESS_ARGS: [], codexActionErrorMessage: classify
  });
  await assert.rejects(audit('fixture', 1), error => error.code === 1 && /额度不足/.test(error.message));
}
console.log(`PASS ${fixtures.length} generation error causes, 3 historical failures, QA preservation and real subprocess-to-card flow; no model/image requests`);
