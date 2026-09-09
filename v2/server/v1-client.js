import fs from "node:fs/promises";
import path from "node:path";
import { createRequestDeadline, positiveTimeout } from "./request-deadline.js";

export const V1_DEADLINES = Object.freeze({
  readMs: 15_000, writeMs: 15 * 60_000, modelMs: 2 * 60 * 60_000,
  uploadMs: 5 * 60_000, fileMs: 5 * 60_000, streamMs: 2 * 60 * 60_000
});

// Model stages may take 20 minutes each, with repairs and sequential batches.
// Durable task admission/polls already specify short deadlines at call sites.
const MODEL_PATH = /^\/api\/(?:deck\/(?:merge-codex|rewrite-page-preview)|image2\/compile|qa\/report)(?:[/?-]|$)/;

async function payloadFor(response, deadline) {
  const text = await deadline.run(() => response.text());
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

function cancelReader(reader, reason) {
  return reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
}

function toErrorText(payload, fallback) {
  if (payload && typeof payload === "object") return payload.error || payload.message || fallback;
  return fallback;
}

export class V1Client {
  constructor({ baseUrl, dataDir, deadlines = {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.dataDir = dataDir;
    this.deadlines = Object.fromEntries(Object.entries(V1_DEADLINES)
      .map(([key, fallback]) => [key, positiveTimeout(deadlines[key], fallback)]));
  }

  async headers() {
    const tokenPath = path.join(this.dataDir, ".api-token");
    const token = await fs.readFile(tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
    return token ? { "x-ppt-token": token } : {};
  }

  deadline(kind, { timeoutMs, signal, idleTimeoutMs } = {}, write = false) {
    return createRequestDeadline({ timeoutMs: positiveTimeout(timeoutMs, this.deadlines[kind]),
      idleTimeoutMs: idleTimeoutMs == null ? undefined : positiveTimeout(idleTimeoutMs), signal, write });
  }

  async request(pathname, { method = "GET", body, timeoutMs, signal } = {}) {
    const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
    const kind = !write ? "readMs" : MODEL_PATH.test(pathname) ? "modelMs" : "writeMs";
    const deadline = this.deadline(kind, { timeoutMs, signal }, write);
    try {
      const headers = await deadline.run(() => this.headers());
      const response = await deadline.run(() => fetch(`${this.baseUrl}${pathname}`, {
        method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined, signal: deadline.signal
      }));
      const payload = await payloadFor(response, deadline);
      if (!response.ok) throw Object.assign(new Error(toErrorText(payload, `V1 请求失败 (${response.status})`)), { statusCode: response.status });
      return payload;
    } finally { deadline.dispose(); }
  }

  async uploadMultipart(pathname, request, options = {}) {
    const contentType = String(request.headers["content-type"] || "").trim();
    if (!contentType.startsWith("multipart/form-data")) {
      throw new Error("上传请求格式无效，请重新选择文档");
    }
    const deadline = this.deadline("uploadMs", options, true);
    try {
      const headers = await deadline.run(() => this.headers());
      const response = await deadline.run(() => fetch(`${this.baseUrl}${pathname}`, {
        method: "POST", headers: { "Content-Type": contentType, ...headers },
        body: request, duplex: "half", signal: deadline.signal
      }));
      const payload = await payloadFor(response, deadline);
      if (!response.ok) throw Object.assign(new Error(toErrorText(payload, `文档上传失败 (${response.status})`)), { statusCode: response.status });
      return payload;
    } finally { deadline.dispose(); }
  }

  async file(pathname, options = {}) {
    const deadline = this.deadline("fileMs", options);
    try {
      const headers = await deadline.run(() => this.headers());
      const response = await deadline.run(() => fetch(`${this.baseUrl}${pathname}`, { headers, signal: deadline.signal }));
      if (!response.ok || !response.body) {
        const payload = await payloadFor(response, deadline);
        throw Object.assign(new Error(toErrorText(payload, `V1 文件请求失败 (${response.status})`)), { statusCode: response.status });
      }
      deadline.check();
      // Keep the deadline until EOF/cancel/error, including Response.text() and
      // arrayBuffer(). Consumers must consume or cancel the returned body.
      const reader = response.body.getReader();
      let finished = false;
      const finish = (reason, cancel = false) => {
        if (finished) return;
        finished = true;
        deadline.signal.removeEventListener("abort", onAbort);
        deadline.dispose();
        if (cancel) return cancelReader(reader, reason);
        reader.releaseLock();
      };
      let output;
      const onAbort = () => {
        if (finished) return;
        output.error(deadline.signal.reason);
        void finish(deadline.signal.reason, true);
      };
      const body = new ReadableStream({
        start(controller) { output = controller; deadline.signal.addEventListener("abort", onAbort, { once: true }); },
        async pull(controller) {
          try {
            const { done, value } = await deadline.run(() => reader.read());
            if (finished) return;
            if (done) { finish(); controller.close(); }
            else { deadline.touch(); controller.enqueue(value); }
          } catch (error) {
            if (finished) return;
            controller.error(error);
            void finish(error, true);
          }
        },
        cancel(reason) { return finish(reason, true); }
      });
      const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const key of ["url", "redirected", "type"]) Object.defineProperty(result, key, { value: response[key] });
      return result;
    } catch (error) { deadline.dispose(); throw error; }
  }

  // Total cap; no default short idle cap for intentionally silent model stages.
  // Callers with heartbeat guarantees may opt into idleTimeoutMs.
  async stream(pathname, body, onEvent, options = {}) {
    const deadline = this.deadline("streamMs", options, true);
    let reader;
    let completed = false;
    try {
      const headers = await deadline.run(() => this.headers());
      const response = await deadline.run(() => fetch(`${this.baseUrl}${pathname}`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", ...headers },
        body: JSON.stringify(body), signal: deadline.signal
      }));
      if (!response.ok || !response.body) {
        const payload = await payloadFor(response, deadline);
        throw Object.assign(new Error(toErrorText(payload, `V1 流式请求失败 (${response.status})`)), { statusCode: response.status });
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const emit = async (line, tail = false) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); }
        catch { throw new Error(tail ? "拆页响应尾部不完整，未提交成功状态" : "拆页响应损坏或中断，未收到可提交的完整结果"); }
        deadline.check();
        // Once invoked a callback may persist a commit. Retain ordering and do
        // not race it against timeout and report failure while it still writes.
        await onEvent(event);
        deadline.check();
      };
      while (true) {
        const { done, value } = await deadline.run(() => reader.read());
        if (value?.length) deadline.touch();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) await emit(line);
        if (done) break;
      }
      await emit(buffer, true);
      completed = true;
    } finally {
      deadline.dispose();
      if (reader) {
        if (completed) reader.releaseLock();
        else await cancelReader(reader, deadline.signal.reason);
      }
    }
  }
}
