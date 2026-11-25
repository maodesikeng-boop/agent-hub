import type { SessionId } from "../../shared/domain.ts";
import type { BackgroundTaskInfo } from "../../shared/driver.ts";
import { WORKER_LIST_IDLE_HINT_MIN_MS, WORKER_SHOW_BACKGROUND_TASKS_MAX } from "../../shared/limits.ts";
import { formatDuration } from "../../shared/step-labels.ts";
import type { Db } from "../store/index.ts";
import type { LiveSession } from "./sessions.ts";
import type { TurnOutcome } from "./steps.ts";

export interface WorkerStateInput {
  status: string;
  sandboxApprovalPending?: boolean;
  notStarted: boolean;
  live: Pick<LiveSession, "activity">;
  lastTurnOutcome: TurnOutcome | null;
  lastEventAt: number | null;
  now: number;
}

export interface FormatWorkerStateOptions {
  includeIdleDuration?: boolean;
}

export function formatWorkerState(input: WorkerStateInput, options?: FormatWorkerStateOptions): string {
  const { status, sandboxApprovalPending, notStarted, live, lastTurnOutcome, lastEventAt, now } = input;
  if (status === "ended") return "已收工";
  if (sandboxApprovalPending) return "等待沙箱确认";
  if (live.activity === "preparing" || notStarted) return "准备中";
  if (live.activity === "background") return "在等后台命令";
  if (live.activity !== "idle") return "在干活";
  const labels = { ok: "空闲，等验收", interrupted: "空闲，上一轮被打断了", failed: "空闲，上一轮出错了" };
  const label = lastTurnOutcome === null ? "空闲，还没开始第一轮" : labels[lastTurnOutcome];
  const elapsed = lastEventAt === null ? 0 : now - lastEventAt;
  return options?.includeIdleDuration && elapsed >= WORKER_LIST_IDLE_HINT_MIN_MS
    ? `${label}（${formatDuration(elapsed)} 前有动静）`
    : label;
}

export function lastTurnOutcomesBySession(db: Db, sessionIds: readonly SessionId[]): ReadonlyMap<SessionId, TurnOutcome> {
  if (sessionIds.length === 0) return new Map();
  const rows = db.all<{ session_id: SessionId; outcome: TurnOutcome }>(
    `SELECT session_id, outcome FROM session_steps WHERE id IN (
      SELECT (SELECT id FROM session_steps WHERE session_id = ids.value AND kind = 'turn_ended' ORDER BY id DESC LIMIT 1)
      FROM json_each(?) ids
    )`,
    JSON.stringify(sessionIds),
  );
  return new Map(rows.map(({ session_id, outcome }) => [session_id, outcome]));
}

export function formatBackgroundTasksSummary(
  tasks: readonly BackgroundTaskInfo[],
  now: number,
  maxShown = WORKER_SHOW_BACKGROUND_TASKS_MAX,
): string[] {
  const lines = tasks.slice(0, maxShown).map(({ label, startedAt }) =>
    `- ${label || "（没有描述）"} · 已运行 ${formatDuration(Math.max(0, now - startedAt))}`);
  if (tasks.length > maxShown) lines.push(`…另有 ${tasks.length - maxShown} 个`);
  return lines;
}
