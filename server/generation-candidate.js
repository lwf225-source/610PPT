import fs from "node:fs/promises";
import { AsyncResource } from "node:async_hooks";
import { qaCandidateIdentity, buildGenerationQaFingerprint, createGenerationQaQueue } from "./generation-qa-queue.js";
import { IMAGE2_VISUAL_CONTRACT_VERSION } from "../shared/image2-visual-contract.js";

const fail = (message) => Object.assign(new Error(message), { code: "IMAGE2_VISUAL_MASTER_CANDIDATE_CHANGED", statusCode: 409 });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const RULE_VERSION = `visual-master-locked-copy-${IMAGE2_VISUAL_CONTRACT_VERSION}`;
const MODEL_POLICY = "configured-visual-master-auditor-fresh-no-cache";
// Normal batches and explicit QA-only recoveries share this process-wide lane.
// A recovery request cannot create three additional concurrent audit calls.
const auditQueue = createGenerationQaQueue({ totalConcurrency: 1, qaConcurrency: 1 });

export function lockedCopyForGenerationPage(deck, job) {
  const page = (deck.pages || []).find((item) => item.id === job.pageId && (!item.pageNo || item.pageNo === job.pageNo));
  if (!page) throw fail("候选图对应页面身份已变化，请重新生成");
  const planned = deck.image2RenderPlan?.pages?.find((item) => item.pageNo === job.pageNo);
  const copy = page.verbatimText || page.copyBlueprint?.verbatimText || planned?.visibleText;
  if (!Array.isArray(copy) || !copy.length || !copy.every((item) => typeof item === "string") || !copy.some((item) => item.trim())) throw fail("页面缺少锁定文案，候选图不能通过校验");
  return copy;
}

async function assertImage(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw fail("候选图或母版不是普通图像文件");
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    const valid = bytesRead >= 8 && (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (header[0] === 255 && header[1] === 216 && header[2] === 255)
      || header.subarray(0, 6).toString().startsWith("GIF8")
      || (header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP"));
    if (!valid) throw fail("候选图或母版没有可识别的图像字节，不能恢复");
  } finally { await handle.close(); }
}

/** Immutable evidence about exactly which image/master/copy was submitted to
 * QA. A path, prompt filename, mtime or a previous passed flag is insufficient.
 */
export async function captureGenerationCandidate({ deck, job, result, resolvePath = (value) => value }) {
  const projectId = deck.project?.id || deck.deckId;
  const projectSlug = deck.project?.slug || deck.projectSlug;
  if (!projectId || !projectSlug || !job.pageId || !job.pageNo || !job.promptHash || !result?.imagePath || !job.contentAnchorReferencePath) throw fail("候选图缺少项目、页面或生成输入绑定，请重新生成");
  const lockedCopy = lockedCopyForGenerationPage(deck, job);
  const candidatePath = resolvePath(result.imagePath);
  const anchorPath = resolvePath(job.contentAnchorReferencePath);
  await Promise.all([assertImage(candidatePath), assertImage(anchorPath)]);
  const identity = qaCandidateIdentity(job);
  const fingerprint = await buildGenerationQaFingerprint({ candidatePath, anchorPaths: [anchorPath], lockedCopy, ruleVersion: RULE_VERSION, modelPolicy: MODEL_POLICY });
  return { status: "pending", identity, result, binding: { version: 1, projectId, projectSlug, pageId: job.pageId, pageNo: job.pageNo, identity, imagePath: result.imagePath, anchorPath: job.contentAnchorReferencePath, fingerprint } };
}

export async function verifyGenerationCandidate({ deck, job, candidate, resolvePath }) {
  if (!candidate?.binding || !same(candidate.identity, qaCandidateIdentity(job))) throw fail("候选图属于旧版或不同生成输入，不能猜测归属，请重新生成");
  const current = await captureGenerationCandidate({ deck, job, result: candidate.result, resolvePath });
  if (!same(current.binding, candidate.binding)) throw fail("候选图片、母版、锁定文案或项目身份已变化，已阻止恢复绑定");
  return current;
}

export async function auditGenerationCandidate({ deck, job, candidate, audit, resolvePath }) {
  return auditQueue.run("qa", AsyncResource.bind(async () => {
  await verifyGenerationCandidate({ deck, job, candidate, resolvePath });
  if (typeof audit !== "function") throw fail("正文视觉母版校验器不可用");
  const result = await audit({ deck, pageNo: job.pageNo, title: job.title || "", anchorPageNo: job.contentAnchorPageId,
    anchorPath: job.contentAnchorReferencePath, candidatePath: candidate.result.imagePath, lockedCopy: lockedCopyForGenerationPage(deck, job) });
  if (typeof result?.passed !== "boolean") throw new Error("Invalid audit response: missing passed boolean");
  // Audit itself is asynchronous: reject bytes/copy changed while it ran.
  await verifyGenerationCandidate({ deck, job, candidate, resolvePath });
  const review = result.reviewRequired === true || result.decision === "review";
  return { ...candidate, status: review ? "error" : result.passed ? "passed" : "rejected", audit: result };
  }));
}

export async function assertGenerationCandidateAccepted(options) {
  if (options.candidate?.status !== "passed" || options.candidate?.audit?.passed !== true
    || options.candidate?.audit?.reviewRequired === true || options.candidate?.audit?.decision === "review") throw fail("候选图未通过实际校验，不能绑定最终图片");
  await verifyGenerationCandidate(options);
}
