// Own the entire exchange, including headers and response body. HTTP abort
// bounds observation; it does not prove an engine write stopped.
export function positiveTimeout(value, fallback) {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new RangeError("V1 timeoutMs 必须是有限的正毫秒数（不超过 2147483647）");
  }
  return timeout;
}

export function createRequestDeadline({ timeoutMs, idleTimeoutMs, signal, write = false }) {
  const controller = new AbortController();
  let totalTimer;
  let idleTimer;
  let disposed = false;
  const clean = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", externalAbort);
  };
  const abort = (reason) => {
    if (disposed) return;
    controller.abort(reason);
    clean();
  };
  const expired = (kind, ms) => abort(Object.assign(new Error(
    `V1 ${kind === "idle" ? "响应停滞" : "HTTP 观察"}超时（${ms}ms）` +
    (write ? "；后台操作可能仍在继续，未自动重试，请先查询任务或项目状态再决定是否重试" : "")
  ), { name: "TimeoutError", code: "V1_REQUEST_TIMEOUT", statusCode: 504,
    timeoutMs: ms, timeoutKind: kind, mayContinueInBackground: write }));
  const externalAbort = () => abort(signal.reason ?? new DOMException("请求已取消", "AbortError"));
  const touch = () => {
    if (disposed || !idleTimeoutMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expired("idle", idleTimeoutMs), idleTimeoutMs);
    idleTimer.unref?.();
  };
  if (signal?.aborted) externalAbort();
  else {
    signal?.addEventListener("abort", externalAbort, { once: true });
    totalTimer = setTimeout(() => expired("total", timeoutMs), timeoutMs);
    totalTimer.unref?.();
    touch();
  }
  return {
    signal: controller.signal, touch, dispose: clean,
    check() { controller.signal.throwIfAborted(); },
    async run(operation) {
      controller.signal.throwIfAborted();
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
      catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
      finally { controller.signal.removeEventListener("abort", onAbort); }
    }
  };
}
