// 账本里的消息：用户发消息、停止、重试，驱动层事件变成 agent 的消息和消息状态，系统消息。
// 消息状态只按 MESSAGE_STATUS_TRANSITIONS 改（transition）。
import { randomUUID } from "node:crypto";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { MessagesPage } from "../../shared/api.ts";
import type { UserMessageMeta } from "../../shared/attachments.ts";
import { agentMessageDedupeKey, canTransitionMessage, systemMessageDedupeKey, userMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, AskMeta, ConversationId, Message, MessageId, MessageStatus, SessionId, SystemMessageMeta } from "../../shared/domain.ts";
import { turnFailureReason } from "../../shared/driver.ts";
import type { DriverEvent, SessionExitedEvent } from "../../shared/driver.ts";
import { ConversationNotFoundError } from "../../shared/ledger.ts";
import type { ComposerTarget, PostUserMessageInput, PostUserMessageResult } from "../../shared/ledger.ts";
import { MESSAGE_PAGE_SIZE } from "../../shared/limits.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { toMessage } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import type { LedgerSentFiles } from "./sent-files.ts";
import { idle, toolFinished, toolStarted, working } from "./sessions.ts";
import type { LedgerSessions } from "./sessions.ts";
import { stepOfTool, summarizeToolCall } from "./tool-summary.ts";

const ACTIVE_MESSAGE_STATUSES = "('delivered', 'processing')";
const WORKER_PICK_ONLY_PM_MESSAGE = "指定 Worker 用的厂商、模型只能用在项目经理的对话里";

/** agent 压缩了上下文之后对话里那一行（domain.ts 的 context.compacted）。 */
export const CONTEXT_COMPACTED_TEXT = "已压缩上下文";

export function exitFailureReason(event: SessionExitedEvent): string {
  if (event.signal !== null) return `${event.reason}: signal ${event.signal}`;
  if (event.exitCode !== null) return `${event.reason}: exit code ${event.exitCode}`;
  return event.reason;
}

/**
 * 守护进程关机打断的一轮（M3，m3-plan 第 3 节接口约定、验收第 11 条）：哪些消息不标已停止，还是已送达、处理中，
 * 重启恢复（sessions.ts 的 recoverAfterRestart）把它重发给同一个会话，接着做完：
 * - Worker 会话里的消息（任务说明、打回）：Worker 接着做完再汇报；也不发“这一轮没做完”（workers.ts）；
 * - 系统交给 agent 的消息（sender system：Worker 的汇报、turn_failed 那几行，见 workers.ts 的 insertLine）：
 *   项目经理重启后照样收到，不用等用户提醒。
 * 用户自己发的照 M2 标已停止，用户自己再发。
 */
function resumesAfterShutdown(session: AgentSessionRow, message: Pick<MessageDbRow, "sender">): boolean {
  return session.role === "worker" || message.sender === "system";
}

export type LedgerMessages = ReturnType<typeof createLedgerMessages>;

export interface LedgerMessagesOptions {
  /**
   * 用户往这个对话发消息、重试之前的检查，不让发就抛 LedgerRequestError（在事务里调）。
   * 现在只有 Worker 收工后不收（workers.ts 的 assertWorkerOpenForUser，ledger.ts 接上）。
   */
  assertUserCanPost?: (conversationId: ConversationId) => void;
  /** 用户发出一条消息之后（同一个事务里）：项目经理正在本会话写交接的，要停掉那一轮（ledger/handover.ts 的 userPostedIn，ledger.ts 接上）。 */
  afterUserPost?: (p: Pending, conversationId: ConversationId) => void;
}

export function createLedgerMessages(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  sentFiles: LedgerSentFiles,
  options: LedgerMessagesOptions = {},
) {
  const assertUserCanPost = options.assertUserCanPost ?? (() => {});
  const afterUserPost = options.afterUserPost ?? (() => {});
  const { db, now, write, enqueue, reportHealthIn } = ctx;
  const { currentSession, liveOf, updateLive } = sessions;

  /** 老的项目群（11-03 拿掉了）当作不存在。 */
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

  /** 按 MESSAGE_STATUS_TRANSITIONS 改状态；不合法（包括同状态）、找不到、没有状态的消息忽略。 */
  const transition = (p: Pending, id: MessageId, to: MessageStatus, reason: string | null = null) => {
    const message = getMessage(id);
    if (message === null || message.status === null || !canTransitionMessage(message.status, to)) return;
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

  const insertAgentMessage = (
    p: Pending,
    session: AgentSessionRow,
    fields: { kind: "text" | "tool"; text: string; meta: Record<string, unknown> | null; dedupeKey: string },
  ) => {
    if (session.conversationId === null) return;
    const t = now();
    // 项目经理在写交接（这个会话的交接请求开始处理后的那一轮，meta.writing，ledger/handover.ts）：这一轮的文字、工具调用记 handover，
    // 网页不显示。按请求自己记的标记认，不看它现在的状态：超时被标了已停止、驱动层那一轮还在写的，照样不显示
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
      fields.kind === "tool" ? 1 : 0,
      fields.dedupeKey,
      t,
      t,
    );
    if (row !== undefined) p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
  };

  /** hub ask：项目经理对话里一条带 needsUser 标记的消息（AskMeta）。不发给 agent，每次都是新的一条。 */
  const insertAskMessage = (p: Pending, session: AgentSessionRow, text: string, options?: string[]): Message => {
    const t = now();
    const meta: AskMeta = options && options.length > 0 ? { needsUser: true, options } : { needsUser: true };
    const row = db.get<MessageDbRow>(
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
    const message = toMessage(row);
    p.changes.push({ type: "message.created", data: { message } });
    return message;
  };

  /**
   * 用户在这个对话里发了一条消息：之前没回答的 hub ask 都标成已回答（meta.answered），推 message.updated。
   * 只有用户自己发的消息走到这里；agent、Worker 汇报、系统消息不算回答。
   */
  const answerAsks = (p: Pending, conversationId: ConversationId, before: MessageId) => {
    const rows = db.all<MessageDbRow>(
      // meta 不是合法 JSON 的行跳过（CASE 保证先判断 json_valid），不让一行脏数据挡住用户发消息
      `SELECT * FROM messages WHERE conversation_id = ? AND sender = 'agent' AND id < ?
         AND CASE WHEN json_valid(meta)
           THEN json_extract(meta, '$.needsUser') = 1 AND json_extract(meta, '$.answered') IS NULL AND json_extract(meta, '$.dismissed') IS NULL
           ELSE 0 END`,
      conversationId,
      before,
    );
    for (const row of rows) {
      const message = toMessage(row);
      db.run("UPDATE messages SET meta = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...message.meta, answered: true }), now(), message.id);
      p.changes.push({ type: "message.updated", data: { message: getMessage(message.id)! } });
    }
  };

  /** 写一条只给人看的系统消息（规则见 domain.ts 的 SystemMessageMeta）：没有会话、没有状态。 */
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

  /** 关机打断时这条消息留着重启后重发（resumesAfterShutdown）。 */
  const keptAfterShutdown = (session: AgentSessionRow, id: MessageId) => {
    const row = db.get<Pick<MessageDbRow, "sender">>("SELECT sender FROM messages WHERE id = ?", id);
    return row !== undefined && resumesAfterShutdown(session, row);
  };

  const applyEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    const sessionId = session.id;
    switch (event.type) {
      case "session.started":
        // 状态（running）由驱动层写进那一行；这里只清掉上一次没等到退出的“正在停”
        updateLive(p, sessionId, (l) => {
          if (l.activity === "stopping") idle(l);
          // 后台任务跟着进程走，新进程不带着旧的
          l.backgroundTasks = undefined;
        });
        return;
      case "message.cancelled":
        // 写给 agent 了、它还没取走就停了（或会话结束了）：agent 没看到过，不重发（驱动层不会再写）
        for (const id of event.messageIds) transition(p, id, "cancelled");
        return;
      case "message.requeued":
        // 写给 agent 了、它还没取走就收回了（进程没了、这一轮没读它就结束了）：放回排队中，重新登记发送，agent 没看到过、不加重发说明
        for (const id of event.messageIds) {
          const message = getMessage(id);
          if (message?.status !== "delivered" || message.sessionId === null) continue;
          transition(p, id, "queued");
          enqueue(p, { type: "session.send", params: { sessionId: message.sessionId, messageId: id, source: message.sender === "user" ? "user" : "system" } });
        }
        return;
      case "message.delivered":
      case "message.processing": {
        const to = event.type === "message.delivered" ? "delivered" : "processing";
        for (const id of event.messageIds) transition(p, id, to);
        updateLive(p, sessionId, working(liveOf(sessionId).currentTool));
        return;
      }
      case "turn.started":
        // claude 自己开了一轮（后台任务完成等）：和写进去的消息开始处理一样显示在处理
        updateLive(p, sessionId, working(null));
        return;
      case "agent.thinking":
        // 子任务里的事件不改主 agent 的状态
        if (event.parentToolUseId === undefined) updateLive(p, sessionId, working(liveOf(sessionId).currentTool, { type: "thinking" }));
        return;
      case "agent.tool_result":
        if (event.parentToolUseId === undefined) updateLive(p, sessionId, toolFinished(event.toolUseIds));
        return;
      case "agent.text": {
        const dedupeKey = agentMessageDedupeKey(sessionId, event.uuid);
        // 回复里指向本机文件的链接：发出时存副本，meta 记 files（AgentTextMeta）。重放的同一条消息已经入过库，不再碰文件
        const replayed = db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", dedupeKey) !== undefined;
        const meta = replayed || session.conversationId === null ? null : sentFiles.metaFor(session, event.text);
        insertAgentMessage(p, session, { kind: "text", text: event.text, meta, dedupeKey });
        updateLive(p, sessionId, working(null, event.parentToolUseId === undefined ? { type: "text" } : undefined));
        return;
      }
      case "agent.tool":
        insertAgentMessage(p, session, {
          kind: "tool",
          text: summarizeToolCall(event.name, event.input),
          meta: { toolUseId: event.toolUseId, name: event.name, input: event.input },
          dedupeKey: agentMessageDedupeKey(sessionId, event.uuid, event.toolUseId),
        });
        updateLive(
          p,
          sessionId,
          event.parentToolUseId === undefined ? toolStarted(event.name, event.toolUseId, stepOfTool(event.name, event.input)) : working(event.name),
        );
        return;
      case "turn.ended": {
        const reason = event.error === undefined ? "turn_failed" : turnFailureReason(event.error);
        for (const id of event.messageIds) {
          if (event.shutdown === true && keptAfterShutdown(session, id)) continue;
          if (event.interrupted) transition(p, id, "stopped");
          else if (event.ok) transition(p, id, "replied");
          else transition(p, id, "failed", reason);
        }
        updateLive(p, sessionId, idle);
        return;
      }
      case "background.changed":
        updateLive(p, sessionId, (l) => {
          l.backgroundTasks = event.count;
        });
        return;
      case "rate_limit":
        updateLive(p, sessionId, (l) => {
          l.rateLimit = event.info;
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
          if (event.reason === "interrupt" || event.reason === "shutdown") transition(p, id, "stopped");
          else if (event.reason === "crash" || event.reason === "startup_failed") transition(p, id, "failed", exitFailureReason(event));
        }
        updateLive(p, sessionId, (l) => {
          idle(l);
          l.backgroundTasks = undefined;
        });
        return;
      }
      case "driver.error":
        for (const id of event.messageIds ?? []) transition(p, id, "failed", event.message);
        reportHealthIn(p, "driver", event.message);
        return;
      case "context.compacted":
        // 用户发的 /compact（或自动压缩）：对话里记一行，只给人看；这一轮照常由 turn.ended 收尾
        if (session.conversationId !== null) {
          const meta: SystemMessageMeta = { event: "context.compacted", sessionId, uuid: event.uuid, trigger: event.trigger };
          if (db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", systemMessageDedupeKey(session.conversationId, meta)) === undefined) {
            insertSystemMessage(p, session.conversationId, meta, CONTEXT_COMPACTED_TEXT);
          }
        }
        return;
      case "commands.changed":
        // 只给命令列表的缓存用（daemon/commands-catalog.ts），账本不管
        return;
    }
  };

  const postUserMessage = (input: PostUserMessageInput): PostUserMessageResult => {
    return write((p) => {
      if (!conversationExists(input.conversationId)) throw new ConversationNotFoundError(input.conversationId);
      const dedupeKey = userMessageDedupeKey(input.conversationId, input.clientId);
      const existing = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
      if (existing !== undefined) return { messageId: existing.id };
      // workerPick 是“这条消息里派的 Worker 用什么”，只有项目经理会派 Worker：别的对话带了不存
      if (input.workerPick !== undefined && !isPmConversation(input.conversationId)) throw fail("invalid", WORKER_PICK_ONLY_PM_MESSAGE);
      assertUserCanPost(input.conversationId);
      const session = currentSession(input.conversationId);
      if (session === null) throw new Error(`conversation ${input.conversationId} has no agent session`);
      // 隐藏的命令（/clear、/model……）不发给 agent：不存这条，回原因让网页显示（原因由厂商实现给，daemon/vendors/）
      const blocked = ctx.commandBlockReason(session, input.text);
      if (blocked !== null) throw fail("invalid", blocked);
      const t = now();
      // 有附件、有 workerPick 才写 meta（UserMessageMeta）；两样都没有的用户消息 meta 还是 null，和老消息一样
      const meta: UserMessageMeta | null =
        input.attachments?.length || input.workerPick !== undefined
          ? { ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.workerPick !== undefined ? { workerPick: input.workerPick } : {}) }
          : null;
      // Worker 对话里用户的话带上 Worker 编号（写给 Worker 时据此加标签，见 shared/worker.ts 的 deliveryText）
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
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "user" } });
      p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
      answerAsks(p, input.conversationId, row.id);
      afterUserPost(p, input.conversationId);
      return { messageId: row.id };
    });
  };

  /**
   * 输入框“/”“@”用（shared/ledger.ts 的 composerTarget）：这个对话最新一代的会话和它的目录。
   * “@”能搜的文件夹：工作目录 + 附加文件夹，去掉项目经理带着的 worktrees 目录（那是 Worker 的，不是“这个对话的工作文件夹”）。
   */
  const composerTarget = (conversationId: ConversationId, worktreesDir: string): ComposerTarget => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    const session = currentSession(conversationId);
    if (session === null) throw new Error(`conversation ${conversationId} has no agent session`);
    const underWorktrees = (dir: string) => dir === worktreesDir || dir.startsWith(`${worktreesDir.replace(/\/+$/, "")}/`);
    return {
      sessionId: session.id,
      vendor: session.vendor,
      cwd: session.cwd,
      addDirs: session.addDirs,
      fileRoots: [session.cwd, ...session.addDirs.filter((d) => !underWorktrees(d))],
    };
  };

  /**
   * 停止这个会话正在跑的一轮（在事务里调；网页“停止”和 hub worker end 共用）：排队的用户消息标已取消、标“正在停”、通知驱动层打断。
   * 没有要停的（空闲、没有排队、没有残留的处理中消息）什么也不做，返回 false。
   */
  const stopIn = (p: Pending, session: AgentSessionRow & { conversationId: ConversationId }): boolean => {
    const working = liveOf(session.id).activity !== "idle";
    // 重启后内存里是空闲、库里还有处理中的消息：进程不在，只记下停止请求，不标“正在停”（不会有事件把它清掉）
    const leftover =
      !working &&
      db.get(
        `SELECT 1 AS x FROM messages WHERE session_id = ? AND status IN ${ACTIVE_MESSAGE_STATUSES} LIMIT 1`,
        session.id,
      ) !== undefined;
    // 停止 = agent 还没看到的用户消息都取消（docs/mid-turn-messages.md 第 11 节）：还在排队的（没交给驱动层，或在驱动层自己的队列里）
    // 这里就标已取消，之后执行器再调 session.send 看到已取消就不发；驱动层队列里的那份由 driver.interrupt 丢掉。
    // 系统消息（Worker 汇报、定时任务、交接）不取消，停止后照常发。
    const queued = db.all<{ id: number }>(`SELECT id FROM messages WHERE session_id = ? AND sender = 'user' AND status = 'queued'`, session.id);
    if (!working && !leftover && queued.length === 0) return false;
    for (const { id } of queued) transition(p, id, "cancelled");
    if (working) {
      updateLive(p, session.id, (l) => {
        l.activity = "stopping";
      });
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

  const messagesBefore = (conversationId: ConversationId, before: MessageId): MessagesPage => {
    if (!conversationExists(conversationId)) throw new ConversationNotFoundError(conversationId);
    return page(
      db.all<MessageDbRow>(
        "SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
        conversationId,
        before,
        MESSAGE_PAGE_SIZE + 1,
      ),
    );
  };

  /** 动作彻底失败（在 ledger.onActionFailed 的事务里）：session.send 的那条消息标 failed。Worker 的另见 workers.ts。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow, error: string) => {
    // session.start 失败时执行器每次都已经记过 health，这里不再记
    if (action.type === "session.send") transition(p, action.params.messageId, "failed", error);
  };

  /** 只停写进去了的（已送达、处理中）；排队中的不归它管（queued → stopped 只给 Worker 收工用，见 workers.ts）。 */
  const stopMessage = (messageId: MessageId) => {
    write((p) => {
      const status = getMessage(messageId)?.status;
      if (status === "delivered" || status === "processing") transition(p, messageId, "stopped");
    });
  };

  const retryMessage = (messageId: MessageId): { messageId: MessageId } => {
    return write((p) => {
      const message = getMessage(messageId);
      // 老项目群里的消息也当作没有（群对外不存在）
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
    insertSystemMessage,
    insertAskMessage,
    postUserMessage,
    composerTarget,
    requestStop,
    stopIn,
    messagesBefore,
    actionFailedIn,
    stopMessage,
    retryMessage,
  };
}
