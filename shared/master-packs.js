export const MASTER_PACK_ROLES = [
  "cover",
  "directory",
  "content",
  "data",
  "process",
  "conclusion"
];

const PACKS = [
  {
    id: "image2-dark-tactical",
    version: "1.0.0",
    label: "Image2 语义角色母版",
    styleIds: ["image2-dark-tactical", "image2-game-handdrawn", "image2-consulting-poster"],
    roles: {
      cover: { label: "封面", layouts: ["cover"] },
      directory: { label: "目录", layouts: ["agenda"] },
      content: { label: "正文", layouts: ["content-cards", "paired-grid", "comparison-grid"] },
      data: { label: "数据与图表", layouts: ["metrics-grid", "metric-flow", "cumulative-trend", "waterfall"] },
      process: { label: "流程与关系", layouts: ["process-flow", "timeline", "hub-spoke", "layered-architecture", "roadmap"] },
      conclusion: { label: "结论与收尾", layouts: ["conclusion"] }
    }
  }
];

export const MASTER_PACKS = Object.freeze(PACKS.map((pack) => Object.freeze({
  ...pack,
  roles: Object.freeze({ ...pack.roles })
})));

export function masterPackById(id) {
  return MASTER_PACKS.find((pack) => pack.id === id) || null;
}

export function masterPackForStyle(styleProfile = {}) {
  const styleId = styleProfile.templateId || styleProfile.id || "";
  return MASTER_PACKS.find((pack) => pack.styleIds.includes(styleId)) || MASTER_PACKS[0];
}

export function ensureMasterPackLock(styleProfile = {}) {
  const requested = masterPackById(styleProfile.masterPackId);
  const inferred = masterPackForStyle(styleProfile);
  const pack = requested || inferred;
  return {
    ...styleProfile,
    masterPackId: pack.id,
    masterPackVersion: pack.version,
    masterPackLabel: pack.label,
    masterPackLocked: true
  };
}

function roleFromPage(page = {}, index = 0, total = 1, styleProfile = {}) {
  const shouldCreateCover = styleProfile.coverMode !== "none";
  if ((index === 0 && shouldCreateCover) || page.narrativeRole === "cover" || page.pageType === "visual-poster") return "cover";
  const text = `${page.title || ""}\n${page.task || ""}\n${page.mainPoint || ""}\n${page.visualPlan || ""}`;
  if (page.narrativeRole === "takeaway" || index === total - 1 || /结论|总结|收尾|下一步|行动建议|展望/.test(text)) return "conclusion";
  if (page.pageType === "data-native" || /数据|指标|收入|增长|占比|预算|成本|趋势|表格/.test(text)) return "data";
  if (/流程|路径|阶段|时间线|关系|协同|架构|闭环|步骤|漏斗/.test(text)) return "process";
  if (/目录|议程|章节|解读路径/.test(text)) return "directory";
  return "content";
}

export function normalizeMasterRole(role) {
  return MASTER_PACK_ROLES.includes(role) ? role : "";
}

export function applyMasterPackRoles(pages = [], styleProfile = {}) {
  const lockedStyle = ensureMasterPackLock(styleProfile);
  const pack = masterPackById(lockedStyle.masterPackId) || masterPackForStyle(lockedStyle);
  return pages.map((page, index) => {
    const override = normalizeMasterRole(page.masterRoleOverride);
    const masterRole = override || roleFromPage(page, index, pages.length, lockedStyle);
    const roleSpec = pack.roles[masterRole] || pack.roles.content;
    return {
      ...page,
      masterRole,
      masterRoleSource: override ? "user" : "system",
      masterPackId: pack.id,
      masterPackVersion: pack.version,
      masterLayoutCandidates: [...roleSpec.layouts]
    };
  });
}

export function applyMasterPackToDeck(deck = {}) {
  const styleProfile = ensureMasterPackLock(deck.styleProfile || {});
  return {
    ...deck,
    styleProfile,
    masterPack: {
      id: styleProfile.masterPackId,
      version: styleProfile.masterPackVersion,
      label: styleProfile.masterPackLabel,
      locked: true
    },
    pages: applyMasterPackRoles(deck.pages || [], styleProfile)
  };
}

export function validateMasterPack(deck = {}) {
  const style = deck.styleProfile || {};
  const pack = masterPackById(style.masterPackId);
  const issues = [];
  if (!pack) return [{ id: "master-pack-missing", message: "项目没有锁定可用的母版套装" }];
  if (style.masterPackVersion !== pack.version) issues.push({ id: "master-pack-version-mismatch", message: "项目母版版本与当前可用版本不一致" });
  (deck.pages || []).forEach((page, index) => {
    if (!normalizeMasterRole(page.masterRole)) issues.push({ id: "page-master-role-missing", page, index, message: "页面没有母版角色" });
    if (page.masterPackId !== pack.id || page.masterPackVersion !== pack.version) issues.push({ id: "page-master-pack-mismatch", page, index, message: "页面没有使用项目锁定的母版版本" });
  });
  return issues;
}
