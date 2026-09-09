import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { selectChangedDerivedArtifacts } from "./derived-artifacts.js";
import { withProjectMutation, commitProjectSnapshot, writeFileAtomic, projectConflict } from "./project-repository.js";
import { consultingCopyBlocks } from "../shared/consulting-copy-ir.js";
import { deriveContentOutlineFromDeck } from "../shared/content-outline-ir.js";
import { applyMasterPackToDeck } from "../shared/master-packs.js";

// The writer owns the commit boundary; visual/QA services are explicit injected
// dependencies, never mutable module globals or an imported HTTP server.
// Both hooks run inside the repository lease. Sidecars remain derived artifacts;
// only the atomic deck.json replacement establishes a committed version.
export function createProjectWriter({ dataDir, ensureDataDir, projectDirFor, rel, compileDeckVisualSystem, normalizePageDesignSpec, buildExportManifest, reconcileGenerationJobs, buildQaReport, buildRevisionMetadata, buildImagePromptRecords, buildPromptMarkdown, imageGenerationProviderStatus, buildFinalImageMap, derivedWriteMode = "all", onProfile }) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new TypeError("Project writer requires an absolute dataDir");
  const dependencies = { ensureDataDir, projectDirFor, rel, compileDeckVisualSystem, normalizePageDesignSpec, buildExportManifest, reconcileGenerationJobs, buildQaReport, buildRevisionMetadata, buildImagePromptRecords, buildPromptMarkdown, imageGenerationProviderStatus, buildFinalImageMap };
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== "function") throw new TypeError(`Project writer dependency ${name} must be a function`);
  }
  if (!["all", "changed"].includes(derivedWriteMode)) throw new TypeError("Derived write mode must be all or changed");
  if (onProfile !== undefined && typeof onProfile !== "function") throw new TypeError("Project writer onProfile must be a function");
  const DATA_DIR = dataDir;
  return async function writeProjectArtifacts(deck, extras = {}) {
    const started = performance.now();
    await ensureDataDir();
    const projectDir = projectDirFor(deck);
    return withProjectMutation(projectDir, deck, async ({ current, nextStorageRevision }) => {
      const stagesMs = {};
      let checkpoint = performance.now();
      const transactionWaitMs = checkpoint - started;
      const lap = (stage) => { const now = performance.now(); stagesMs[stage] = now - checkpoint; checkpoint = now; };
      await extras.beforeBuild?.({ current, nextStorageRevision });
      if (extras.revisionAction === "save" && JSON.stringify(deck.contentOutline?.sourceDocument ?? null) !== JSON.stringify(current?.contentOutline?.sourceDocument ?? null)) {
        throw projectConflict("源文档登记表不能由编辑请求改写；请重新导入源文档后拆页");
      }
      if (extras.revisionAction === "save" && JSON.stringify(deck.splitExecution ?? null) !== JSON.stringify(current?.splitExecution ?? null)) {
        throw projectConflict("拆页执行记录不能由编辑请求改写");
      }
      if (extras.revisionAction === "save" && JSON.stringify(deck.historyRestore ?? null) !== JSON.stringify(current?.historyRestore ?? null)) {
        throw projectConflict("历史恢复记录不能由编辑请求改写");
      }
      if (extras.revisionAction === "save" && current) {
        for (const page of extras.submittedPages || deck.pages || []) {
          const previous = current.pages?.find((item) => item.id === page.id);
          if (previous?.copyBlueprint && JSON.stringify(previous.copyBlueprint) === JSON.stringify(page.copyBlueprint)
            && (previous.title !== page.title || JSON.stringify(previous.blocks) !== JSON.stringify(page.blocks))) {
            throw projectConflict("旧编辑器只修改了兼容文字，未更新咨询文案蓝图；请使用新版文案编辑器保存，原文未覆盖");
          }
        }
      }
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(path.join(projectDir, "final-images"), { recursive: true });
      await fs.mkdir(path.join(projectDir, "previews"), { recursive: true });
      await fs.mkdir(path.join(projectDir, "exports"), { recursive: true });
      lap("prepare");

      const copyLockedDeck = { ...deck, pages: (deck.pages || []).map((page) => page.copyBlueprint ? {
        ...page, title: page.copyBlueprint.title, blocks: consultingCopyBlocks(page.copyBlueprint), verbatimText: page.copyBlueprint.verbatimText
      } : page) };
      const shouldProjectCopy = (copyLockedDeck.pages || []).some((page) => page.copyBlueprint) || !copyLockedDeck.contentOutline;
      const compatibleDeck = shouldProjectCopy && copyLockedDeck.pages.length
        ? { ...copyLockedDeck, contentOutline: deriveContentOutlineFromDeck(copyLockedDeck) }
        : copyLockedDeck;
      lap("copyProjectionAndGrounding");
      const visuallyCompiledDeck = compileDeckVisualSystem(applyMasterPackToDeck(compatibleDeck));
      lap("visualCompile");
      const normalizedDeck = {
        ...visuallyCompiledDeck,
        pages: (visuallyCompiledDeck.pages || []).map((page) => ({
          ...page,
          designSpec: normalizePageDesignSpec(page.designSpec, page.pageType, page.visualPlan)
        }))
      };
      lap("normalizeDesign");
      const project = {
        id: normalizedDeck.project?.id || normalizedDeck.deckId,
        slug: deck.project?.slug || path.basename(projectDir),
        dir: rel(projectDir)
      };
      const exportManifest = extras.exportManifest || normalizedDeck.exportManifest || buildExportManifest(normalizedDeck);
      const reconciledGenerationJobs = reconcileGenerationJobs(normalizedDeck);
      const reconciledStyleAnchors = Object.fromEntries(
        Object.entries(normalizedDeck.styleAnchors || {}).map(([kind, anchor]) => {
          const job = anchor?.pageId ? reconciledGenerationJobs[anchor.pageId] : null;
          if (!anchor) return [kind, anchor];
          if (job?.status === "stale") {
            return [kind, {
              ...anchor,
              status: "stale",
              confirmedAt: null,
              updatedAt: new Date().toISOString()
            }];
          }
          // Self-heal: an anchor wrongly marked stale whose job recovered (image
          // still valid, contract unchanged) is restored so the flow is not stuck
          // in the anchor phase. The cover is an automatic anchor and returns to
          // "confirmed"; the content anchor stays a user decision ("generated").
          if (anchor.status === "stale" && job && ["generated", "imported"].includes(job.status)) {
            const assetPath = job.finalImage || anchor.assetPath;
            if (assetPath) {
              const restoredStatus = kind === "cover" ? "confirmed" : "generated";
              return [kind, {
                ...anchor,
                status: restoredStatus,
                assetPath,
                confirmedAt: restoredStatus === "confirmed" ? (anchor.confirmedAt || new Date().toISOString()) : null,
                updatedAt: new Date().toISOString()
              }];
            }
          }
          // The cover is an automatic anchor: once its image exists and the job is
          // healthy, it is auto-confirmed (only the content anchor needs a user).
          if (kind === "cover" && anchor.status === "generated"
            && (anchor.assetPath || job?.finalImage)
            && (!job || ["generated", "imported"].includes(job.status))) {
            return [kind, {
              ...anchor,
              status: "confirmed",
              assetPath: anchor.assetPath || job?.finalImage || null,
              confirmedAt: anchor.confirmedAt || new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }];
          }
          return [kind, anchor];
        })
      );
      const qaSourceDeck = {
        ...normalizedDeck,
        styleAnchors: reconciledStyleAnchors,
        generationJobs: reconciledGenerationJobs,
        exportManifest
      };
      lap("reconcileJobsAndAnchors");
      const qaReport = extras.qaReport || buildQaReport(qaSourceDeck, extras.imagePaths || []);
      lap("fullQa");
      const revisionMeta = buildRevisionMetadata(normalizedDeck, extras, exportManifest, qaReport);
      const enrichedDeck = {
        ...normalizedDeck,
        storageRevision: nextStorageRevision,
        project,
        version: revisionMeta.version,
        revision: revisionMeta.revision,
        updatedAt: revisionMeta.updatedAt,
        editability: revisionMeta.editability,
        revisionHistory: revisionMeta.revisionHistory,
        imagePrompts: buildImagePromptRecords(normalizedDeck),
        styleAnchors: reconciledStyleAnchors,
        generationJobs: reconciledGenerationJobs,
        qaReport,
        exportManifest,
        exportHistory: exportManifest.history || []
      };

      const projectBrief = {
        projectId: enrichedDeck.deckId,
        title: enrichedDeck.title,
        sourcePath: enrichedDeck.sourcePath,
        objective: "image2-first structured PPT workbench",
        route: "PageIR -> editableMode -> prompts/images -> QA -> PPTX",
        version: enrichedDeck.version,
        revision: enrichedDeck.revision,
        editability: enrichedDeck.editability,
        createdAt: enrichedDeck.createdAt,
        updatedAt: enrichedDeck.updatedAt
      };

      const json = (value) => JSON.stringify(value ?? null, null, 2);
      const artifacts = {
        "project_brief.json": json(projectBrief),
        "style_profile.json": json(enrichedDeck.styleProfile),
        "content_outline.json": json(enrichedDeck.contentOutline),
        "image2_render_plan.json": json(enrichedDeck.image2RenderPlan),
        "style_anchors.json": json(enrichedDeck.styleAnchors),
        "image2_visual_audit.json": json(enrichedDeck.image2VisualAudit),
        "typography_scale.json": json(enrichedDeck.typographyScale),
        "image_prompts.json": json(enrichedDeck.imagePrompts),
        "image_prompts.md": buildPromptMarkdown(enrichedDeck),
        "image_jobs.json": json({
        updatedAt: new Date().toISOString(),
        provider: imageGenerationProviderStatus(),
        jobs: Object.values(enrichedDeck.generationJobs || {})
        }),
        "image_sources.json": json(enrichedDeck.imageSources || []),
        "final_image_map.json": json(buildFinalImageMap(enrichedDeck)),
        "qa_report.json": json(enrichedDeck.qaReport),
        "export_manifest.json": json(enrichedDeck.exportManifest),
        "revision_history.json": json(enrichedDeck.revisionHistory || [])
      };
      lap("serializeArtifactsAndRevision");
      const selected = await selectChangedDerivedArtifacts(projectDir, artifacts, { mode: derivedWriteMode });
      lap("compareDerivedBytes");
      await commitProjectSnapshot(projectDir, enrichedDeck, selected.artifacts, { beforeCommit: extras.beforeCommit });
      lap("commitSnapshotAndArtifacts");
      // This compatibility index is not the commit point. Failure must not report
      // a failed save after the authoritative project version already committed.
      await writeFileAtomic(path.join(DATA_DIR, "latest-deck.json"), json(enrichedDeck)).catch((error) => console.warn("Latest deck index refresh failed:", error.message));
      lap("latestIndex");
      try { onProfile?.({ schemaVersion: "1.0", pageCount: enrichedDeck.pages?.length || 0, totalMs: performance.now() - started, transactionWaitMs, stagesMs, derivedArtifacts: selected.stats }); } catch { /* aggregate diagnostics cannot change a committed outcome */ }
      return enrichedDeck;
    });
};
}
