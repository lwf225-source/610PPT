import { storageRevision, projectConflict } from "./project-repository.js";

// Restore authored content/configuration, not acceptance of mutable image paths.
// The old version is never written back as the new storage revision.
export function buildRestoredProject(historical, current) {
  const { deck: prior, revision, current: binding } = historical;
  if ((current.project?.id || current.deckId) !== binding.projectId || storageRevision(current) !== binding.storageRevision) throw projectConflict();
  return {
    ...structuredClone(prior), deckId: current.deckId, project: current.project,
    storageRevision: storageRevision(current), revision: current.revision, version: current.version,
    revisionHistory: current.revisionHistory, createdAt: current.createdAt,
    pages: prior.pages.map((page) => ({ ...page,
      regenerationPreviewImage: page.finalImage || page.regenerationPreviewImage || null,
      finalImage: null, imagePath: null, generationStatus: "stale", status: "draft",
      reviewStatus: "needs-review", reviewedAt: null, failureStage: null
    })),
    styleProfile: { ...prior.styleProfile, selectionStatus: "unconfirmed", styleLock: false },
    generationJobs: {}, images: [], imagePaths: [], styleAnchor: null, styleAnchors: {},
    image2RenderPlan: null, previousImage2RenderPlan: null, qaReport: null,
    exportManifest: null, exportHistory: [], splitExecution: null,
    historyRestore: { restoredAt: new Date().toISOString(), fromRevisionId: revision.revisionId,
      fromStorageRevision: revision.storageRevision, fromHash: revision.sha256,
      storageRevision: storageRevision(current) + 1 }
  };
}
