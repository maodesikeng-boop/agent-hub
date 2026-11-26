import { truncateChars } from "./domain.ts";
import { PM_AGENDA_DELTA_LINES_MAX, PM_AGENDA_DELTAS_PER_SNAPSHOT, PM_AGENDA_GRAPHS_MAX, PM_AGENDA_LABEL_MAX_CHARS, PM_AGENDA_STEP_LINES_MAX } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";
import type { PmId, TaskGraphId, TaskNodeKey, WorkerId } from "./domain.ts";
import type { PmWatchId, PmWatchStatus } from "./pm-watch.ts";

export type AgendaStepState =
  | { kind: "running"; workerId: WorkerId | null; slot: string | null }
  | { kind: "waiting_pm"; reason: string }
  | { kind: "waiting_user"; reason: string }
  | { kind: "queued_slot"; slot: string; position: number; holder: { graphId: TaskGraphId; nodeKey: TaskNodeKey; workerId: WorkerId | null } };

export interface AgendaStepLine {
  key: TaskNodeKey;
  title: string;
  state: AgendaStepState;
  since: number;
}

export interface AgendaGraphBlock {
  graphId: TaskGraphId;
  title: string;
  stepCount: number;
  doneCount: number;
  pendingCount: number;
  doneKeys?: readonly TaskNodeKey[];
  /** Every step is done and the graph is still active: it waits for the PM to deliver. */
  readyToFinish: boolean;
  /** Running, waiting, and queued steps only; done and not-started steps are counted, not listed. */
  steps: AgendaStepLine[];
  watchId: PmWatchId | null;
  needsPm: boolean;
  oldestNeedsPmSince: number | null;
}

export type AgendaOutsideItem =
  | { kind: "worker_report"; workerId: WorkerId; title: string; outcome: "done" | "problem" | "gave_up" | "unparsed" | "turn_failed"; since: number }
  | { kind: "watch"; watchId: PmWatchId; body: string; status: PmWatchStatus; since: number; graphId: TaskGraphId | null; workerId: WorkerId | null };

export interface PmAgenda {
  pmId: PmId;
  at: number;
  /** Graphs that need the PM first, oldest wait first; then the rest by most recent change. */
  graphs: AgendaGraphBlock[];
  omittedGraphs: number;
  outside: AgendaOutsideItem[];
  userCards: number;
}

/** One line the PM reads, keyed for diffing. `ref` is stable per item and includes when its current state began. */
export interface AgendaLine {
  ref: string;
  needsPm: boolean;
  text: string;
}

export interface AgendaCounts {
  needsPm: number;
  running: number;
  queued: number;
  watching: number;
  userCards: number;
  oldestNeedsPmSince: number | null;
}

export type AgendaChange =
  | { op: "add"; line: AgendaLine }
  | { op: "change"; before: AgendaLine; after: AgendaLine }
  | { op: "remove"; line: AgendaLine };

/** What one PM session has already received; advanced only after the driver reports the message written. */
export interface AgendaCursor {
  version: number;
  lines: AgendaLine[];
  deltasSinceSnapshot: number;
  deliveredAt: number;
}

export type AgendaFooter =
  | { kind: "none" }
  | { kind: "snapshot"; version: number; lines: AgendaLine[]; text: string; compactionId?: number }
  | { kind: "delta"; version: number; lines: AgendaLine[]; changes: AgendaChange[]; text: string; compactionId?: number }
  | { kind: "unchanged"; version: number; lines: AgendaLine[]; text: string };

export const PM_AGENDA_PREAMBLE_HEADING = "## 该你做的（账本实时状态；和上面的交接或记录冲突时以这里为准）";

export const PM_AGENDA_BUSY_LINE = "【用户在你还在干活时发来这条；回复的最后一段直接回答它】";

const timeOf = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const agendaLabel = (text: string): string =>
  truncateChars(text.replace(/\s+/gu, " ").trim(), PM_AGENDA_LABEL_MAX_CHARS);

export const readyAgendaRef = (id: TaskGraphId, since: number): string => `graph:${id}:ready@${since}`;

const atSince = (since: number | null): string => since === null ? "" : `（${timeOf(since)} 起）`;

function stepText(step: AgendaStepLine): string {
  const s = step.state;
  switch (s.kind) {
    case "running":
      return ["在跑", s.workerId === null ? "" : `Worker #${s.workerId}`, s.slot === null ? "" : `占着名额 ${s.slot}`].filter(Boolean).join("，");
    case "waiting_pm":
      return `等你处理${s.reason ? `，${agendaLabel(s.reason)}` : ""}${atSince(step.since)}`;
    case "waiting_user":
      return `等用户${s.reason ? `，${agendaLabel(s.reason)}` : ""}${atSince(step.since)}`;
    case "queued_slot":
      return `排队等名额 ${s.slot}（第 ${s.position} 位，被图 #${s.holder.graphId} 的 ${s.holder.nodeKey} 占着）`;
  }
}

function graphHeading(graph: AgendaGraphBlock): string {
  const label = `图 #${graph.graphId}「${agendaLabel(graph.title)}」`;
  if (graph.readyToFinish) {
    const state = graph.watchId === null ? "全部做完，等你验收交付" : `在盯 #${graph.watchId}`;
    return `${label}${graph.stepCount} 个步骤 · ${state}${atSince(graph.oldestNeedsPmSince)}`;
  }
  const tags: string[] = [];
  for (const [kind, label] of [["waiting_pm", "要你处理"], ["running", "在跑"], ["waiting_user", "等用户"], ["queued_slot", "排队"]] as const) {
    const count = graph.steps.filter((step) => step.state.kind === kind).length;
    if (count > 0) tags.push(`${label} ${count} 个`);
  }
  if (graph.doneCount > 0) tags.push(`完了 ${graph.doneCount} 个`);
  if (graph.pendingCount > 0) tags.push(`没轮到 ${graph.pendingCount} 个`);
  return `${label}${graph.stepCount} 个步骤${tags.length === 0 ? "" : ` · ${tags.join(" · ")}`}`;
}

function outsideLine(item: AgendaOutsideItem): AgendaLine {
  if (item.kind === "watch") {
    return { ref: `watch:${item.watchId}@${item.since}`, needsPm: false, text: `在盯 #${item.watchId}「${agendaLabel(item.body)}」${atSince(item.since)}` };
  }
  const outcome = {
    done: "汇报做完了，等你验收", problem: "汇报有问题，等你处理", gave_up: "汇报放弃了，等你处理",
    unparsed: "汇报没按格式，等你处理", turn_failed: "本轮失败，等你处理",
  }[item.outcome];
  return { ref: `worker:${item.workerId}@${item.since}`, needsPm: true, text: `Worker #${item.workerId}「${agendaLabel(item.title)}」${outcome}${atSince(item.since)}` };
}

export function agendaLinesOf(agenda: PmAgenda): AgendaLine[] {
  const lines: AgendaLine[] = [];
  for (const graph of agenda.graphs.slice(0, PM_AGENDA_GRAPHS_MAX)) {
    const prefix = `graph:${graph.graphId}`;
    lines.push({
      ref: graph.readyToFinish ? readyAgendaRef(graph.graphId, graph.oldestNeedsPmSince ?? 0) : prefix,
      needsPm: graph.readyToFinish && graph.needsPm,
      text: graphHeading(graph),
    });
    for (const step of graph.steps.slice(0, PM_AGENDA_STEP_LINES_MAX)) {
      lines.push({
        ref: `${prefix}:step:${step.key}:${step.state.kind}@${step.since}`,
        needsPm: step.state.kind === "waiting_pm",
        text: `图 #${graph.graphId}「${agendaLabel(graph.title)}」${step.key}：${stepText(step)}`,
      });
    }
    const omitted = Math.max(0, graph.steps.length - PM_AGENDA_STEP_LINES_MAX);
    if (omitted > 0) lines.push({ ref: `${prefix}:more`, needsPm: false, text: `图 #${graph.graphId}另有 ${omitted} 个步骤` });
  }
  for (const item of agenda.outside) lines.push(outsideLine(item));
  if (agenda.userCards > 0) lines.push({ ref: "user-cards", needsPm: false, text: `等用户：${agenda.userCards} 张卡（${HUB_COMMAND} ask list）` });
  const omitted = agenda.omittedGraphs + Math.max(0, agenda.graphs.length - PM_AGENDA_GRAPHS_MAX);
  if (omitted > 0) lines.push({ ref: "more-graphs", needsPm: false, text: `另有 ${omitted} 张图` });
  return lines;
}

export function agendaCountsOf(agenda: PmAgenda): AgendaCounts {
  const counts: AgendaCounts = { needsPm: 0, running: 0, queued: 0, watching: 0, userCards: agenda.userCards, oldestNeedsPmSince: null };
  const wait = (since: number | null) => {
    counts.needsPm++;
    if (since !== null) counts.oldestNeedsPmSince = Math.min(counts.oldestNeedsPmSince ?? since, since);
  };
  for (const graph of agenda.graphs) {
    if (graph.readyToFinish && graph.needsPm) wait(graph.oldestNeedsPmSince);
    for (const step of graph.steps) {
      switch (step.state.kind) {
        case "waiting_pm": wait(step.since); break;
        case "running": counts.running++; break;
        case "queued_slot": counts.queued++; break;
      }
    }
  }
  for (const item of agenda.outside) {
    if (item.kind === "watch") counts.watching++;
    else wait(item.since);
  }
  return counts;
}

export function diffAgendaLines(before: readonly AgendaLine[], after: readonly AgendaLine[]): AgendaChange[] {
  const previous = new Map(before.map((line) => [line.ref, line]));
  const changes: AgendaChange[] = [];
  for (const line of after) {
    const old = previous.get(line.ref);
    if (old === undefined) changes.push({ op: "add", line });
    else if (old.text !== line.text || old.needsPm !== line.needsPm) changes.push({ op: "change", before: old, after: line });
    previous.delete(line.ref);
  }
  for (const line of previous.values()) changes.push({ op: "remove", line });
  return changes;
}

function countsText(counts: AgendaCounts, compact: boolean): string {
  const main = `要你处理 ${counts.needsPm}${counts.oldestNeedsPmSince === null ? "" : `（最早 ${timeOf(counts.oldestNeedsPmSince)} 起）`}`;
  return [
    main, `在跑 ${counts.running}`,
    ...(!compact || counts.queued > 0 ? [`排队 ${counts.queued}`] : []),
    ...(!compact || counts.watching > 0 ? [`在盯 ${counts.watching}`] : []),
    `等用户 ${counts.userCards} 张卡`,
  ].join(" · ");
}

function changeLine(change: AgendaChange): string {
  switch (change.op) {
    case "add": return `+ ${change.line.text}`;
    case "change": {
      const prefix = change.after.text.indexOf("：");
      if (prefix < 0 || !change.before.text.startsWith(change.after.text.slice(0, prefix + 1))) return `~ ${change.after.text}`;
      return `~ ${change.after.text.slice(0, prefix + 1)}${change.before.text.slice(prefix + 1)} → ${change.after.text.slice(prefix + 1)}`;
    }
    case "remove": return `- ${change.line.text} → 已不在清单`;
  }
}

const agendaItemKey = (ref: string) =>
  /^(graph:\d+:step:.+):[^:@]+@\d+$/u.exec(ref)?.[1] ?? /^(graph:\d+):ready@\d+$/u.exec(ref)?.[1] ?? ref;

function changesForFooter(changes: readonly AgendaChange[], agenda: PmAgenda): AgendaChange[] {
  const removed = new Map<string, AgendaLine>();
  const added = new Set<string>();
  const done = new Map<string, AgendaLine>();
  for (const graph of agenda.graphs) {
    for (const key of graph.doneKeys ?? []) {
      const ref = `graph:${graph.graphId}:step:${key}`;
      done.set(ref, { ref, needsPm: false, text: `图 #${graph.graphId}「${agendaLabel(graph.title)}」${key}：完了` });
    }
  }
  for (const change of changes) {
    if (change.op === "remove") removed.set(agendaItemKey(change.line.ref), change.line);
    if (change.op === "add") added.add(agendaItemKey(change.line.ref));
  }
  const result: AgendaChange[] = [];
  for (const change of changes) {
    if (change.op === "change") {
      result.push(change);
      continue;
    }
    const key = agendaItemKey(change.line.ref);
    if (change.op === "add") {
      const before = removed.get(key);
      result.push(before === undefined ? change : { op: "change", before, after: change.line });
    } else if (!added.has(key)) {
      const after = done.get(key);
      result.push(after === undefined ? change : { op: "change", before: change.line, after });
    }
  }
  return result;
}

function changeGroup(change: AgendaChange): string {
  const line = change.op === "change" ? change.after : change.line;
  return /^graph:\d+(?=[:@]|$)/u.exec(line.ref)?.[0] ?? line.ref;
}

export function nextAgendaFooter(
  cursor: AgendaCursor | null,
  agenda: PmAgenda,
  { now, compactedSinceCursor }: { now: number; compactedSinceCursor: boolean },
): AgendaFooter {
  const lines = agendaLinesOf(agenda);
  const diff = diffAgendaLines(cursor?.lines ?? [], lines);
  if (lines.length === 0 && diff.length === 0 && !compactedSinceCursor) return { kind: "none" };
  const version = (cursor?.version ?? 0) + 1;
  const time = timeOf(now);
  const counts = agendaCountsOf(agenda);
  if (cursor !== null && !compactedSinceCursor && diff.length === 0) {
    return { kind: "unchanged", version: cursor.version, lines, text: `【清单 v${cursor.version} 没变 · ${time}】${countsText(counts, true)}` };
  }
  const snapshot = { kind: "snapshot" as const, version, lines, text: `【清单 v${version} · ${time}】\n${formatPmAgenda(agenda, now)}` };
  if (cursor === null || compactedSinceCursor || cursor.deltasSinceSnapshot >= PM_AGENDA_DELTAS_PER_SNAPSHOT) return snapshot;
  const changes = changesForFooter(diff, agenda);
  const status = `现在：${countsText(counts, false)}；全文 ${HUB_COMMAND} status`;
  const text = [`【清单 v${version} · ${time} · 比 v${cursor.version} 变了 ${changes.length} 处】`, ...changes.map(changeLine), status].join("\n");
  if (changes.length > PM_AGENDA_DELTA_LINES_MAX || (text.length > snapshot.text.length && new Set(changes.map(changeGroup)).size > 1)) {
    return snapshot;
  }
  return { kind: "delta", version, lines, changes, text };
}

export function formatPmAgenda(agenda: PmAgenda, _now: number): string {
  const graphs = agenda.graphs.slice(0, PM_AGENDA_GRAPHS_MAX);
  const omitted = agenda.omittedGraphs + agenda.graphs.length - graphs.length;
  const lines = [`任务图（${graphs.length + omitted} 张，要你动手的排前面）：`];
  if (graphs.length === 0) lines.push("无活跃的图");
  for (const graph of graphs) {
    lines.push(`- ${graphHeading(graph)}`);
    for (const step of graph.steps.slice(0, PM_AGENDA_STEP_LINES_MAX)) lines.push(`  - ${step.key}：${stepText(step)}`);
    const omittedSteps = Math.max(0, graph.steps.length - PM_AGENDA_STEP_LINES_MAX);
    if (omittedSteps > 0) lines.push(`  另有 ${omittedSteps} 个步骤`);
  }
  if (omitted > 0) lines.push(`另有 ${omitted} 张图`);
  if (agenda.outside.length > 0 || agenda.userCards > 0) {
    lines.push("图外：");
    for (const item of agenda.outside) lines.push(`- ${outsideLine(item).text}`);
    if (agenda.userCards > 0) lines.push(`- 等用户：${agenda.userCards} 张卡（${HUB_COMMAND} ask list）`);
  }
  return lines.join("\n");
}

export const preambleAgendaSection = (agenda: PmAgenda, now: number): string =>
  `${PM_AGENDA_PREAMBLE_HEADING}\n\n${formatPmAgenda(agenda, now)}`;

export function handoverAgendaNoticeText(agenda: PmAgenda): string {
  return ["【交接后还有事等你】", ...agendaLinesOf(agenda).filter((line) => line.needsPm).map((line) => `- ${line.text}`)].join("\n");
}

export const appendDeliverySuffix = (text: string, suffix: string): string =>
  suffix === "" ? text : `${text}\n\n${suffix}`;
