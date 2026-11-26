import type { SessionId } from "../../shared/domain.ts";
import type { WorkerLogStep } from "../../shared/hub.ts";
import { WORKER_VIEW_TEXT_MAX_CHARS } from "../../shared/limits.ts";
import { formatDuration } from "../../shared/step-labels.ts";
import { storedStepSummary, type LedgerSteps, type StepRow } from "./steps.ts";
import type { LedgerTurnTools, TurnToolRecord } from "./turn-tools.ts";
import { SHUTDOWN_INTERRUPTED_REASON, type LedgerTurns, type TurnRecord } from "./turns.ts";

type Activity = StepRow
  | { kind: "tool"; at: number; tool: TurnToolRecord }
  | { kind: "tool_done" | "turn_started"; at: number }
  | { kind: "turn_ended"; at: number; turn: TurnRecord };

const rank = { turn_started: 0, thinking: 1, tool: 2, tool_done: 3, text: 4, turn_ended: 5 };
const pad = (n: number) => String(n).padStart(2, "0");

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function clipText(text: string, max = WORKER_VIEW_TEXT_MAX_CHARS): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function outcomeText(turn: TurnRecord): string {
  switch (turn.outcome) {
    case "ok": return "成功";
    case "empty_recovery": return "重启后重发，这一轮没有产出";
    case "interrupted":
      if (turn.stopSource === "shutdown") return `被打断（${SHUTDOWN_INTERRUPTED_REASON}）`;
      if (turn.stopSource === "crash") return "被打断（进程重启，这一轮被打断了）";
      return "被打断";
    case "failed":
      return turn.failureReason === null || turn.failureReason === "turn_failed"
        ? "出错" : `出错：${clipText(storedStepSummary(turn.failureReason))}`;
    case null: return "还在跑";
  }
}

export function createWorkerActivity(steps: LedgerSteps, turns: LedgerTurns, tools: LedgerTurnTools) {
  return (sessionId: SessionId) => {
    const timeline: Activity[] = steps.rows(sessionId);
    const sessionTurns = turns.sessionTurns(sessionId);
    const sessionTools = tools.sessionTools(sessionId);
    for (const tool of sessionTools) {
      timeline.push({ kind: "tool", at: tool.recordedAt, tool });
      if (tool.status === "done" && tool.endedAt !== null) timeline.push({ kind: "tool_done", at: tool.endedAt });
    }
    for (const turn of sessionTurns) {
      timeline.push({ kind: "turn_started", at: turn.startedAt });
      if (turn.endedAt !== null) timeline.push({ kind: "turn_ended", at: turn.endedAt, turn });
    }
    timeline.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
    return { turns: sessionTurns, tools: sessionTools, events: timeline };
  };
}

export type WorkerActivity = ReturnType<ReturnType<typeof createWorkerActivity>>;

export function* collapseThinking(events: readonly Activity[]): Iterable<Exclude<Activity, { kind: "thinking" }> | { kind: "thinking"; at: number; until: number | null }> {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) break;
    if (event.kind !== "thinking") {
      yield event;
      continue;
    }
    while (events[i + 1]?.kind === "thinking") i++;
    yield { kind: "thinking", at: event.at, until: events[i + 1]?.at ?? null };
  }
}

function toolLogText(tool: TurnToolRecord, now: number | null): string {
  const what = clipText(tool.summary ?? tool.name);
  switch (tool.status) {
    case "done": {
      const elapsed = tool.endedAt !== null && tool.startedAt !== null ? tool.endedAt - tool.startedAt : 0;
      return elapsed < 1_000 ? what : `${what}（用了 ${formatDuration(elapsed)}）`;
    }
    case "pending": return now === null ? `${what}（没等到结果）` : `${what}（等待开始）`;
    case "running":
      return now === null ? `${what}（没等到结果）`
        : `${what}（还在跑，已 ${formatDuration(now - (tool.startedAt ?? tool.recordedAt))}）`;
    case "unconfirmed": return `${what}（没等到结果）`;
  }
}

export function formatLogSteps({ events }: WorkerActivity, now: number | null): WorkerLogStep[] {
  const shown: WorkerLogStep[] = [];
  for (const row of collapseThinking(events)) {
    switch (row.kind) {
      case "tool":
        shown.push({ at: row.at, kind: row.kind, text: toolLogText(row.tool, now) });
        break;
      case "thinking":
        shown.push({ at: row.at, kind: row.kind, text: row.until === null
          ? now === null ? "思考" : `在思考，已 ${formatDuration(now - row.at)}`
          : `思考了 ${formatDuration(row.until - row.at)}` });
        break;
      case "text":
        shown.push({ at: row.at, kind: row.kind, text: `回复了一段：${clipText(row.summary ?? "")}` });
        break;
      case "turn_ended":
        shown.push({ at: row.at, kind: row.kind, text: `这一轮结束：${outcomeText(row.turn)}` });
        break;
      case "turn_started":
      case "tool_done":
        break;
    }
  }
  return shown;
}
