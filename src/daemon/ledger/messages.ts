import { createLedgerChecklist } from "./checklist.ts";
import type { TurnCompletionFacts, TurnEndedEvent } from "./turn-completions.ts";
import { randomUUID } from "node:crypto";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { MessagesPage } from "../../shared/api.ts";
import { isLedgerWakeup, type UserMessageMeta } from "../../shared/attachments.ts";
import { mergeDeliverables, type Deliverable, type HubFileArg } from "../../shared/deliverables.ts";
import { agentMessageDedupeKey, canTransitionMessage, systemMessageDedupeKey, userMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentRole, AgentSessionRow, AskMeta, BlockerRef, ConversationId, GateRef, Message, MessageId, MessageStatus, SessionId, SystemMessageMeta } from "../../shared/domain.ts";
import { turnFailureReason } from "../../shared/driver.ts";
import type { DriverEvent, SessionExitedEvent } from "../../shared/driver.ts";
import { ConversationNotFoundError } from "../../shared/ledger.ts";
import type { ComposerTarget, PostUserMessageInput, PostUserMessageResult } from "../../shared/ledger.ts";
import { DELIVERABLES_PER_CARD_MAX, MESSAGE_PAGE_SIZE, REWIND_SCAN_LIMIT } from "../../shared/limits.ts";
import { findRewindableMessage } from "../../shared/rewind.ts";
import type { AgentTextMeta, SentFile } from "../../shared/sent-files.ts";
import { deliverablesOfFileArgs } from "../deliverables.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { WEB_MESSAGE_COLUMNS, toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import { clearStreaming, idle, toolRunning, toolStarted, working } from "./sessions.ts";
import { isPathInsideOrEqual } from "../platform/index.ts";
import { getAgentSession } from "../store/index.ts";
import type { LedgerSessions } from "./sessions.ts";
import { stepOfTool, summarizeToolCall } from "./tool-summary.ts";

export type AskSettlement = { by: "answer"; chosenOption?: string; note?: string } | { by: "close" };

const ACTIVE_MESSAGE_STATUSES = "('delivered', 'processing')";
const WORKER_PICK_ONLY_PM_MESSAGE = "指定 Worker 用的厂商、模型只能用在项目经理的对话里";

export const CONTEXT_COMPACTED_TEXT = "已压缩上下文";

export function exitFailureReason(event: SessionExitedEvent): string {
  if (event.signal !== null) return `${event.reason}: signal ${event.signal}`;
  if (event.exitCode !== null) return `${event.reason}: exit code ${event.exitCode}`;
  return event.reason;
}

/** Turns interrupted by shutdown stay delivered or processing so recoverAfterRestart can resend them. */
function resumesAfterShutdown(session: AgentSessionRow, message: Pick<MessageDbRow, "sender">): boolean {
  return session.role === "worker" || message.sender === "system";
}

export type LedgerMessages = ReturnType<typeof createLedgerMessages>;

export interface LedgerMessagesOptions {
  assertUserCanPost?: (conversationId: ConversationId) => void;
  afterUserPost?: (p: Pending, conversationId: ConversationId) => void;
  onIndependentAskCreated?: (p: Pending, session: AgentSessionRow, message: Message, options?: string[]) => void;
}

function insertAgentMessage(
  { db, now }: Pick<LedgerContext, "db" | "now">,
  p: Pending,
  session: AgentSessionRow,
  fields: { kind: "text" | "tool" | "checklist"; text: string; meta: Record<string, unknown> | null; dedupeKey: string },
): void {
  if (session.conversationId === null) return;
  const t = now();
  const handoverTurn =
    session.role === "pm" &&
    db.get(
      `SELECT 1 AS x FROM messages WHERE session_id = ? AND sender = 'system' AND kind = 'text'
         AND json_extract(meta, '$.event') = 'handover.requested' AND json_extract(meta, '$.writing') = 1 LIMIT 1`,
      session.id,
    ) !== undefined;
  const meta = handoverTurn ? { ...fields.meta, handover: true } : fields.meta;
  const row = db.get<MessageDbRow>(
    `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, collapsed, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    session.conversationId,
    session.id,
    session.workerId,
    fields.kind,
    fields.text,
    meta === null ? null : JSON.stringify(meta),
    fields.kind === "text" ? 0 : 1,
    fields.dedupeKey,
    t,
    t,
  );
  if (row !== undefined) p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
}

export function createLedgerMessages(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  options: LedgerMessagesOptions = {},
) {
  const assertUserCanPost = options.assertUserCanPost ?? (() => {});
  const afterUserPost = options.afterUserPost ?? (() => {});
  const onIndependentAskCreated = options.onIndependentAskCreated ?? (() => {});
  const { db, now, write, enqueue, reportHealthIn } = ctx;
  const { currentSession, dropRateLimitRejection, liveOf, updateLive, workingSessionIds } = sessions;

  const conversationExists = (id: ConversationId) =>
    db.get("SELECT 1 AS x FROM conversations WHERE id = ? AND kind != 'project_group'", id) !== undefined;
  const isPmConversation = (id: ConversationId) => db.get("SELECT 1 AS x FROM conversations WHERE id = ? AND kind = 'pm'", id) !== undefined;

  const getMessage = (id: MessageId): Message | null => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
    return row === undefined ? null : toMessage(row);
  };

  const page = (rows: MessageDbRow[]): MessagesPage => {
    const hasMore = rows.length > MESSAGE_PAGE_SIZE;
    return { messages: rows.slice(0, MESSAGE_PAGE_SIZE).reverse().map(toMessage), hasMore };
  };

  /** Invalid transitions, including same-state ones, are ignored. */
  const transition = (p: Pending, id: MessageId, to: MessageStatus, reason: string | null = null, ownerSessionId?: SessionId) => {
    const message = getMessage(id);
    if (message === null || message.status === null || !canTransitionMessage(message.status, to)) return;
    if (ownerSessionId !== undefined && message.sessionId !== ownerSessionId) return;
    db.run(
      `UPDATE messages SET status = ?, failure_reason = ?, updated_at = ?,
         meta = CASE WHEN ? IN ('delivered', 'processing') THEN json_set(COALESCE(meta, '{}'), '$.deliveryConfirmed', json('true'))
                     WHEN ? = 'queued' THEN json_remove(meta, '$.deliveryConfirmed') ELSE meta END WHERE id = ?`,
      to,
      to === "failed" ? reason : null,
      now(),
      to,
      to,
      id,
    );
    p.changes.push({ type: "message.updated", data: { message: getMessage(id)! } });
  };

  const insertAskMessage = (
    p: Pending,
    session: AgentSessionRow,
    text: string,
    askOptions?: string[],
    extra?: {
      gateRef?: GateRef;
      blockerRef?: BlockerRef;
      recommended?: string;
      skipRouterBridge?: boolean;
      fileArgs?: { args: readonly HubFileArg[]; files: readonly SentFile[] };
      deliverables?: readonly Deliverable[];
    },
  ): Message => {
    const t = now();
    const meta: AskMeta & { files?: SentFile[] } = {
      needsUser: true,
      ...(askOptions && askOptions.length > 0 ? { options: askOptions } : {}),
      ...(extra?.recommended !== undefined ? { recommended: extra.recommended } : {}),
      ...(extra?.gateRef !== undefined ? { gateRef: extra.gateRef } : {}),
      ...(extra?.blockerRef !== undefined ? { blockerRef: extra.blockerRef } : {}),
      ...(extra?.fileArgs !== undefined && extra.fileArgs.files.length > 0 ? { files: [...extra.fileArgs.files] } : {}),
    };
    let row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'agent', 'text', ?, ?, ?, ?, ?) RETURNING *`,
      session.conversationId,
      session.id,
      text,
      JSON.stringify(meta),
      `ask:${session.id}:${randomUUID()}`,
      t,
      t,
    )!;
    // The --file copies hang off this message id, so insert first and attach deliverables after.
    const fileDeliverables = extra?.fileArgs !== undefined ? deliverablesOfFileArgs(extra.fileArgs.args, extra.fileArgs.files, row.id) : [];
    const deliverables = mergeDeliverables([fileDeliverables, extra?.deliverables ?? []], DELIVERABLES_PER_CARD_MAX);
    if (deliverables.length > 0) {
      meta.deliverables = deliverables;
      row = db.get<MessageDbRow>("UPDATE messages SET meta = ? WHERE id = ? RETURNING *", JSON.stringify(meta), row.id)!;
    }
    const message = toMessage(row);
    p.changes.push({ type: "message.created", data: { message } });
    if (!extra?.skipRouterBridge && extra?.gateRef === undefined && extra?.blockerRef === undefined) {
      onIndependentAskCreated(p, session, message, askOptions);
    }
    return message;
  };

  const settleAskIn = (p: Pending, messageId: MessageId, settlement: AskSettlement): void => {
    const message = getMessage(messageId);
    if (message === null || message.meta === null || typeof message.meta !== "object") return;
    const current = message.meta as unknown as Record<string, unknown>;
    if (current.needsUser !== true) return;
    if (current.answered === true || current.closed === true || current.dismissed === true) return;
    const nextMeta =
      settlement.by === "close"
        ? { ...current, answered: true, closed: true }
        : {
            ...current,
            answered: true,
            ...(settlement.chosenOption !== undefined ? { chosenOption: settlement.chosenOption } : {}),
            ...(settlement.note !== undefined && settlement.note !== "" ? { answerNote: settlement.note } : {}),
          };
    if (JSON.stringify(nextMeta) === JSON.stringify(current)) return;
    db.run("UPDATE messages SET meta = ?, updated_at = ? WHERE id = ?", JSON.stringify(nextMeta), now(), messageId);
    p.changes.push({ type: "message.updated", data: { message: getMessage(messageId)! } });
  };

  const enqueueWakeupUserMessageIn = (
    p: Pending,
    input: { conversationId: ConversationId; dedupeKey: string; text: string },
  ): Message => {
    const existing = db.get<MessageDbRow>("SELECT * FROM messages WHERE dedupe_key = ?", input.dedupeKey);
    if (existing !== undefined) return toMessage(existing);
    if (!conversationExists(input.conversationId)) throw new ConversationNotFoundError(input.conversationId);
    assertUserCanPost(input.conversationId);
    const session = currentSession(input.conversationId);
    if (session === null) throw new Error(`conversation ${input.conversationId} has no agent session`);
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 'text', ?, ?, ?, 'queued', ?, ?) RETURNING *`,
      input.conversationId,
      session.id,
      session.workerId,
      input.text,
      JSON.stringify({ wakeup: true } satisfies UserMessageMeta),
      input.dedupeKey,
      t,
      t,
    )!;
    const message = toMessage(row);
    enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
    p.changes.push({ type: "message.created", data: { message } });
    afterUserPost(p, input.conversationId);
    return message;
  };

  const insertSystemMessage = (p: Pending, conversationId: ConversationId, meta: SystemMessageMeta, text: string): Message => {
    const t = now();
    const row = db.get<MessageDbRow>(
      `INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, created_at, updated_at)
       VALUES (?, 'system', 'text', ?, ?, ?, ?, ?) RETURNING *`,
      conversationId,
      text,
      JSON.stringify(meta),
      systemMessageDedupeKey(conversationId, meta),
      t,
      t,
    )!;
    const message = toMessage(row);
    p.changes.push({ type: "message.created", data: { message } });
    return message;
  };

  const checklist = createLedgerChecklist(ctx, (p, session, fields) => insertAgentMessage(ctx, p, session, fields));

  const keptAfterShutdown = (session: AgentSessionRow, id: MessageId) => {
    const row = db.get<Pick<MessageDbRow, "sender">>("SELECT sender FROM messages WHERE id = ?", id);
    return row !== undefined && resumesAfterShutdown(session, row);
  };

  const dropCarriedRateLimit = (p: Pending, sessionId: SessionId) => {
    if (liveOf(sessionId).rateLimitReported !== true) sessions.dropRateLimitRejection(p, sessionId);
  };

  /** Attachment copies were made before the transaction opened, because the transaction cannot await I/O. */
  const applyEvent = (p: Pending, session: AgentSessionRow, event: Exclude<DriverEvent, TurnEndedEvent>, textMeta: AgentTextMeta | null = null) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        updateLive(p, sessionId, (l) => {
          if (l.activity === "stopping") idle(l);
          l.backgroundTasks = undefined;
          l.backgroundTaskList = undefined;
          clearStreaming(l);
        });
        return;
      case "message.cancelled":
        // Written but never taken by the agent before the stop, so it is not resent.
        for (const id of event.messageIds) transition(p, id, "cancelled", null, sessionId);
        return;
      case "message.requeued":
        // Written but reclaimed before the agent read it, so it goes back to the queue.
        for (const id of event.messageIds) {
          const message = getMessage(id);
          if (message?.status !== "delivered" || message.sessionId !== sessionId) continue;
          transition(p, id, "queued", null, sessionId);
          enqueue(p, { type: "session.send", params: { sessionId, messageId: id, source: message.sender === "system" ? "system" : "user" } });
        }
        return;
      case "message.delivered":
      case "message.processing": {
        const to = event.type === "message.delivered" ? "delivered" : "processing";
        for (const id of event.messageIds) transition(p, id, to, null, sessionId);
        dropCarriedRateLimit(p, sessionId);
        updateLive(p, sessionId, working(event.at, liveOf(sessionId).currentTool));
        return;
      }
      case "turn.started":
        dropCarriedRateLimit(p, sessionId);
        updateLive(p, sessionId, (l) => {
          clearStreaming(l);
          working(event.at, null, { type: "thinking" })(l);
        });
        return;
      case "agent.thinking":
        // Subtask events do not change the main agent state; fast tools stay hidden below MIN_TOOL_STEP_VISIBLE_MS to avoid flicker.
        if (event.parentToolUseId === undefined) {
          if (sessions.hasToolHold(sessionId)) {
            updateLive(p, sessionId, (l) => {
              clearStreaming(l);
            });
          } else {
            updateLive(p, sessionId, (l) => {
              clearStreaming(l);
              working(event.at, liveOf(sessionId).currentTool, { type: "thinking" })(l);
            });
          }
        }
        return;
      case "agent.text_delta":
      case "agent.tool_preview":
        return;
      case "agent.checklist":
        checklist.apply(p, session, event);
        return;
      case "agent.tool_running":
        if (event.parentToolUseId === undefined) {
          updateLive(p, sessionId, toolRunning(event.toolUseId, event.startedAt ?? event.at));
        }
        return;
      case "agent.tool_result":
        if (event.parentToolUseId === undefined) {
          sessions.finishTools(p, sessionId, event.toolUseIds, event.at);
        }
        return;
      case "agent.text": {
        const dedupeKey = agentMessageDedupeKey(sessionId, event.uuid);
        const replayed = db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", dedupeKey) !== undefined;
        const meta = replayed || session.conversationId === null ? null : textMeta;
        insertAgentMessage(ctx, p, session, { kind: "text", text: event.text, meta, dedupeKey });
        updateLive(p, sessionId, (l) => {
          if (event.parentToolUseId === undefined) clearStreaming(l);
          working(event.at, null, event.parentToolUseId === undefined ? { type: "text" } : undefined)(l);
        });
        return;
      }
      case "agent.tool":
        insertAgentMessage(ctx, p, session, {
          kind: "tool",
          text: summarizeToolCall(event.name, event.input),
          meta: { toolUseId: event.toolUseId, name: event.name },
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid, event.toolUseId),
        });
        updateLive(p, sessionId, (l) => {
          if (event.parentToolUseId === undefined) {
            clearStreaming(l);
            toolStarted(event.toolUseId, stepOfTool(event.name, event.input), event.pending ? null : event.startedAt ?? event.at)(l);
          } else {
            working(event.at, event.name)(l);
          }
        });
        return;
      case "background.changed":
        updateLive(p, sessionId, (l) => {
          l.backgroundTasks = event.count;
          l.backgroundTaskList = event.tasks;
        });
        return;
      case "rate_limit":
        updateLive(p, sessionId, (l) => {
          l.rateLimit = event.info;
          l.rateLimitReported = true;
        });
        return;
      case "api_retry":
        updateLive(p, sessionId, (l) => {
          l.apiRetry = event.info;
        });
        return;
      case "session.exited": {
        for (const id of event.messageIds) {
          if (event.reason === "shutdown" && keptAfterShutdown(session, id)) continue;
          if (event.reason === "interrupt" || event.reason === "shutdown") transition(p, id, "stopped", null, sessionId);
          else if (event.reason === "crash" || event.reason === "startup_failed") transition(p, id, "failed", exitFailureReason(event), sessionId);
        }
        updateLive(p, sessionId, (l) => {
          idle(l);
          l.backgroundTasks = undefined;
          l.backgroundTaskList = undefined;
          l.rateLimitReported = false;
        });
        return;
      }
      case "driver.error":
        for (const id of event.messageIds ?? []) transition(p, id, "failed", event.message, sessionId);
        reportHealthIn(p, "driver", event.message);
        return;
      case "driver.warning":
        if (session.conversationId !== null) {
          const meta: SystemMessageMeta = { event: "driver.warning", sessionId, uuid: event.uuid };
          if (db.get("SELECT 1 FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(session.conversationId, meta)) === undefined) insertSystemMessage(p, session.conversationId, meta, event.message);
        }
        return;
      case "context.compacted":
        if (session.conversationId !== null) {
          const meta: SystemMessageMeta = { event: "context.compacted", sessionId, uuid: event.uuid, trigger: event.trigger };
          if (db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(session.conversationId, meta)) === undefined) {
            insertSystemMessage(p, session.conversationId, meta, CONTEXT_COMPACTED_TEXT);
          }
        }
        if (liveOf(sessionId).streamingText !== undefined) {
          updateLive(p, sessionId, clearStreaming);
        } else {
          sessions.cancelStreamTimer(sessionId);
        }
        return;
      case "commands.changed":
        return;
    }
  };

  const settleTurn = (p: Pending, session: AgentSessionRow, event: TurnEndedEvent, facts: TurnCompletionFacts) => {
    const reason = event.error === undefined ? "turn_failed" : turnFailureReason(event.error);
    for (const id of event.messageIds) {
      if (event.shutdown === true && keptAfterShutdown(session, id)) continue;
      if (event.interrupted) transition(p, id, "stopped", null, session.id);
      else if (event.ok || facts.finishedWithText.includes(id)) transition(p, id, "replied", null, session.id);
      else transition(p, id, "failed", reason, session.id);
    }
    updateLive(p, session.id, (l) => {
      idle(l);
      l.rateLimitReported = false;
    });
  };

  const postUserMessage = (input: PostUserMessageInput): PostUserMessageResult => {
    return write((p) => {
      if (!conversationExists(input.conversationId)) throw new ConversationNotFoundError(input.conversationId);
      const dedupeKey = userMessageDedupeKey(input.conversationId, input.clientId);
      const existing = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
      if (existing !== undefined) return { messageId: existing.id };
      if (input.workerPick !== undefined && !isPmConversation(input.conversationId)) throw fail("invalid", WORKER_PICK_ONLY_PM_MESSAGE);
      assertUserCanPost(input.conversationId);
      const session = currentSession(input.conversationId);
      if (session === null) throw new Error(`conversation ${input.conversationId} has no agent session`);
      // Hidden vendor commands such as /clear and /model are not sent to the agent.
      const blocked = ctx.commandBlockReason(session, input.text);
      if (blocked !== null) throw fail("invalid", blocked);
      const t = now();
      const meta: UserMessageMeta | null =
        input.attachments?.length || input.workerPick !== undefined || input.origin !== undefined
          ? {
              ...(input.attachments?.length ? { attachments: input.attachments } : {}),
              ...(input.workerPick !== undefined ? { workerPick: input.workerPick } : {}),
              ...(input.origin !== undefined ? { origin: input.origin } : {}),
            }
          : null;
      const row = db.get<MessageDbRow>(
        `INSERT INTO messages (conversation_id, session_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 'text', ?, ?, ?, 'queued', ?, ?) RETURNING *`,
        input.conversationId,
        session.id,
        session.workerId,
        input.text,
        meta === null ? null : JSON.stringify(meta),
        dedupeKey,
        t,
        t,
      )!;
      dropRateLimitRejection(p, session.id);
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
      p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
      afterUserPost(p, input.conversationId);
      return { messageId: row.id };
    });
  };

  const composerTarget = (
    conversationId: ConversationId,
    worktreesDir: string,
    extraWorktreeRoots?: readonly string[],
  ): ComposerTarget => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    const session = currentSession(conversationId);
    if (session === null) throw new Error(`conversation ${conversationId} has no agent session`);
    const wtRoots = [worktreesDir, ...(extraWorktreeRoots ?? [])];
    const underWorktrees = (dir: string) => wtRoots.some((root) => isPathInsideOrEqual(root, dir));
    return {
      sessionId: session.id,
      vendor: session.vendor,
      cwd: session.cwd,
      addDirs: session.addDirs,
      fileRoots: [session.cwd, ...session.addDirs.filter((d) => !underWorktrees(d))],
    };
  };

  /** Turns that will not be replayed after a restart (PM or router answering the user); self-reload waits for these. */
  const turnsLostOnShutdown = (): Array<{ sessionId: SessionId; role: AgentRole }> =>
    workingSessionIds().flatMap((sessionId) => {
      const session = getAgentSession(db, sessionId);
      if (session === null) return [];
      const inFlight = db.all<Pick<MessageDbRow, "sender">>(
        `SELECT sender FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES}`,
        sessionId,
      );
      return inFlight.some((message) => !resumesAfterShutdown(session, message)) ? [{ sessionId, role: session.role }] : [];
    });

  const stopIn = (p: Pending, session: AgentSessionRow & { conversationId: ConversationId }): boolean => {
    const working = liveOf(session.id).activity !== "idle";
    const leftover =
      !working &&
      db.get(
        `SELECT 1 AS x FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES} LIMIT 1`,
        session.id,
      ) !== undefined;
    const queued = db.all<{ id: number }>(`SELECT id FROM messages WHERE session_id = ? AND sender = 'user' AND status = 'queued'`, session.id);
    if (!working && !leftover && queued.length === 0) return false;
    for (const { id } of queued) transition(p, id, "cancelled");
    if (working) {
      updateLive(p, session.id, (l) => {
        l.activity = "stopping";
        clearStreaming(l);
      });
    } else {
      p.after.push(() => sessions.cancelStreamTimer(session.id));
    }
    p.stops.push({ conversationId: session.conversationId, sessionId: session.id });
    return true;
  };

  const requestStop = (conversationId: ConversationId) => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    const session = currentSession(conversationId);
    if (session === null) return;
    write((p) => {
      stopIn(p, { ...session, conversationId });
    });
  };

  const rewindLastUserMessage = (conversationId: ConversationId): Message | null => {
    return write((p) => {
      if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
      assertUserCanPost(conversationId);
      const session = currentSession(conversationId);
      const stopping = session !== null && liveOf(session.id).activity === "stopping";
      const rows = db.all<MessageDbRow>(
        "SELECT * FROM messages WHERE conversation_id = ? AND sender != 'agent' ORDER BY id DESC LIMIT ?",
        conversationId,
        REWIND_SCAN_LIMIT,
      );
      const target = findRewindableMessage([...rows].reverse().map(toMessage), { stopping });
      if (target === null) return null;
      if (session !== null && (target.status === "queued" || target.status === "delivered" || target.status === "processing")) {
        stopIn(p, { ...session, conversationId });
      }
      db.run("UPDATE messages SET meta = json_set(COALESCE(meta, '{}'), '$.rewound', json('true')), updated_at = ? WHERE id = ?", now(), target.id);
      const updated = getMessage(target.id)!;
      p.changes.push({ type: "message.updated", data: { message: updated } });
      return updated;
    });
  };

  const messagesAfter = (conversationId: ConversationId, after: MessageId, limit: number): Message[] => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    return db
      .all<MessageDbRow>(`SELECT ${WEB_MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?`, conversationId, after, Math.max(0, limit))
      .map(toMessage);
  };

  const messagesBefore = (conversationId: ConversationId, before: MessageId): MessagesPage => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    return page(
      db.all<MessageDbRow>(
        `SELECT ${WEB_MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        conversationId,
        before,
        MESSAGE_PAGE_SIZE + 1,
      ),
    );
  };

  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    if (action.type === "session.send") transition(p, action.params.messageId, "failed", error, action.params.sessionId);
  };

  const stopMessage = (messageId: MessageId, sessionId?: SessionId) => {
    write((p) => {
      const status = getMessage(messageId)?.status;
      if (status === "delivered" || status === "processing") transition(p, messageId, "stopped", null, sessionId);
    });
  };

  const retryMessage = (messageId: MessageId): { messageId: MessageId } => {
    return write((p) => {
      const message = getMessage(messageId);
      if (message === null || !conversationExists(message.conversationId)) throw fail("not_found", `没有编号 ${messageId} 的消息`);
      if (message.sender !== "user") throw fail("conflict", "只能重试自己发的消息");
      if (message.status !== "failed") throw fail("conflict", "只有发送失败的消息能重试");
      assertUserCanPost(message.conversationId);
      const session = currentSession(message.conversationId);
      if (session === null) throw new Error(`conversation ${message.conversationId} has no agent session`);
      db.run(
        "UPDATE messages SET status = 'queued', failure_reason = NULL, meta = json_remove(meta, '$.deliveryConfirmed'), session_id = ?, updated_at = ? WHERE id = ?",
        session.id,
        now(),
        messageId,
      );
      if (!isLedgerWakeup(message)) dropRateLimitRejection(p, session.id);
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId, source: "user" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(messageId)! } });
      return { messageId };
    });
  };

  return {
    getMessage,
    page,
    transition,
    applyEvent,
    settleTurn,
    insertSystemMessage,
    insertAskMessage,
    settleAskIn,
    enqueueWakeupUserMessageIn,
    postUserMessage,
    composerTarget,
    requestStop,
    rewindLastUserMessage,
    stopIn,
    turnsLostOnShutdown,
    messagesBefore,
    messagesAfter,
    actionFailedIn,
    stopMessage,
    retryMessage,
  };
}
