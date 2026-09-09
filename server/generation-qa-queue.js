import fs from "node:fs/promises";
import crypto from "node:crypto";

/** Two lanes share the pre-existing provider budget: splitting QA adds no slots. */
export function createGenerationQaQueue({ totalConcurrency = 3, generationConcurrency = totalConcurrency, qaConcurrency = 1, onChange } = {}) {
  const totalLimit = Math.max(1, Math.min(3, Math.floor(Number(totalConcurrency)) || 1));
  const limits = { generation: Math.max(1, Math.min(totalLimit, Math.floor(Number(generationConcurrency)) || 1)), qa: Math.max(1, Math.min(totalLimit, Math.floor(Number(qaConcurrency)) || 1)) };
  const waiting = { generation: [], qa: [] };
  const active = { generation: 0, qa: 0 };
  let nextLane = "generation";
  const snapshot = () => ({ totalLimit, generationLimit: limits.generation, qaLimit: limits.qa, active: { ...active }, queued: { generation: waiting.generation.length, qa: waiting.qa.length } });
  const notify = () => { try { onChange?.(snapshot()); } catch { /* metrics cannot block dispatch */ } };
  const pump = () => {
    while (active.generation + active.qa < totalLimit) {
      const lane = [nextLane, nextLane === "generation" ? "qa" : "generation"].find((name) => waiting[name].length && active[name] < limits[name]);
      if (!lane) break;
      const request = waiting[lane].shift();
      if (request.signal?.aborted) { request.cleanup(); request.reject(request.signal.reason); continue; }
      request.cleanup();
      active[lane]++;
      nextLane = lane === "generation" ? "qa" : "generation";
      notify();
      Promise.resolve().then(request.operation).then(request.resolve, request.reject).finally(() => {
        active[lane]--;
        notify();
        pump();
      });
    }
  };
  return {
    snapshot,
    run(lane, operation, { signal } = {}) {
      if (!Object.hasOwn(waiting, lane)) return Promise.reject(new Error("Unknown generation/QA queue lane"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const request = { operation, resolve, reject, signal, cleanup: () => signal?.removeEventListener("abort", abort) };
        const abort = () => {
          const index = waiting[lane].indexOf(request);
          if (index >= 0) {
            waiting[lane].splice(index, 1);
            request.cleanup();
            reject(signal.reason);
            notify();
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        waiting[lane].push(request);
        notify();
        pump();
      });
    }
  };
}

export function qaCandidateIdentity(job) {
  return { promptHash: job.promptHash || null, image2PlanSignature: job.image2PlanSignature || null, renderPlanSignature: job.renderPlanSignature || null, anchorSignature: job.anchorSignature || null, contentAnchorSignature: job.contentAnchorSignature || null };
}

export function reusableQaCandidate(candidate, job) {
  if (!candidate?.result?.imagePath || !["pending", "error"].includes(candidate.status) || !candidate.identity?.promptHash) return null;
  const expected = qaCandidateIdentity(job);
  return Object.keys(expected).every((key) => candidate.identity[key] === expected[key]) ? candidate.result : null;
}

export function retryableImageAuditError(error) {
  const message = String(error?.message || "");
  if (/缺少本地图片|校验器不可用|not found|ENOENT|unauthorized|\b401\b/i.test(message)) return false;
  return /timeout|timed?\s*out|超时|\b429\b|rate.?limit|network|stream|connection|socket|temporar|unavailable|\b50[234]\b|invalid.*(?:json|schema)|invalid audit/i.test(message);
}

/** Cache-key boundary only; does not cache or grant acceptance. Caller supplies
 * authoritative locked copy, ordered master references and exact rule/model policy.
 * Missing files/policy fail closed. Paths/mtime are never substitutes for bytes.
 * Future cache consumers must recompute after auditing (reject changed inputs),
 * store only passed audits atomically, and still run the final acceptance gate. */
export async function buildGenerationQaFingerprint({ candidatePath, anchorPaths, lockedCopy, ruleVersion, modelPolicy }) {
  if (!candidatePath || !Array.isArray(anchorPaths) || !anchorPaths.length
    || !Array.isArray(lockedCopy) || !lockedCopy.length || !lockedCopy.every((item) => typeof item === "string")
    || typeof ruleVersion !== "string" || !ruleVersion.trim() || typeof modelPolicy !== "string" || !modelPolicy.trim()) {
    throw new Error("QA fingerprint requires candidate bytes, master bytes, locked copy, rule version and model policy");
  }
  const digestFile = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const payload = {
    schemaVersion: "1.0",
    candidateHash: await digestFile(candidatePath),
    anchorHashes: await Promise.all(anchorPaths.map(digestFile)),
    lockedCopy,
    ruleVersion: String(ruleVersion),
    modelPolicy: String(modelPolicy)
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
