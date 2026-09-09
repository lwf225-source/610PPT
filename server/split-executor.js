import { AsyncLocalStorage } from "node:async_hooks";
import { splitInputHash, retainContentCandidate } from "./content-candidates.js";
import { storageRevision, projectConflict } from "./project-repository.js";
import { assertCommittedSplit } from "../v2/server/split-completion.js";

export const splitExecutionContext = new AsyncLocalStorage();

export function createSplitExecutor({ dataDir, readDeck, readCommittedDeck = async () => null, readSource, analyzeDocument, analyzeContentOutline, writeDeck, getAiProviderFingerprint }) {
  async function validate(input) {
    if (getAiProviderFingerprint && input.aiProviderFingerprint !== getAiProviderFingerprint()) throw projectConflict("AI 接入设置已变化或旧任务缺少配置记录，请创建新的拆页任务");
    const current = await readDeck(input.projectSlug);
    if (!current || (current.project?.id || current.deckId) !== input.projectId
      || current.project?.slug !== input.projectSlug || storageRevision(current) !== input.expectedRevision
      || current.sourcePath !== input.sourcePath) throw projectConflict("项目、源文件或版本已变化，旧拆页任务不能继续覆盖");
    const source = await readSource(input.sourcePath);
    if (splitInputHash(source.text, input.styleProfile, input.typographyScale) !== input.inputHash) {
      throw projectConflict("源文件内容已变化，请按当前文档创建新的拆页任务");
    }
    return current;
  }
  async function reconcile(input) {
    let current = await readDeck(input.projectSlug);
    if (!current || (current.project?.id || current.deckId) !== input.projectId) return null;
    if (storageRevision(current) !== input.expectedRevision + 1 || current.splitExecution?.taskId !== input.taskId) current = await readCommittedDeck(input);
    const execution = current?.splitExecution;
    if (!execution || execution.taskId !== input.taskId || execution.inputHash !== input.inputHash || execution.baseRevision !== input.expectedRevision) return null;
    assertCommittedSplit(current, { ...input, targetPageCount: input.styleProfile?.targetPageCount });
    return { deck: current, candidateId: execution.candidateId || null, reconciled: true };
  }
  async function execute(input, context) {
    return splitExecutionContext.run(context, async () => {
      let candidateId = null;
      try {
        const current = await validate(input);
        const seed = analyzeDocument(input);
        const seedDeck = { ...seed, deckId: current.deckId, project: current.project, revision: current.revision,
          storageRevision: current.storageRevision, revisionHistory: current.revisionHistory, createdAt: current.createdAt };
        const deck = await analyzeContentOutline({ ...input, seedDeck, signal: context.signal, onProgress: context.emit });
        context.signal.throwIfAborted();
        candidateId = await retainContentCandidate(dataDir, { taskId: input.taskId, baseDeck: seedDeck, inputHash: input.inputHash, payload: deck.contentOutline });
        return await context.commit(async ({ beforeCommit } = {}) => {
          const saved = await writeDeck({ ...deck, ...(Object.hasOwn(current, "styleReference") ? { styleReference: current.styleReference } : {}), splitExecution: { taskId: input.taskId, inputHash: input.inputHash,
            baseRevision: input.expectedRevision, committedStorageRevision: input.expectedRevision + 1, candidateId } }, {
            revisionAction: "content-outline-v1", revisionNote: "持久拆页任务完成并原子提交",
            beforeCommit: async () => {
              context.signal.throwIfAborted();
              await beforeCommit?.();
            }
          });
          assertCommittedSplit(saved, { ...input, targetPageCount: input.styleProfile?.targetPageCount });
          return { deck: saved, candidateId };
        });
      } catch (error) { error.candidateId = candidateId; throw error; }
    });
  }
  return { validate, reconcile, execute };
}
