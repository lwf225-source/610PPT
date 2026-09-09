import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Parse provider telemetry in memory; never retain message/reasoning/tool bodies. */
export function createEditorialTelemetry({ now = Date.now, onEvent, onForbiddenTool } = {}) {
  const startedAt = now();
  const record = { timingMode: "live-events", threadStartedMs: null, turnStartedMs: null, firstModelActivityMs: null, firstVisibleOutputMs: null, turnCompletedMs: null, retrySignals: 0, initializationWarnings: 0, forbiddenToolEvents: 0, eventCount: 0, outputCharacters: 0, usage: null, signals: { timeout: false, rateLimit: false, network: false, authentication: false, schema: false } };
  let pending = "";
  let hasLiveChunks = false;
  const observeText = (text) => {
    record.retrySignals += (text.match(/retrying|reconnecting|reconnect attempt/gi) || []).length;
    record.initializationWarnings += (text.match(/MCP.*(?:failed|error)|failed to (?:load|initialize)/gi) || []).length;
    record.signals.timeout ||= /timeout|timed?\s*out|超时/i.test(text);
    record.signals.rateLimit ||= /rate.?limit|quota|usage.?limit|\b429\b/i.test(text);
    record.signals.network ||= /reconnect|connection (?:reset|closed)|stream disconnected|network error|socket|websocket/i.test(text);
    record.signals.authentication ||= /unauthorized|not logged in|token expired|\b401\b/i.test(text);
    record.signals.schema ||= /invalid (?:json|schema)|schema validation|invalid_json_schema/i.test(text);
  };
  const consumeLine = (line, live) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (typeof event.type !== "string") return;
    record.eventCount++;
    if (["cloud.queued", "cloud.execution.started", "cloud.execution.completed"].includes(event.type)) {
      if (Number.isFinite(event.queueMs)) record.queueMs = Math.max(0, event.queueMs);
      if (Number.isFinite(event.executionMs)) record.executionMs = Math.max(0, event.executionMs);
      try { onEvent?.({ type: event.type, queueMs: record.queueMs, executionMs: record.executionMs }); } catch {}
      return;
    }
    if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(event.item?.type)) {
      record.forbiddenToolEvents++;
      onForbiddenTool?.(event.item.type);
    }
    const elapsed = live ? Math.max(0, now() - startedAt) : null;
    if (event.type === "thread.started" && record.threadStartedMs === null) record.threadStartedMs = elapsed;
    if (event.type === "turn.started" && record.turnStartedMs === null) record.turnStartedMs = elapsed;
    if (event.type.startsWith("item.") && record.firstModelActivityMs === null) record.firstModelActivityMs = elapsed;
    if (event.item?.type === "agent_message" && event.type === "item.completed") {
      if (record.firstVisibleOutputMs === null) record.firstVisibleOutputMs = elapsed;
      record.outputCharacters += typeof event.item.text === "string" ? event.item.text.length : 0;
    }
    if (event.type === "error" || event.type === "turn.failed") observeText(JSON.stringify(event.error || event.message || ""));
    if (event.type === "turn.completed") {
      record.turnCompletedMs = elapsed;
      const keys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
      record.usage = Object.fromEntries(keys.filter((key) => Number.isFinite(event.usage?.[key])).map((key) => [key, Math.max(0, event.usage[key])]));
    }
    // The callback is also restricted to a small allowlist; not raw provider JSON.
    if (["thread.started", "turn.started", "turn.completed", "turn.failed", "error"].includes(event.type)) {
      try { onEvent?.({ type: event.type, elapsedMs: elapsed, usage: event.type === "turn.completed" ? record.usage : undefined }); } catch { /* telemetry is best effort */ }
    }
  };
  return {
    stdout(chunk) {
      hasLiveChunks = true;
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) consumeLine(line, true);
      if (pending.length > 2_000_000) pending = "";
    },
    stderr(chunk) { observeText(String(chunk)); },
    finish(result = {}) {
      observeText(String(result.message || ""));
      if (!hasLiveChunks) {
        record.timingMode = "completion-only";
        for (const line of String(result.stdout || "").split(/\r?\n/)) consumeLine(line, false);
        observeText(String(result.stderr || ""));
      } else if (pending) consumeLine(pending, true);
      pending = "";
      return { ...structuredClone(record), elapsedMs: Math.max(0, now() - startedAt) };
    }
  };
}

export async function recordEditorialAttempt(dataDir, record) {
  const diagnosticId = crypto.randomUUID();
  const dir = path.join(dataDir, "codex", "diagnostics");
  const safe = { diagnosticId, createdAt: new Date().toISOString(), stage: record.stage, model: record.model, status: record.status, timeoutMs: record.timeoutMs, outputContract: record.outputContract, promptCharacters: record.promptCharacters, promptBytes: record.promptBytes, schemaBytes: record.schemaBytes, ...record.telemetry };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${diagnosticId}.json`), JSON.stringify(safe, null, 2), { mode: 0o600, flag: "wx" });
    return diagnosticId;
  } catch { return null; }
}

export async function recordEditorialFailure(dataDir, error, { stage, model, startedAt, timeoutMs, outputContract } = {}) {
  const diagnosticId = crypto.randomUUID();
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  // Record classifications/counts only. Never persist raw provider output,
  // source copy, prompts, auth material or model reasoning in diagnostics.
  const record = { diagnosticId, stage, model, outputContract, timeoutMs,
    elapsedMs: Math.max(0, Date.now() - startedAt), createdAt: new Date().toISOString(),
    stdoutCharacters: String(error?.stdout || "").length, stderrCharacters: String(error?.stderr || "").length,
    signals: {
      timeout: /timeout|timed\s*out|超时/i.test(text),
      rateLimit: /rate.?limit|quota|usage.?limit|\b429\b/i.test(text),
      network: /reconnect|connection (?:reset|closed)|stream disconnected|network error|socket|websocket/i.test(text),
      authentication: /unauthorized|not logged in|token expired|\b401\b/i.test(text),
      schema: /invalid (?:json|schema)|schema validation|invalid_json_schema/i.test(text)
    }
  };
  const dir = path.join(dataDir, "codex", "diagnostics");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${diagnosticId}.json`), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    return diagnosticId;
  } catch { return null; }
}
