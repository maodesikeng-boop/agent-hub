import { truncateChars, type ConversationId, type PmId, type TaskGraphId, type WorkerId } from "./domain.ts";
import { PM_AGENDA_LABEL_MAX_CHARS } from "./limits.ts";
import { HUB_COMMAND } from "./names.ts";
import { formatDurationShort, scheduledTimeText } from "./schedule.ts";

export type PmWatchId = number;

export type PmWatchStatus = "watching" | "met" | "failed" | "expired" | "closed";

/** `once` runs the command one time and settles on its exit code; `poll` reruns it until it exits 0; `timer` runs nothing. */
export type PmWatchCondition =
  | { kind: "once"; command: string }
  | { kind: "poll"; command: string; everyMs: number }
  | { kind: "timer"; afterMs: number };

export interface PmWatchInput {
  condition: PmWatchCondition;
  body: string;
  maxMs?: number;
  graphId?: TaskGraphId;
  workerId?: WorkerId;
}

export interface PmWatchOutcome {
  kind: "met" | "failed" | "expired";
  exitCode: number | null;
  outputTail: string;
}

export interface PmWatchRecord {
  id: PmWatchId;
  pmId: PmId;
  conversationId: ConversationId;
  condition: PmWatchCondition;
  body: string;
  graphId: TaskGraphId | null;
  workerId: WorkerId | null;
  status: PmWatchStatus;
  runs: number;
  deadlineAt: number;
  /** Null while a run is in flight and for timers. */
  nextRunAt: number | null;
  exitCode: number | null;
  outputTail: string | null;
  settledAt: number | null;
  closedAt: number | null;
  createdAt: number;
}

const watchLabel = (body: string): string => truncateChars(body.replace(/\s+/gu, " ").trim(), PM_AGENDA_LABEL_MAX_CHARS);

export function pmWatchConditionText(condition: PmWatchCondition): string {
  switch (condition.kind) {
    case "once": return `跑一次 \`${condition.command}\`，退出码 0 算满足`;
    case "poll": return `每 ${formatDurationShort(condition.everyMs)} 跑一次 \`${condition.command}\`，直到退出码为 0`;
    case "timer": return `等 ${formatDurationShort(condition.afterMs)}`;
  }
}

function linkText(watch: Pick<PmWatchRecord, "graphId" | "workerId">): string {
  if (watch.graphId !== null) return `图 #${watch.graphId}`;
  return watch.workerId === null ? "" : `Worker #${watch.workerId}`;
}

export function pmWatchReceiptText(watch: PmWatchRecord, now: number): string {
  return [
    `已开始盯 #${watch.id}：满足、失败或超时都会叫醒你；${HUB_COMMAND} watch list 看进度，${HUB_COMMAND} watch close ${watch.id} 取消`,
    `条件：${pmWatchConditionText(watch.condition)}；最晚 ${scheduledTimeText(watch.deadlineAt, now)}`,
  ].join("\n");
}

const STATUS_TEXT: Readonly<Record<PmWatchStatus, string>> = {
  watching: "在盯", met: "满足了", failed: "失败了", expired: "超时了", closed: "已关掉",
};

function listLine(watch: PmWatchRecord, now: number): string {
  const link = linkText(watch);
  const parts = [
    `#${watch.id} ${STATUS_TEXT[watch.status]}「${watchLabel(watch.body)}」`,
    pmWatchConditionText(watch.condition),
    ...(watch.condition.kind === "timer" ? [] : [`已跑 ${watch.runs} 次`]),
    watch.status === "watching" ? `最晚 ${scheduledTimeText(watch.deadlineAt, now)}` : `${scheduledTimeText(watch.settledAt ?? watch.closedAt ?? now, now)} 结束`,
    ...(link === "" ? [] : [link]),
  ];
  return `- ${parts.join(" · ")}`;
}

export function pmWatchListText(watches: readonly PmWatchRecord[], now: number): string {
  if (watches.length === 0) return `没有在盯的条件。要等外部条件再动手，用 ${HUB_COMMAND} watch add 让后台盯着。`;
  return ["在盯的条件和最近的结果：", ...watches.map((watch) => listLine(watch, now))].join("\n");
}

const SETTLED_HEAD: Readonly<Record<PmWatchOutcome["kind"], string>> = {
  met: "满足了", failed: "失败了", expired: "超时了，没等到",
};

/** Precondition: watch has settled (met, failed, or expired). */
export function pmWatchSettledText(watch: PmWatchRecord): string {
  const kind = watch.status === "met" || watch.status === "failed" || watch.status === "expired" ? watch.status : "expired";
  const exit = watch.condition.kind === "timer" ? "" : `（跑了 ${watch.runs} 次${watch.exitCode === null ? "" : `，最后退出码 ${watch.exitCode}`}）`;
  const link = linkText(watch);
  const tail = (watch.outputTail ?? "").trim();
  return [
    `【在盯的 #${watch.id} ${SETTLED_HEAD[kind]}】${pmWatchConditionText(watch.condition)}${exit}`,
    `你当时说结果出来后要做：${watch.body}`,
    ...(link === "" ? [] : [`关联：${link}`]),
    ...(tail === "" ? [] : ["输出末尾：", tail]),
  ].join("\n");
}
