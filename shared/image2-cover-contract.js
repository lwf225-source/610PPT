import { image2Rules, IMAGE2_COVER_CONTRACT_VERSION } from './image2-rule-data.js';
export { IMAGE2_COVER_CONTRACT_VERSION } from './image2-rule-data.js';

export function isImage2CoverPage(page = {}) {
  // Authored page roles take precedence over a stale visual plan (including
  // legacy plans that still label P01 as cover after choosing no-cover mode).
  const role = page.pageRole || page.narrativeRole || page.copyBlueprint?.pageLogic || page.image2Plan?.masterRole || page.masterRole;
  return role ? role === "cover" : page.designSpec?.layoutKind === "cover";
}

export function image2CoverCopyPrompt() { return image2Rules.cover.copyPrompt; }
export function image2CoverDesignSpec() { return structuredClone(image2Rules.cover.designSpec); }
export function image2CoverVisualPrompt() {
  const spec = image2CoverDesignSpec();
  return [`【封面视觉契约 ${IMAGE2_COVER_CONTRACT_VERSION}】`, ...image2Rules.cover.visualBefore,
    spec.layout, spec.hierarchy, spec.visualTreatment, spec.spacing, ...image2Rules.cover.visualAfter].join("\n");
}
