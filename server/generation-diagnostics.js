import crypto from "node:crypto";

const digest = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");
// Diagnostics are metadata, not a second copy of customer documents or provider
// transcripts. Hashes show which inputs were requested, not tool compliance.
export function generationDiagnostic({ job, startedAt, prompt, references = [], result, error, failureReason, recovered, runtimePolicy, timing, now = new Date() }) {
  const output = result || error || {};
  const classification = `${error?.code || ""} ${error?.message || ""} ${output.stderr || ""} ${failureReason || ""}`;
  return {
    version: 2, provider: "codex-imagegen", startedAt: startedAt.toISOString(), finishedAt: now.toISOString(),
    // Caller supplies the same classified/redacted explanation shown on the card.
    // Do not persist raw stdout, stderr, prompts, or provider transcripts.
    ...(error ? { failureReason: String(failureReason || "执行失败，未返回具体原因。").slice(0, 500),
      errorCode: /^(?:[0-9]{1,3}|ENOENT|EACCES|EPERM|ENOSPC|ETIMEDOUT|ABORT_ERR|ERR_CANCELED)$/.test(String(error.code ?? "")) ? String(error.code) : null } : {}),
    elapsedMs: Math.max(0, now - startedAt), status: error ? (recovered ? "recovered-image" : "failed") : "completed",
    jobDigest: digest(job?.jobId), promptDigest: digest(prompt), promptCharacters: String(prompt || "").length,
    requestedReferenceCount: references.length, requestedReferenceDigests: references.map(digest),
    referenceUseVerified: false, stdoutCharacters: String(output.stdout || "").length,
    stderrCharacters: String(output.stderr || "").length,
    ...(runtimePolicy ? { runtimePolicy: { model: runtimePolicy.model, reasoningEffort: runtimePolicy.reasoningEffort, serviceTier: runtimePolicy.serviceTier } } : {}),
    ...(timing ? { timing: Object.fromEntries(["firstEventMs", "imageStartedMs", "imageFinishedMs", "imageCalls", "imageToolElapsedMs"]
      .map((key) => [key, Number.isFinite(timing[key]) && timing[key] >= 0 ? timing[key] : null])) } : {}),
    signals: { timeout: /ETIMEDOUT|timeout|timed?\s*out|超时/i.test(classification),
      cancelled: /ABORT_ERR|AbortError|已取消/i.test(classification),
      rateLimit: /rate.?limit|quota|usage.?limit|\b429\b|限流|额度不足|使用上限/i.test(classification),
      authentication: /unauthorized|not logged in|token expired|\b401\b|未登录/i.test(classification),
      network: /reconnect|connection (?:reset|closed)|stream disconnected|network error|socket|连接中断/i.test(classification) }
  };
}
