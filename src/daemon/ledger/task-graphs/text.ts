import { isTaskGraphReadyToFinish, taskNodeStatusText, truncateChars } from "../../../shared/domain.ts";
import type { TaskGraph, TaskNode } from "../../../shared/domain.ts";
import { GRAPH_TEXT_NODE_NOTE_CHARS, GRAPH_TEXT_NODE_WORKERS_MAX } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseJsonOr } from "./rows.ts";
import type { ProgressResult, TurnedStep } from "./types.ts";

export const collapseOneLine = (text: string, maxChars: number): string =>
  truncateChars(text.replace(/\s+/gu, " ").trim(), maxChars);

/** Escapes Markdown punctuation after truncation so a cut link or code span cannot leak into later lines. */
const clipNote = (text: string): string =>
  truncateChars(text.replace(/\s+/g, " ").trim(), GRAPH_TEXT_NODE_NOTE_CHARS)
    .replace(/[\\`*_[\]{}()<>~]/g, "\\$&");

function nodeResultLines(node: TaskNode): string[] {
  const lines: string[] = [];
  const { artifact, decision } = node;
  const refs: string[] = [];
  if (artifact?.branch) refs.push(`分支 ${clipNote(artifact.branch)}`);
  if (artifact?.commit) refs.push(`提交 ${clipNote(artifact.commit)}`);
  if (artifact?.prUrl) refs.push(`PR ${clipNote(artifact.prUrl)}`);
  if (artifact?.reviewVerdict) refs.push(`审查 ${artifact.reviewVerdict}`);
  if (artifact?.verifiedCommit) refs.push(`验证提交 ${clipNote(artifact.verifiedCommit)}`);
  if (refs.length > 0) lines.push(`      ${refs.join(" · ")}`);
  if (artifact?.summary) lines.push(`      摘要：${clipNote(artifact.summary)}`);
  if (decision !== null) {
    const note = decision.note ? `（${clipNote(decision.note)}）` : "";
    lines.push(`      定案：${decision.choice === null ? "没选选项" : clipNote(decision.choice)}${note}`);
  }
  return lines;
}

function nodeWorkerNote(node: TaskNode): string {
  if (node.activeWorkerId !== null) return ` · Worker #${node.activeWorkerId}`;
  if (node.workerIds.length === 0) return "";
  const recent = node.workerIds.slice(-GRAPH_TEXT_NODE_WORKERS_MAX);
  return ` · 经手${node.workerIds.length > recent.length ? "（最近的）" : ""} Worker ${recent.map((id) => `#${id}`).join("、")}`;
}

function graphStatusLabel(graph: Pick<TaskGraph, "status" | "nodes">): string {
  return isTaskGraphReadyToFinish(graph) ? "active · 待交付" : graph.status;
}

export function formatGraphText(graph: TaskGraph, results = true): string {
  const depMap = new Map<string, string[]>();
  for (const e of graph.edges) {
    let list = depMap.get(e.toKey);
    if (list === undefined) {
      list = [];
      depMap.set(e.toKey, list);
    }
    list.push(e.fromKey);
  }
  const lines = [`任务图 #${graph.id}「${graph.title}」（状态：${graphStatusLabel(graph)}）`];
  for (const n of graph.nodes) {
    const deps = depMap.get(n.key);
    const depNote = deps && deps.length > 0 ? ` ← [${deps.join(", ")}]` : "";
    const cardNote = n.gateQuestion !== null && n.decision === null && n.status !== "done" ? " [拍板卡]" : "";
    lines.push(
      `  - [${taskNodeStatusText(n, "pm")}] ${n.key}：${n.title}${cardNote}${nodeWorkerNote(n)}${depNote}`,
      ...(results ? nodeResultLines(n) : []),
    );
  }
  return lines.join("\n");
}

export function formatGraphBrief(graph: TaskGraph): string {
  const settled = graph.nodes.filter((n) => n.status === "done").length;
  return `任务图 #${graph.id}「${graph.title}」（状态：${graphStatusLabel(graph)}，进度 ${settled}/${graph.nodes.length}；详情用 ${HUB_COMMAND} graph show ${graph.id} 看）`;
}

export const turnedListText = (turned: readonly TurnedStep[]): string =>
  turned.map((u) => `${u.key} [${taskNodeStatusText({ status: "waiting", waitingFor: u.waitingFor, skipped: false }, "pm")}]`).join("、");

export function unlockedNoteOf(progress: ProgressResult, graph: TaskGraph): string {
  const parts: string[] = [];
  if (progress.dispatched.length > 0) {
    parts.push(`已自动开工：${progress.dispatched.map((d) => `${d.key}（Worker #${d.workerId}）`).join("、")}`);
  }
  for (const f of progress.dispatchFailed) {
    parts.push(
      `步骤「${f.key}」自动开工未成功（${f.reason}），已置为等你处理（换人：${HUB_COMMAND} worker start --node ${f.key} --graph ${graph.id} --vendor <别家>）`,
    );
  }
  for (const b of progress.userBlocked) {
    parts.push(`步骤「${b.key}」等用户动手：${b.note}（要换别家：${HUB_COMMAND} worker start --node ${b.key} --graph ${graph.id} --vendor <别家>）`);
  }
  if (progress.turned.length > 0) {
    const pmKeys = progress.turned.filter((u) => u.waitingFor === "pm").map((u) => u.key);
    const dispatch = pmKeys.length > 0 ? `（给它派 Worker：${HUB_COMMAND} worker start --node ${pmKeys[0]} --graph ${graph.id}）` : "";
    parts.push(`轮到了：${turnedListText(progress.turned)}${dispatch}`);
  }
  if (parts.length > 0) return `；${parts.join("；")}`;
  if (isTaskGraphReadyToFinish(graph)) {
    return `；全部节点已完成（待交付），验收交付后用 ${HUB_COMMAND} graph finish 结束任务图`;
  }
  return graph.status === "completed" ? "；整张任务图已全部完结！" : "";
}

export function gateChatMessageText(node: {
  title: string;
  gate_question: string | null;
  gate_options_json?: string | null;
  gate_summary_md: string | null;
  gate_recommended: string | null;
}): string {
  const parts = [node.gate_question ?? node.title];
  const opts = parseJsonOr<string[]>(node.gate_options_json ?? null, []);
  if (opts.length < 2 && node.gate_recommended !== null && node.gate_recommended !== "") {
    parts.push(`推荐方案：${node.gate_recommended}`);
  }
  if (node.gate_summary_md !== null && node.gate_summary_md !== "") parts.push(node.gate_summary_md);
  return parts.join("\n\n");
}

export function formatWorkerDecisionMessage(question: string, choice: string | null, note: string | null): string {
  const lines = [`【用户拍板】${question}`, `定案：${choice ?? "自定义答复"}`];
  if (note !== null && note.trim() !== "") lines.push(`补充说明：${note.trim()}`);
  return lines.join("\n");
}

export function formatCheckpointRejectionMessage(stepTitle: string, note: string | null): string {
  const detail =
    note !== null && note.trim() !== ""
      ? note.trim()
      : "用户点击了「打回」（未填写具体修改意见），请复查本步目标与产物，如有不清楚之处可在汇报的「问题」栏写明。";
  return [
    `【用户检查点打回】步骤「${stepTitle}」未通过用户检查点确认，请在当前工作目录和分支上按下面意见继续修改，改完验证后照常汇报：`,
    `修改意见：${detail}`,
  ].join("\n");
}

export function prStateLabelZh(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":
      return "开着";
    case "MERGED":
      return "已合并";
    case "CLOSED":
      return "已关闭";
    default:
      return state;
  }
}

export const workerIdList = (ids: readonly number[]): string => ids.map((id) => `#${id}`).join("、");
