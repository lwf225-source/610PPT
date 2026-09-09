import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { projectConflict, storageRevision } from "./project-repository.js";

export function splitInputHash(text, styleProfile, typographyScale) {
  return crypto.createHash("sha256").update(JSON.stringify({ text, styleProfile, typographyScale })).digest("hex");
}

export async function retainContentCandidate(dataDir, { taskId, baseDeck, inputHash, payload }) {
  const candidateId = crypto.randomUUID();
  const dir = path.join(dataDir, "content-candidates");
  await fs.mkdir(dir, { recursive: true });
  const candidate = {
    candidateId, taskId, projectId: baseDeck.project?.id || baseDeck.deckId,
    projectSlug: baseDeck.project?.slug, sourcePath: baseDeck.sourcePath,
    baseRevision: storageRevision(baseDeck), inputHash, payload,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(dir, `${candidateId}.json`), JSON.stringify(candidate), { flag: "wx" });
  return candidateId;
}

export async function loadContentCandidate(dataDir, { candidateId, taskId, deck, inputHash }) {
  if (!/^[a-f0-9-]{36}$/.test(String(candidateId || "")) || !taskId || !inputHash) {
    throw projectConflict("候选缺少任务与来源绑定，不能直接恢复任意旧 JSON；请重新拆页");
  }
  const candidate = JSON.parse(await fs.readFile(path.join(dataDir, "content-candidates", `${candidateId}.json`), "utf8"));
  if (candidate.taskId !== taskId || candidate.projectId !== (deck.project?.id || deck.deckId)
    || candidate.projectSlug !== deck.project?.slug || candidate.sourcePath !== deck.sourcePath
    || candidate.baseRevision !== storageRevision(deck) || candidate.inputHash !== inputHash) {
    throw projectConflict("候选的来源、配置或项目版本已变化，已阻止恢复覆盖");
  }
  return candidate;
}
