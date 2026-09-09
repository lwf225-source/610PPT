import { sourceOnlyContentPrompt } from "./narrative-contracts.js";
import { editorialRule } from "./editorial-rule-runtime.js";

export const CONTENT_DETAIL_CONTRACTS = {
  focus: {
    id: "focus",
    name: "重点展示",
    description: "保留原文核心信息、关键数字和必要依据",
    titleRule: "标题准确提炼原文已有的核心信息；原文明确给出判断或结论时才可使用，不新增变化、评价或行动。",
    informationRule: "每页先保留主题、核心事实、关键数字和必要依据；时间、对象、统计口径、适用条件中影响原意的部分必须保留。分项数据、过程细节、原文解释和案例只选理解主题所必需的部分，其余可省略；不规定最低条数。",
    writingRule: "短句优先，避免完整复述源文档；避免同一事实重复出现，不用口号或近义句补满页面。"
  },
  detailed: {
    id: "detailed",
    name: "详细展示",
    description: "保留背景、过程、证据和适用条件",
    titleRule: "标题优先准确概括本页主题或对象，不强制每页都写成口号式结论；原文已有的核心信息放在 mainPoint 或相应内容模块中。",
    informationRule: "以读者不靠现场讲解也能读懂为目标。每页先保留主题、核心事实、关键数字、必要依据及影响原意的时间、对象、统计口径和适用条件，再保留与本页主题相关的原文解释、背景、过程步骤、例子、反馈与结果。先在内部梳理核心信息、相关展开及其他页已讲过的内容，再选择版式；不能先套固定卡片，再把解释削成标签。原文没有的原因、条件、过程或结果不补写。",
    writingRule: "要点配完整解释，允许完整句子和可独立阅读的短段落；用原文已有的动作、对象和条件说清事情，不要求每句缩成十几个字。模块标题负责概括，body或items保留相关展开，不把全部信息挤进headline后让正文留空。按原文关系选择分项、步骤、表格或短段，先删重复表达、装饰性总结和低相关信息，再压缩措辞；不得缩小字号或增加页面数量。"
  }
};

export const ALL_CONTENT_DETAIL_MODES = Object.freeze(Object.keys(CONTENT_DETAIL_CONTRACTS));
export const DEFAULT_CONTENT_DETAIL_MODE = "focus";

export function normalizeContentDetailMode(mode = DEFAULT_CONTENT_DETAIL_MODE) {
  return ALL_CONTENT_DETAIL_MODES.includes(mode) ? mode : DEFAULT_CONTENT_DETAIL_MODE;
}

export function contentDetailContractFor(mode = DEFAULT_CONTENT_DETAIL_MODE) {
  return CONTENT_DETAIL_CONTRACTS[normalizeContentDetailMode(mode)];
}

export function contentDetailContractPrompt(mode = DEFAULT_CONTENT_DETAIL_MODE, narrativeMode = "") {
  const cloud = editorialRule('contentDetailContracts', normalizeContentDetailMode(mode), narrativeMode || 'narrative');
  if (cloud !== null) return cloud;
  const contract = contentDetailContractFor(mode);
  const pairRules = contract.id === "detailed" && String(narrativeMode || "").trim() === "narrative"
    ? [
      "故事推进 x 详细展示的组合规则：详细版可保留更多原文已有的事件细节；原文缺失的阶段直接跳过，不补齐事件链。",
      "阶段信息取舍：仅在原文已有时保留人物与目标、问题、动作与反馈、变化、步骤、结果或经验；不新增因果、规则、边界或下一步。",
      "原文锚点要求：sourceExcerpt 按本页实际内容提供，不设置每阶段最低条数；不得为凑条数重复引用或新增信息。",
      "受控扩容：版式容量允许时，可按原文实际信息增加短句、步骤、数据或条件槽位；每个新增槽位必须承载新的原文事实，不得只拉长原句。容量不足时改用更合适的版式或合并次要信息。"
    ]
    : [];
  return [
    sourceOnlyContentPrompt(),
    `内容详略模式必须为 ${contract.id}（${contract.name}）。`,
    `标题规则：${contract.titleRule}`,
    `信息取舍：${contract.informationRule}`,
    `表达规则：${contract.writingRule}`,
    ...(contract.id === "detailed" ? [
      "逐页原文对照：原文有过程，检查是否只剩结论；有条件，检查是否只剩动作；有例子，检查是否只剩抽象概念；有解释，检查是否只剩标签。补回与本页主题相关且未在其他页完整表达的重要展开，保持页数、主题分工和原文事实不变。",
      "示例：原文为‘玩家正面火力太强，就不要硬撞，换猫道或者侧路’，详细文案应保留‘玩家正面火力太强时，Bot 不再硬撞，而是换走猫道或侧路’的条件和动作关系，不只写‘灵活换路’。示例仅解释写法，不得带入无关项目。",
      "详细验收不按字数、模块数或增量比例评分。原文本来很短时允许保持简短；不增加同义句，不补人员比例、触发阈值、时长等原文没有的信息。封面仍只使用标题组，不以详细为由塞入正文。",
      "可选字段不自动填满：example必须是正文之外的具体例子，evidence必须提供新的依据，bottomTakeaways必须有独立的原文信息；若只复述modules、lead或其他位置已经讲过的步骤、做法和结果，返回空字符串或空数组。详细信息集中在真正需要解释的模块正文里。"
    ] : []),
    ...pairRules,
    "两种详略都删除重复表达和装饰性总结，不删除必要限定条件；原文信息本来很少时允许两种结果接近，不为制造差异补写。",
    "先决定本页保留哪些原文信息，再选择模块和短段；模块数仅是容量上限，不是内容指标。优先保持主题覆盖和讲述关系，详略不单独改变页数、阶段顺序或为全文另立主题。",
    "硬约束：内容详略模式不得改变目标总页数、封面/目录/结尾页策略、每页可读容量、字号层级或版式槽位上限；详细展示可在容量安全时增加结构化槽位和原文事实，重点展示是主动取舍，不是生成空泛口号。"
  ].join("\n");
}

export function validateContentDetailStructure(
  pages = [],
  mode = DEFAULT_CONTENT_DETAIL_MODE,
  narrativeMode = ""
) {
  // Detail changes retention, not the amount of source material a document must have.
  // Source membership and semantic support belong to the source-content validator;
  // imposing excerpt quotas here would make short source passages trigger expansion.
  return {
    valid: true,
    mode: normalizeContentDetailMode(mode),
    narrativeMode: String(narrativeMode || "").trim(),
    issues: []
  };
}

export function contentDetailSummary(mode = DEFAULT_CONTENT_DETAIL_MODE) {
  const contract = contentDetailContractFor(mode);
  return `${contract.name} · ${contract.description}`;
}
