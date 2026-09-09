export const SPLIT_STAGES = ["理解原文", "规划页面", "编写文案", "检查并保存"];

export function splitStatus(task = {}, { connectionIssue = false } = {}) {
  task ||= {};
  const phase = String(task.phase || "");
  const raw = String(task.phaseMessage || "");
  const total = Number(task.input?.targetPageCount || task.total) || 0;
  const stage = /^(argument-map|source-extraction)/.test(phase) ? 1
    : /^(page-plan|planning)/.test(phase) ? 2
    : /^(authoring|content-outline)/.test(phase) ? 3
    : /^(copy-fluency|content-detail-review|validating|repairing|saving|pages|source-references|completed)/.test(phase) ? 4 : 0;
  const label = SPLIT_STAGES[stage - 1] || "准备任务";
  const descriptions = ["正在梳理原文重点和依据。", `正在安排${total ? ` ${total} 页` : "每页"}的标题、内容和前后顺序。`, "正在分组编写每页的展示文案。", "正在检查语句是否通顺、修正生硬表达，通过后保存页面。"];
  let title = `正在${label}`;
  let detail = raw.replace(/^[a-z][a-z\d-]*[：:]\s*/i, "");
  if (!detail || /模型请求已开始|已初始化模型会话/.test(detail)) detail = descriptions[stage - 1] || "正在创建任务，稍后会显示具体进度。";
  else if (/模型返回，正在进行内容校验/.test(detail)) detail = "已收到本阶段结果，正在检查内容。";
  else if (/已开始生成/.test(detail)) detail = "已开始执行。" + (descriptions[stage - 1] || "等待模型返回进度。");
  detail = detail.replace(/论证地图/g, "原文要点").replace(/Codex/g, "AI").replace(/PagePlan/g, "页面规划").replace(/（不是完成进度）/g, "");
  detail = detail.replace(/（整套计划已锁定，分组不改变叙事）|（此阶段不受页数限制）/g, "");
  if (/repair/.test(phase)) detail = `正在修正${label}阶段发现的问题；通过检查后继续。`;
  let mode = "running";
  if (phase === "starting" || phase === "queued" || task.status === "queued" || /等待本地执行空位|已排队/.test(raw)) {
    mode = "waiting"; title = /等待本地执行空位|已排队/.test(raw) ? "等待本地执行" : "任务排队中";
    detail = title === "等待本地执行" ? `当前还未开始本阶段计算；有空位后自动开始。${raw.match(/已排队\s*\d+\s*秒/)?.[0] || ""}` : "任务已提交，正在等待执行。";
  }
  if (task.status === "failed") {
    mode = "failed";
    title = "拆页未完成";
    detail = "本次执行未完成，已保留原文与检查点。请检查本地 Codex 或 API 设置后继续拆页。";
  } else if (["cancelled", "paused"].includes(task.status)) {
    mode = task.status; title = task.status === "cancelled" ? "拆页已取消" : "拆页已暂停";
    detail = "原文与已完成的检查点已保留，可点击「继续拆页」。";
  } else if (task.cancelRequested || phase === "cancelling") {
    mode = "waiting"; title = "正在停止拆页"; detail = "取消请求已发送，正在等待执行端确认。";
  } else if (task.status === "completed") {
    mode = "completed"; title = "整套文案已就绪"; detail = "全部页面已生成并保存，可以查看和修改。";
  } else if (connectionIssue) {
    mode = "waiting"; title = "正在恢复进度连接"; detail = "暂时收不到最新状态，后台任务可能仍在运行，请勿重复提交。";
  }
  return { stage, label, title, detail, mode };
}

export function splitElapsedLabel(task, now = Date.now()) {
  // Old task creation time includes failures and idle time. Never use it as an attempt clock.
  const started = Date.parse(task?.attemptStartedAt || "");
  if (!Number.isFinite(started)) return "正在读取本轮用时";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `本轮已用时 ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}（含排队）`;
}
