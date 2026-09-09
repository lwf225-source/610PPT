export const IMAGE2_LAYOUT_RULES = Object.freeze({
  cover: "封面、开场或单一主视觉",
  statement: "一个核心判断和少量关键词",
  "topic-grid": "3-5 个并列短主题",
  "paired-grid": "2-4 个模块及其说明",
  "layered-architecture": "三层架构、能力底座或层级关系",
  "metric-flow": "3-4 个指标构成的传导链",
  "cause-effect": "一个原因指向一个结果",
  conclusion: "一个结论和必要依据",
  agenda: "目录或阅读路径",
  "content-cards": "按内容关系组织的信息模块",
  timeline: "有顺序的阶段或步骤",
  pyramid: "递进判断和依据",
  "comparison-grid": "有共同维度的对比",
  "metrics-grid": "核心指标和数据解读",
  "cumulative-trend": "连续阶段或时间点的数据趋势",
  waterfall: "起点、增减因素和结果",
  "process-flow": "线性步骤和结果解释",
  funnel: "逐层收敛的阶段或转化步骤",
  "quadrant-text": "四象限框架",
  roadmap: "里程碑或阶段目标",
  "hub-spoke": "中心主题和外围能力",
  "vertical-pillars": "平行支柱",
  "org-tree": "上下级组织、目标或能力",
  "journey-map": "阶段、行为、问题和机会",
  "responsibility-matrix": "事项、主责、协同和交付物"
});

export const IMAGE2_LAYOUT_KINDS = Object.freeze(Object.keys(IMAGE2_LAYOUT_RULES));

const ITEM_LIMITS = Object.freeze({ cover: [0, 8], statement: [1, 5], "topic-grid": [3, 5], "paired-grid": [2, 4],
  "layered-architecture": [3, 3], "metric-flow": [3, 4], "cause-effect": [2, 2], conclusion: [1, 4], agenda: [3, 6],
  timeline: [3, 7], pyramid: [3, 4], "comparison-grid": [2, 4], "metrics-grid": [2, 4], "cumulative-trend": [3, 5],
  waterfall: [3, 6], "process-flow": [3, 6], funnel: [3, 5], "quadrant-text": [4, 4], roadmap: [4, 7],
  "hub-spoke": [4, 6], "vertical-pillars": [3, 5], "org-tree": [3, 6], "journey-map": [3, 5], "responsibility-matrix": [3, 5] });

export function image2ContentBudget(layoutKind = "content-cards") {
  const [itemMin, itemMax] = ITEM_LIMITS[layoutKind] || [1, 6];
  return { titleMaxUnits: layoutKind === "cover" ? 38 : 30, subtitleMaxUnits: layoutKind === "cover" ? 68 : 52,
    conclusionMaxUnits: layoutKind === "conclusion" ? 82 : layoutKind === "cover" ? 0 : 72,
    itemMin, itemMax, itemTitleMaxUnits: 18, itemBodyMaxUnits: 76,
    centerTitleMaxUnits: ["hub-spoke", "org-tree"].includes(layoutKind) ? 18 : null,
    centerBodyMaxUnits: layoutKind === "hub-spoke" ? 38 : null };
}

export function image2LayoutPromptGuide() {
  return Object.entries(IMAGE2_LAYOUT_RULES).map(([id, usage]) => `- ${id}: ${usage}`).join("\n");
}
