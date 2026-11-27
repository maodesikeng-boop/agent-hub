import { isTaskGraphReadyToFinish, taskNodeStatusText, truncateChars } from "../../../shared/domain.ts";
import type { TaskGraph, TaskNode } from "../../../shared/domain.ts";
import { GRAPH_TEXT_NODE_NOTE_CHARS, GRAPH_TEXT_NODE_WORKERS_MAX } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { formatStepAgentConfig, type StepAgentFormatContext } from "./step-agent-label.ts";
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

export function formatGraphText(graph: TaskGraph, results = true, agentContext?: StepAgentFormatContext, wait?: { since: number; now: number }): string {
  const depMap = new Map<string, string[]>();
  for (const e of graph.edges) {
    let list = depMap.get(e.toKey);
    if (list === undefined) {
      list = [];
      depMap.set(e.toKey, list);
    }
    list.push(e.fromKey);
  }
  const lines = [`任务图 #${graph.id}「${graph.title}」（状态：${graph.status}）`];
  for (const n of graph.nodes) {
    const deps = depMap.get(n.key);
    const depNote = deps && deps.length > 0 ? ` ← [${deps.join(", ")}]` : "";
    const cardNote = n.gateAskPending ? ` [拍板卡] #${n.gateAskMessageId}` : "";
    const settings = agentContext === undefined ? null : formatStepAgentConfig(n, agentContext);
    lines.push(
      `  - [${taskNodeStatusText(n, "pm")}] ${n.key}：${n.title}${cardNote}${nodeWorkerNote(n)}${nodeSlotNote(n)}${depNote}`,
      ...(settings === null ? [] : [`      ${settings}`]),
      ...(results ? nodeResultLines(n) : []),
    );
  }
  if (isTaskGraphReadyToFinish(graph)) {
    const minutes = wait === undefined ? null : Math.max(0, Math.floor((wait.now - wait.since) / 60_000));
    const age = minutes === null ? "" : `（已等 ${minutes} 分钟）`;
    const watch = graph.deliveryWatch;
    lines.push(watch === undefined
      ? `  - [等你验收交付] 交付：图里画的步骤都做完了${age}`
      : `  - [在等] 交付：在等 #${watch.watchId}「${watch.body}」`);
  }
  return lines.join("\n");
}

type SlotHolderRef = { graphId: number; nodeKey: string; workerId: number | null };

const slotHolderText = (holder: SlotHolderRef): string =>
  `图 #${holder.graphId} 的 ${holder.nodeKey}${holder.workerId === null ? "" : `（Worker #${holder.workerId}）`}`;

export type SlotHeldOutcome =
  | { kind: "start" | "pm" }
  | { kind: "attached" }
  | { kind: "resume"; workerId: number }
  | { kind: "not_queued"; reasons: readonly string[] };

/** The outcome says what happens when the slot frees: the step starts by its brief, the PM is asked to start it, or nothing was queued or sent. */
export function slotHeldText(
  nodeKey: string,
  queue: { slot: string; position?: number; holder: SlotHolderRef },
  then: SlotHeldOutcome,
): string {
  const head = `步骤「${nodeKey}」要用名额「${queue.slot}」，现在被${slotHolderText(queue.holder)}占着`;
  switch (then.kind) {
    case "attached":
      return `${head}；这一步还挂着 Worker，名额空出来以前不能换人，这次没有派 Worker`;
    case "resume":
      return `${head}；名额空出来以前 Worker #${then.workerId} 不能接着做，这次没有发给它`;
    case "not_queued":
      return `${head}；这次带了排队时带不走的东西（${then.reasons.join("、")}），所以没有派也没有排队；名额空出来后再派，或者去掉这些让它按步骤设定排队`;
    default:
      return `${head}；已排在第 ${queue.position ?? 1} 位，空出来${then.kind === "start" ? "自动开工" : "会叫你派 Worker"}。`;
  }
}

function nodeSlotNote(node: TaskNode): string {
  if (node.slotQueue !== undefined) return ` · 第 ${node.slotQueue.position} 位，前面是${slotHolderText(node.slotQueue.holder)}`;
  return node.slot != null && node.status === "running" ? ` · 占着名额 ${node.slot}` : "";
}

export const turnedListText = (turned: readonly TurnedStep[]): string =>
  turned.map((u) => `${u.key} [${taskNodeStatusText({ status: "waiting", waitingFor: u.waitingFor, skipped: false }, "pm")}]${u.question === undefined ? "" : `：${u.question}`}`).join("、");

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
  for (const q of progress.queued) parts.push(slotHeldText(q.key, q, { kind: q.then }).replace(/。$/u, ""));
  if (progress.turned.length > 0) {
    const pmKeys = progress.turned.filter((u) => u.waitingFor === "pm").map((u) => u.key);
    const dispatch = pmKeys.length > 0 ? `（给它派 Worker：${HUB_COMMAND} worker start --node ${pmKeys[0]} --graph ${graph.id}）` : "";
    parts.push(`轮到了：${turnedListText(progress.turned)}${dispatch}`);
  }
  if (isTaskGraphReadyToFinish(graph)) {
    parts.push(`图里画的步骤都做完了，验收交付后用 ${HUB_COMMAND} graph finish 结束任务图`);
  }
  if (parts.length > 0) return `；${parts.join("；")}`;
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
