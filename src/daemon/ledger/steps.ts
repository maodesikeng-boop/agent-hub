// 账本里的步骤记录（session_steps，迁移 0010）：会话一步一步干了什么，hub worker show / log 从这里取（worker-view.ts）。
// 驱动层的事件各家格式不同，到账本这里已经是通用的 DriverEvent（工具调用、思考、工具结果、文字回复、一轮开始和结束），
// 所以三家厂商都记得进来，不用解析各家的原始日志。工具调用、文字回复另外还在 messages 里（给网页的对话用），这里只是为了
// 把思考、工具结果回来的时间、一轮的开始和结局补全。命令行、回复开头里的密钥、令牌入库前先遮掉（redact.ts）。
import { turnFailureReason } from "../../shared/driver.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, SessionId } from "../../shared/domain.ts";
import { SESSION_STEPS_KEEP } from "../../shared/limits.ts";
import { describeStep } from "../../shared/step-labels.ts";
import type { LedgerContext } from "./context.ts";
import { exitFailureReason } from "./messages.ts";
import { redactSecrets } from "./redact.ts";
import { oneLine, stepOfTool } from "./tool-summary.ts";

export type StepKind = "turn_started" | "thinking" | "tool" | "tool_result" | "text" | "turn_ended";
export type TurnOutcome = "ok" | "interrupted" | "failed";

export interface StepRow {
  id: number;
  session_id: SessionId;
  kind: StepKind;
  at: number;
  name: string | null;
  tool_use_id: string | null;
  summary: string | null;
  outcome: TurnOutcome | null;
  duration_ms: number | null;
}

/** 入库的一行摘要最多这么长（显示时再按 WORKER_VIEW_TEXT_MAX_CHARS 截）。 */
const MAX_STORED_CHARS = 300;
/** 一轮没做完时 turn_ended 的原因（驱动层没给错误信息）。 */
const TURN_FAILED_REASON = "这一轮出错了";
/** 进程重启时还开着的一轮：按被打断算。 */
const RESTART_INTERRUPTED_REASON = "进程重启，这一轮被打断了";

const clip = (text: string) => {
  const chars = [...text];
  return chars.length > MAX_STORED_CHARS ? `${chars.slice(0, MAX_STORED_CHARS - 1).join("")}…` : text;
};
/** 一行、遮掉密钥、截断：入库的摘要都过这里。 */
const stored = (text: string) => clip(redactSecrets(oneLine(text)));

/** 这些键的值是路径：标签里已经有文件名，不再重复写。 */
const PATH_KEYS = ["file_path", "notebook_path", "AbsolutePath", "TargetFile", "Path"];
/** 标签后面接一个最要紧的参数（命令、搜索词、网址……），和 tool-summary.ts 的 KEY_ARGS 同一个次序。 */
const ARG_KEYS = ["command", "CommandLine", "pattern", "url", "query", "path", "SearchPath", "description", "prompt"];

/**
 * 一次工具调用的一行：和网页状态行同一套文案（shared/step-labels.ts，三家的工具名都认）加最要紧的参数，
 * 比如“Running command: gh pr checks 90 --watch”“Reading a.ts”“Searching files: foo”。
 */
function toolLine(name: string, input: unknown): string {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const label = describeStep(stepOfTool(name, input));
  if (PATH_KEYS.some((key) => typeof args[key] === "string" && oneLine(args[key] as string) !== "")) return label;
  for (const key of ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && oneLine(value) !== "") return `${label}: ${oneLine(value)}`;
  }
  return label;
}

export type LedgerSteps = ReturnType<typeof createLedgerSteps>;

export function createLedgerSteps(ctx: LedgerContext) {
  const { db, now } = ctx;

  const insert = (
    sessionId: SessionId,
    row: { kind: StepKind; name?: string; toolUseId?: string; summary?: string | null; outcome?: TurnOutcome; durationMs?: number | null; dedupeKey?: string },
  ) => {
    db.run(
      `INSERT INTO session_steps (session_id, kind, at, name, tool_use_id, summary, outcome, duration_ms, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
      sessionId,
      row.kind,
      now(),
      row.name ?? null,
      row.toolUseId ?? null,
      row.summary ?? null,
      row.outcome ?? null,
      row.durationMs ?? null,
      row.dedupeKey ?? null,
    );
  };

  /** 最近一次一轮的开始或结束。 */
  const lastBoundary = (sessionId: SessionId): StepRow | null =>
    db.get<StepRow>(
      "SELECT * FROM session_steps WHERE session_id = ? AND kind IN ('turn_started', 'turn_ended') ORDER BY id DESC LIMIT 1",
      sessionId,
    ) ?? null;

  /** 这个会话现在有没有开着的一轮（最近的边界是 turn_started）。 */
  const openTurn = (sessionId: SessionId): StepRow | null => {
    const last = lastBoundary(sessionId);
    return last?.kind === "turn_started" ? last : null;
  };

  const ensureTurn = (sessionId: SessionId) => {
    if (openTurn(sessionId) === null) insert(sessionId, { kind: "turn_started" });
  };

  const endTurn = (sessionId: SessionId, outcome: TurnOutcome, reason: string | null, durationMs: number | null) => {
    insert(sessionId, { kind: "turn_ended", outcome, summary: reason === null ? null : stored(reason), durationMs });
    // 只留最近的 SESSION_STEPS_KEEP 条
    db.run(
      `DELETE FROM session_steps WHERE session_id = ? AND id <= (SELECT id FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      sessionId,
      sessionId,
      SESSION_STEPS_KEEP,
    );
  };

  /** 在 applyDriverEvent 的事务里、消息和会话状态处理完之后调。子任务里的事件不记（那不是主 agent 的步骤）。 */
  const afterDriverEvent = (session: AgentSessionRow, event: DriverEvent) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        // 新进程起来了，上一个进程留下还开着的一轮不会再有结局
        if (openTurn(sessionId) !== null) endTurn(sessionId, "interrupted", RESTART_INTERRUPTED_REASON, null);
        return;
      case "message.delivered":
      case "message.processing":
      case "turn.started":
        ensureTurn(sessionId);
        return;
      case "agent.thinking":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, { kind: "thinking", dedupeKey: `step:${sessionId}:thinking:${event.uuid}` });
        return;
      case "agent.text":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, { kind: "text", summary: stored(event.text), dedupeKey: `step:${sessionId}:text:${event.uuid}` });
        return;
      case "agent.tool":
        if (event.parentToolUseId !== undefined) return;
        ensureTurn(sessionId);
        insert(sessionId, {
          kind: "tool",
          name: event.name,
          toolUseId: event.toolUseId,
          summary: stored(toolLine(event.name, event.input)),
          dedupeKey: `step:${sessionId}:tool:${event.uuid}:${event.toolUseId}`,
        });
        return;
      case "agent.tool_result":
        if (event.parentToolUseId !== undefined) return;
        for (const toolUseId of event.toolUseIds) insert(sessionId, { kind: "tool_result", toolUseId });
        return;
      case "turn.ended": {
        const outcome: TurnOutcome = event.interrupted ? "interrupted" : event.ok ? "ok" : "failed";
        const reason = outcome === "failed" ? (event.error === undefined ? TURN_FAILED_REASON : turnFailureReason(event.error)) : null;
        endTurn(sessionId, outcome, reason, event.durationMs);
        return;
      }
      case "session.exited": {
        if (event.reason === "idle" || openTurn(sessionId) === null) return;
        // 没等到 result 就退出了：被打断（停止、关机）或崩溃
        const crashed = event.reason === "crash" || event.reason === "startup_failed";
        endTurn(sessionId, crashed ? "failed" : "interrupted", crashed ? exitFailureReason(event) : null, null);
        return;
      }
      default:
        return;
    }
  };

  /** 这个会话最近的步骤（最多 SESSION_STEPS_KEEP 条），从旧到新。 */
  const rows = (sessionId: SessionId): StepRow[] =>
    db.all<StepRow>("SELECT * FROM session_steps WHERE session_id = ? ORDER BY id DESC LIMIT ?", sessionId, SESSION_STEPS_KEEP).reverse();

  return { afterDriverEvent, rows, openTurn, lastBoundary };
}
