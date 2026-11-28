// Invariant: self-reload busy descriptions name specific active sessions and running background commands,
// bounded by SELF_RELOAD_BUSY_ITEMS_MAX so large workloads never flood hub status or reload receipts.

import type { AgentRole, SessionId, WorkerId } from "../shared/domain.ts";
import type { BackgroundTaskInfo } from "../shared/driver.ts";
import { SELF_RELOAD_BUSY_ITEMS_MAX } from "../shared/limits.ts";
import { formatDurationShort } from "../shared/schedule.ts";

export interface BusyBackgroundCommand {
  readonly label: string;
  readonly startedAt: number;
}

export interface BusySessionSnapshot {
  readonly sessionId: SessionId;
  readonly role: AgentRole;
  readonly activity: string;
  readonly workerId?: WorkerId;
  readonly workerTitle?: string;
  readonly pmName?: string;
  readonly backgroundTasks?: readonly Pick<BackgroundTaskInfo, "label" | "startedAt">[];
}

const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  working: "正在执行",
  stopping: "正在停止",
  preparing: "正在准备",
  background: "等待后台命令",
};

function priorityOf(session: BusySessionSnapshot): number {
  const hasBg = (session.backgroundTasks?.length ?? 0) > 0;
  if (session.role === "worker" && hasBg) return 0;
  if (session.role === "worker") return 1;
  if (session.role === "pm") return 2;
  return 3;
}

function formatBusySession(session: BusySessionSnapshot, now: number): string {
  const bg = session.backgroundTasks ?? [];
  const activity = ACTIVITY_LABELS[session.activity] ?? session.activity;
  const label =
    session.role === "worker"
      ? `Worker #${session.workerId ?? session.sessionId}${session.workerTitle ? `「${session.workerTitle}」` : ""}`
      : session.role === "pm"
        ? `项目经理${session.pmName ? `「${session.pmName}」` : `会话 #${session.sessionId}`}`
        : `总助会话 #${session.sessionId}`;
  if (bg.length > 0) {
    const shown = bg.slice(0, 2).map((task) => {
      const name = task.label.trim() === "" ? "后台命令" : task.label.trim();
      return `${name}（已跑 ${formatDurationShort(Math.max(0, now - task.startedAt))}）`;
    });
    const extra = bg.length > shown.length ? ` 等 ${bg.length} 个` : "";
    return `${label}（后台命令：${shown.join("、")}${extra}）`;
  }
  return `${label}（${activity}）`;
}

export function describeBusySessionsForReload(sessions: readonly BusySessionSnapshot[], now: number): string[] {
  if (sessions.length === 0) return [];
  const ordered = [...sessions].sort((a, b) => priorityOf(a) - priorityOf(b) || a.sessionId - b.sessionId);
  const shown = ordered.slice(0, SELF_RELOAD_BUSY_ITEMS_MAX).map((session) => formatBusySession(session, now));
  const omitted = ordered.length - shown.length;
  if (omitted > 0) shown.push(`另有 ${omitted} 个会话忙碌`);
  return shown;
}
