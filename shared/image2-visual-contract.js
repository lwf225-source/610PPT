import { image2Rules, IMAGE2_VISUAL_CONTRACT_VERSION } from './image2-rule-data.js';
export { IMAGE2_VISUAL_CONTRACT_VERSION } from './image2-rule-data.js';
export function image2VisualContractPrompt() {
  return [`【正文视觉母版统一契约 ${IMAGE2_VISUAL_CONTRACT_VERSION}】`, ...image2Rules.body.visual].join("\n");
}
export function image2VisualAuditPrompt() {
  return [image2VisualContractPrompt(), ...image2Rules.body.audit].join("\n");
}
