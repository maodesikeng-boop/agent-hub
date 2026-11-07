// 换新会话：项目经理的上下文太长时，先让它写交接，再换一个新会话接着干。用户看来还是同一个对话，聊天里只多一条很淡的分隔线。
// 两种起法：资料页的“开新会话”（renewSession），和对话长到 AUTO_RENEW_CONTEXT_TOKENS 后空闲一会儿自动换（runAutoRenew，守护进程定时调）。
// 1. 给现在这一代会话发一条 handover.requested（H，source system）。H 要等这个会话空闲才发（单独一轮，不混进别的回合）；
//    这一轮 agent 的文字、工具调用入库时记 meta.handover（messages.ts），网页不显示、不算未读；
// 2. 那一轮正常结束（applyDriverEvent → afterDriverEvent）时同一个事务里换代：旧会话登记 session.end；建 generation + 1 的会话
//    （工作目录、模型、思考程度抄旧的；提示词、启动参数照常由启动准备按项目经理现在的设置拼）；记一行 session.renewed（R，只给人看，
//    text 是交接全文，网页显示成分隔线）。新会话不另开一轮：开场说明 + 交接 + 最近 HANDOVER_RECENT_MESSAGES 条原话由驱动层拼在
//    第一条真正写给它的消息前面（sessionPreamble）；带着它的那一行开始处理时（message.processing 的 preamble）记 R 的 seen，之后不再拼；
// 3. 换代期间（H 还没结果）这个对话里同一代或更晚的别的消息都压着（waitsForHandover），换代时改发给新会话，带着上面的开场说明；
// 4. H 没写成（失败、被停止、写了超过 HANDOVER_TIMEOUT_MS 被停掉、正常回完却一个字没写）：不换代，压着的消息照常发给旧会话。
//    用户点的对话里提示一句；自动换的不提示，等之后又有一轮正常结束、再空闲、过了退避（AUTO_RENEW_RETRY_BACKOFF_MS，每次翻倍）
//    时再试，每一代最多自动试 AUTO_RENEW_MAX_ATTEMPTS 次，用完记一条日志、这一代不再自动换（用户点的照常）。
// 换代和那一轮的结果在同一个事务里：重启只会落在换代前（交接请求按“至少一次”重发给旧会话）或换代后，不会换两次。
// H 的 meta 里另记几个字段（只有这里用）：requestedAt（登记、重新排队的时间）、startedAt 和 turnStartId（H 开始处理的时间、
// 那时库里最大的消息编号）、writing（agent 正在写交接的那一轮：H 开始处理起，到这个会话的这一轮结束、进程退出、或别的消息开始处理为止；
// 这期间 agent 的文字记 meta.handover，不看 H 现在的状态）、abandoned（超时请驱动层停掉了）、settled 和 failedAt（这次没成已经处理过、
// 什么时候；重新排队时清掉）、notices（提示过几次，做去重键）、autoAttempts（这一代自动试过几次）。R 的 meta 另记 seen（新会话读到开场说明了）。
import { agentTextOf } from "../../shared/attachments.ts";
import { systemEventOf, systemMessageDedupeKey } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import {
  AUTO_RENEW_CONTEXT_TOKENS,
  AUTO_RENEW_IDLE_MS,
  AUTO_RENEW_MAX_ATTEMPTS,
  AUTO_RENEW_RETRY_BACKOFF_MS,
  HANDOVER_RECENT_MESSAGES,
  HANDOVER_TIMEOUT_MS,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { getAgentSession } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage } from "./rows.ts";
import type { ConversationDbRow, MessageDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 找会话的原始记录（厂商自己存的文件，driver/transcript.ts 的 vendorTranscriptPath）；找不到是 null。 */
export type FindTranscript = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

export interface HandoverOptions {
  /** 默认都找不到（只给测试）；守护进程传 vendorTranscriptPath。 */
  findTranscript?: FindTranscript;
  /** 自动换新会话的门槛、空闲多久、写交接最多多久，默认见 limits.ts；冒烟测试改小。 */
  autoRenew?: { contextTokens?: number; idleMs?: number; timeoutMs?: number };
  /** 写守护进程日志（自动换新会话试满了次数）；默认不写。 */
  log?: (line: string) => void;
}

const SEARCH_COMMANDS = `\`${HUB_COMMAND} worker search\`、\`${HUB_COMMAND} worker show --task / --report\``;

/** 原始记录那一行：找得到写路径，找不到也说有这么个东西（新会话开场说明里会再给一次路径）。 */
const transcriptLine = (path: string | null) =>
  path === null ? "上一个会话的原始记录（厂商自己存的完整原文；这次没找到文件，翻不了）" : `上一个会话的原始记录：${path}（要查原话可以去翻）`;

/**
 * 发给旧会话：让项目经理把交接写成这一轮的回复。照 Claude Code 压缩上下文的提示词的写法（先讲后果，再分节写，最后一节附原话），
 * 换成项目经理的场景。auto：系统因为对话太长自动换的。
 */
export function handoverRequestText(options: { auto: boolean; transcriptPath: string | null }): string {
  const why = options.auto
    ? "【系统】你的对话太长了，系统要自动给你换一个新会话——这是系统定的，不是用户要换；用户看不到这一轮，也不知道换会话的事。"
    : "【系统】用户要给你换一个新会话（现在的上下文太长了）。";
  return `${why}这一轮请写一份交接，直接写成这一轮的回复。

这份交接会替换掉你现在的全部上下文。新会话手里只有：
- 最新的系统提示词和性格设定；
- 这份交接；
- 交接之前最近 ${HANDOVER_RECENT_MESSAGES} 条你和用户的原话；
- 能搜的账本：${SEARCH_COMMANDS}（派过的活、Worker 的汇报都在里面）；
- ${transcriptLine(options.transcriptPath)}。
交接里漏掉的，新会话连去找都不会知道要去找。所以要写的是理解，不是流水账：用户想做成什么、为什么，定了什么，试过和否掉了什么，做到哪了，下一步是什么。

按下面几节写：
1. 用户要做成什么、为什么：用户明确提过的每个要求和背后的用意，写细。
2. 定下的事：做法、约束、分工；用户纠正过的做法单独写清楚（原来怎么做、用户要怎么做）。
3. 试过和否掉的：试过什么办法、为什么不行，免得新会话再走一遍。
4. 在跑的 Worker 和 PR：编号、在做什么、到哪一步、在等什么。
5. 在等用户拍板的事：每件写清楚选项，并带上你的推荐。
6. 用户这段时间说过的话：要点逐条列全，规矩、约束类的保留原话。
7. 下一步：接下来要做什么，附上最近对话里的原话（用户最后要的是什么、你做到哪了），一字不改，免得新会话跑偏。

你这个会话开头要是带着上一份交接：它的第 1 节和第 5 节原样带过来，再补上之后新的。
控制在 2000 字左右。做过的细节（任务说明、汇报全文、命令输出）账本里搜得到，不往交接里抄，写一句去哪搜就行。
这一轮只写交接：不回复用户、不派活、不做别的事。`;
}

/** 新会话第一条消息前面的开场说明 + 交接 + 最近几条原话（驱动层拼在那条消息最前面，见 DriverOptions.sessionPreamble）。 */
export function sessionPreambleText(options: {
  auto: boolean;
  handover: string;
  recent: { sender: string; text: string }[];
  transcriptPath: string | null;
}): string {
  const lines = options.recent.map((m) => `${m.sender === "user" ? "用户" : "你"}：${m.text}`).join("\n\n");
  const why = options.auto ? "上一个会话对话太长，系统自动给你换了这个新会话" : "用户点了开新会话（上一个会话太长了）";
  return [
    `【系统】这是新会话：你还是同一个项目经理，接着上一个会话干。${why}，上一个会话写完交接后换成了你；用户那边还是同一个对话，不用跟用户提换会话的事。
下面是上一个会话写的交接，和交接之前最近几条你和用户的原话。还在跑的 Worker 照常会把汇报发给你。做过的细节用 ${SEARCH_COMMANDS} 搜；${transcriptLine(options.transcriptPath)}。
不用回复“已接上”：读完直接处理这段说明后面的那条消息。`,
    `## 交接\n\n${options.handover.trim() === "" ? "（上一个会话没有写交接）" : options.handover}`,
    `## 最近的原话\n\n${lines === "" ? "（没有）" : lines}`,
  ].join("\n\n");
}

/** 交接那一轮回完了却没写出文字：交接请求标失败，failureReason 是这个。 */
export const HANDOVER_EMPTY_REASON = "handover_empty";

/** 用户点的开新会话那一轮没写成时对话里的提示（自动换的不提示）。 */
export const HANDOVER_NOT_WRITTEN_TEXT = "交接没写成，没换会话";

/** H、R 的 meta（SystemMessageMeta 里那两种，加上只有这里用的几个字段，见文件开头）。 */
type HandoverMeta = {
  event: "handover.requested" | "session.renewed";
  sessionId: SessionId;
  fromSessionId?: SessionId;
  auto?: boolean;
  requestedAt?: number;
  startedAt?: number;
  turnStartId?: number;
  writing?: boolean;
  abandoned?: boolean;
  settled?: boolean;
  failedAt?: number;
  notices?: number;
  autoAttempts?: number;
  seen?: boolean;
};

const IN_FLIGHT = "('queued', 'delivered', 'processing')";
const IN_FLIGHT_STATUSES = new Set(["queued", "delivered", "processing"]);
/** 交接请求、换代那一行。 */
const IS_H = "sender = 'system' AND kind = 'text' AND json_extract(meta, '$.event') = 'handover.requested'";
const IS_R = "sender = 'system' AND kind = 'text' AND json_extract(meta, '$.event') = 'session.renewed'";
/** agent 的消息是写交接那一轮的（meta.handover，messages.ts）；meta 不是合法 JSON 的当不是。 */
const NOT_HANDOVER_TURN = "COALESCE(json_extract(CASE WHEN json_valid(meta) THEN meta END, '$.handover'), 0) != 1";

export type LedgerHandover = ReturnType<typeof createLedgerHandover>;

export function createLedgerHandover(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona, options: HandoverOptions = {}) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, updateLive, liveOf } = sessions;
  const { getMessage, insertSystemMessage, transition } = messages;
  const { requirePm, privateConversation } = persona;
  const findTranscript = options.findTranscript ?? (() => null);
  const contextTokens = options.autoRenew?.contextTokens ?? AUTO_RENEW_CONTEXT_TOKENS;
  const idleMs = options.autoRenew?.idleMs ?? AUTO_RENEW_IDLE_MS;
  const timeoutMs = options.autoRenew?.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  const log = options.log ?? (() => {});

  const metaOf = (row: Pick<MessageDbRow, "meta">): HandoverMeta => JSON.parse(row.meta!) as HandoverMeta;
  const setMeta = (id: MessageId, meta: HandoverMeta) => db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), id);
  const transcriptOf = (session: AgentSessionRow) => findTranscript({ vendor: session.vendor, vendorSessionId: session.vendorSessionId, cwd: session.cwd });

  /** 这一代会话的交接请求（每一代最多一条）。 */
  const requestOf = (session: AgentSessionRow): MessageDbRow | undefined =>
    db.get<MessageDbRow>(
      "SELECT * FROM messages WHERE dedupe_key = ?",
      systemMessageDedupeKey(session.conversationId!, { event: "handover.requested", sessionId: session.id }),
    );

  /** 交给这个新会话的换代那一行。 */
  const renewedOf = (session: AgentSessionRow): MessageDbRow | undefined =>
    db.get<MessageDbRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND ${IS_R} AND json_extract(meta, '$.sessionId') = ? ORDER BY id DESC LIMIT 1`,
      session.conversationId,
      session.id,
    );

  /** 登记（或把上次没成的同一条重新排队）这一代的交接请求。 */
  const requestIn = (p: Pending, session: AgentSessionRow, auto: boolean): MessageId => {
    const t = now();
    const text = handoverRequestText({ auto, transcriptPath: transcriptOf(session) });
    const existing = requestOf(session);
    if (existing === undefined) {
      const meta: HandoverMeta = { event: "handover.requested", sessionId: session.id, ...(auto ? { auto: true, autoAttempts: 1 } : {}), requestedAt: t };
      const row = db.get<MessageDbRow>(
        `INSERT INTO messages (conversation_id, session_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
         VALUES (?, ?, 'system', 'text', ?, ?, ?, 'queued', ?, ?) RETURNING *`,
        session.conversationId,
        session.id,
        text,
        JSON.stringify(meta),
        systemMessageDedupeKey(session.conversationId!, { event: "handover.requested", sessionId: session.id }),
        t,
        t,
      )!;
      p.changes.push({ type: "message.created", data: { message: toMessage(row) } });
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: row.id, source: "system" } });
      return row.id;
    }
    // 还在等就是它；上一次被停止、失败了，同一条重新排队（文字按这一次是谁要换的重写）
    if (existing.status === "stopped" || existing.status === "failed") {
      const { notices, autoAttempts = 0, writing } = metaOf(existing);
      const attempts = autoAttempts + (auto ? 1 : 0);
      const meta: HandoverMeta = {
        event: "handover.requested",
        sessionId: session.id,
        ...(auto ? { auto: true } : {}),
        requestedAt: t,
        ...(notices !== undefined ? { notices } : {}),
        ...(attempts > 0 ? { autoAttempts: attempts } : {}),
        // 上一次被标了停止、驱动层那一轮还没真停下来：那一轮剩下的文字照样不显示
        ...(writing === true ? { writing } : {}),
      };
      db.run("UPDATE messages SET status = 'queued', failure_reason = NULL, text = ?, meta = ?, updated_at = ? WHERE id = ?", text, JSON.stringify(meta), t, existing.id);
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: existing.id, source: "system" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(existing.id)! } });
    }
    return existing.id;
  };

  const renewSession = (pmId: PmId): { messageId: MessageId } =>
    write((p) => {
      requirePm(pmId);
      const conversation = privateConversation(pmId)!;
      return { messageId: requestIn(p, currentSession(conversation.id)!, false) };
    });

  /**
   * 压着不发：交接请求自己等它的会话空闲（单独一轮）；别的消息在同一代或更早的交接请求还没结果（排队、已送达、处理中）时等，
   * 换代后发给新会话。
   */
  const waitsForHandover = (messageId: MessageId): boolean => {
    const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (row === undefined) return false;
    if (systemEventOf(toMessage(row))?.event === "handover.requested") return row.session_id !== null && liveOf(row.session_id).activity !== "idle";
    return (
      db.get(
        `SELECT 1 AS x FROM agent_sessions ms
         JOIN messages h ON h.conversation_id = ? JOIN agent_sessions hs ON hs.id = h.session_id
         WHERE ms.id = ? AND h.id != ? AND hs.generation <= ms.generation
           AND h.sender = 'system' AND h.kind = 'text' AND json_extract(h.meta, '$.event') = 'handover.requested' AND h.status IN ${IN_FLIGHT}
         LIMIT 1`,
        row.conversation_id,
        row.session_id,
        messageId,
      ) !== undefined
    );
  };

  /** 交接之前（upTo 含）最近几条用户和项目经理的原话：用户的只取已回复的，项目经理的不取写交接那几轮的。 */
  const recentOf = (conversationId: ConversationId, upTo: number) =>
    db
      .all<MessageDbRow>(
        `SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND kind = 'text'
           AND ((sender = 'agent' AND ${NOT_HANDOVER_TURN}) OR (sender = 'user' AND status = 'replied'))
         ORDER BY id DESC LIMIT ?`,
        conversationId,
        upTo,
        HANDOVER_RECENT_MESSAGES,
      )
      .reverse()
      .map((row) => ({ sender: row.sender, text: agentTextOf(toMessage(row)) }));

  /** 交接全文：交接那一轮开始时库里最大的编号（turnStartId）之后，旧会话说的文字。 */
  const handoverTextOf = (old: AgentSessionRow, request: MessageDbRow): string =>
    db
      .all<{ text: string }>(
        "SELECT text FROM messages WHERE session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id",
        old.id,
        metaOf(request).turnStartId ?? request.id,
      )
      .map((r) => r.text)
      .join("\n\n");

  /** 换代。request 是旧会话里刚回完的交接请求，handover 是它写的交接（不空）。 */
  const renew = (p: Pending, old: AgentSessionRow, request: MessageDbRow, handover: string) => {
    const conversationId = old.conversationId!;
    const requestMeta = metaOf(request);
    const turnStart = requestMeta.turnStartId ?? request.id;

    const next = insertSession(p, {
      conversationId,
      pmId: old.pmId,
      cwd: old.cwd,
      addDirs: old.addDirs,
      generation: old.generation + 1,
      vendor: old.vendor as AgentVendor,
      model: old.model,
      effort: old.effort,
    });
    // 旧会话刚报额度用完的话，新会话也要知道，不然第一条立刻撞上额度失败
    if (old.rateLimit !== null) {
      db.run("UPDATE agent_sessions SET rate_limit = ? WHERE id = ?", JSON.stringify(old.rateLimit), next.id);
      updateLive(p, next.id, () => {});
    }
    enqueue(p, { type: "session.end", params: { sessionId: old.id, generation: old.generation } });
    const auto = requestMeta.auto === true;
    insertSystemMessage(p, conversationId, { event: "session.renewed", sessionId: next.id, fromSessionId: old.id, turnStartId: turnStart, ...(auto ? { auto } : {}) }, handover);
    // 换代期间压着的消息（用户的、Worker 的汇报）改发给新会话：第一条写进去时驱动层在前面拼开场说明
    const held = db.all<MessageDbRow>("SELECT * FROM messages WHERE session_id = ? AND status = 'queued' ORDER BY id", old.id);
    for (const row of held) {
      db.run("UPDATE messages SET session_id = ?, updated_at = ? WHERE id = ?", next.id, now(), row.id);
      enqueue(p, { type: "session.send", params: { sessionId: next.id, messageId: row.id, source: row.sender === "user" || row.sender === "pm" ? "user" : "system" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(row.id)! } });
    }
  };

  /** 驱动层往新会话写一行之前问（DriverOptions.sessionPreamble）：还没读到开场说明就给全文，否则 null。 */
  const sessionPreamble = (sessionId: SessionId): string | null => {
    const session = getAgentSession(db, sessionId);
    if (session === null || session.role !== "pm" || session.conversationId === null || session.generation <= 1) return null;
    const row = renewedOf(session);
    // 升级前手动换代留下的那一行是发给 agent 的（有状态，早就读过）；现在这一行状态恒为 null
    if (row === undefined || row.status !== null) return null;
    const meta = metaOf(row);
    if (meta.seen === true) return null;
    const old = meta.fromSessionId === undefined ? null : getAgentSession(db, meta.fromSessionId);
    return sessionPreambleText({
      auto: meta.auto === true,
      handover: row.text,
      recent: recentOf(session.conversationId, meta.turnStartId ?? row.id),
      transcriptPath: old === null ? null : transcriptOf(old),
    });
  };

  /** agent 不再写这条交接请求的那一轮了（见文件开头的 writing）。 */
  const endWriting = (request: MessageDbRow) => {
    const meta = metaOf(request);
    if (meta.writing === true) setMeta(request.id, { ...meta, writing: false });
  };

  /** 这个对话里刚没成（失败、被停止）还没处理过的交接请求：用户点的提示一句，自动换的不提示。 */
  const settleFailures = (p: Pending, conversationId: ConversationId) => {
    const rows = db.all<MessageDbRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND ${IS_H} AND status IN ('failed', 'stopped') AND json_extract(meta, '$.settled') IS NOT 1`,
      conversationId,
    );
    for (const row of rows) {
      const meta = metaOf(row);
      const settled = { ...meta, settled: true, failedAt: now() };
      if (meta.auto === true) {
        setMeta(row.id, settled);
        if ((meta.autoAttempts ?? 0) >= AUTO_RENEW_MAX_ATTEMPTS) {
          log(`[auto-renew] 项目经理 ${meta.sessionId} 号会话自动换新会话试了 ${meta.autoAttempts} 次都没写成交接，这一代不再自动换（资料页的“开新会话”照常能用）`);
        }
        continue;
      }
      const attempt = (meta.notices ?? 0) + 1;
      setMeta(row.id, { ...settled, notices: attempt });
      insertSystemMessage(p, row.conversation_id, { event: "handover.failed", messageId: row.id, attempt }, HANDOVER_NOT_WRITTEN_TEXT);
    }
  };

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "pm" || session.conversationId === null) return;
    if (event.type === "message.processing") {
      // 带着开场说明的那一行开始处理：agent 读到了，之后不再拼
      if (event.preamble === true && session.generation > 1) {
        const renewed = renewedOf(session);
        if (renewed !== undefined && metaOf(renewed).seen !== true) setMeta(renewed.id, { ...metaOf(renewed), seen: true });
      }
      // H 开始处理：记下那一刻库里最大的编号（之后的文字才是交接）和时间（算超时），从这起 agent 在写交接（writing）；
      // 之前请驱动层停过却没东西可停的（守护进程停了很久再起，超时检查跑在重发之前）不算数，超时了重新请它停
      const request = requestOf(session);
      if (request === undefined) return;
      if (event.messageIds.includes(request.id)) {
        const max = db.get<{ id: number }>("SELECT max(id) AS id FROM messages")!.id;
        const { abandoned: _, ...meta } = metaOf(request);
        setMeta(request.id, { ...meta, turnStartId: max, startedAt: now(), writing: true });
      } else endWriting(request);
      return;
    }
    // 这个会话的这一轮结束、进程退出：写交接那一轮（如果是）到此为止
    if (event.type === "turn.ended" || event.type === "session.exited") {
      const request = requestOf(session);
      if (request !== undefined) endWriting(request);
    }
    // 只有这几种事件会把消息标成失败、已停止（交接请求是系统消息，停止时不取消：stop-untaken.ts）
    if (event.type === "turn.ended" || event.type === "session.exited" || event.type === "driver.error") settleFailures(p, session.conversationId);
    // 交接请求那一轮正常结束（已回复），而且它的会话还是最新一代（重放的同一个事件不会再换）：换代
    if (event.type !== "turn.ended" || !event.ok || event.interrupted) return;
    for (const id of event.messageIds) {
      const row = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", id);
      const meta = row === undefined ? null : systemEventOf(toMessage(row));
      if (meta?.event !== "handover.requested" || row!.status !== "replied" || meta.sessionId !== session.id) continue;
      if (currentSession(session.conversationId)?.id !== session.id) return;
      // 回完了却一个字没写（只调了工具、回了空）：当没写成，不换代（不然新会话什么都接不上）
      const handover = handoverTextOf(session, row!);
      if (handover.trim() === "") {
        db.run("UPDATE messages SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", HANDOVER_EMPTY_REASON, now(), row!.id);
        p.changes.push({ type: "message.updated", data: { message: getMessage(row!.id)! } });
        settleFailures(p, session.conversationId);
        return;
      }
      renew(p, session, row!, handover);
      return;
    }
  };

  /** session.send 次数用完（ledger.onActionFailed，消息已经标了 failed）。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type !== "session.send") return;
    const conversationId = getMessage(action.params.messageId)?.conversationId;
    if (conversationId !== undefined) settleFailures(p, conversationId);
  };

  /**
   * 该自动换了：对话够长；这一代最后一条交给它的消息正常回完（没被打断、没失败；上次交接没写成的，要等之后又有一轮回完）；
   * 没有排队、在路上的消息；会话空闲（没有后台任务）已经 idleMs 了；这一代自动试的次数没满、上次没成之后过了退避。
   */
  const dueForAutoRenew = (session: AgentSessionRow, t: number): boolean => {
    if (session.usage.context < contextTokens || session.status === "ended" || session.status === "broken") return false;
    const live = liveOf(session.id);
    if (live.activity !== "idle" || (live.backgroundTasks ?? 0) > 0) return false;
    if (db.get(`SELECT 1 AS x FROM messages WHERE conversation_id = ? AND status IN ${IN_FLIGHT} LIMIT 1`, session.conversationId) !== undefined) return false;
    const last = db.get<MessageDbRow>("SELECT * FROM messages WHERE session_id = ? AND status IS NOT NULL ORDER BY id DESC LIMIT 1", session.id);
    if (last === undefined || last.status !== "replied" || systemEventOf(toMessage(last))?.event === "handover.requested") return false;
    // 这一代自动试过的：试满了不再试；没满的要过了退避（每没成一次翻倍）
    const request = requestOf(session);
    if (request !== undefined) {
      const { autoAttempts = 0, failedAt } = metaOf(request);
      if (autoAttempts >= AUTO_RENEW_MAX_ATTEMPTS) return false;
      if (autoAttempts > 0 && failedAt !== undefined && t - failedAt < AUTO_RENEW_RETRY_BACKOFF_MS * 2 ** (autoAttempts - 1)) return false;
    }
    const latest = db.get<{ at: number | null }>("SELECT max(updated_at) AS at FROM messages WHERE conversation_id = ?", session.conversationId)!.at ?? 0;
    return t - Math.max(latest, session.lastEventAt ?? 0) >= idleMs;
  };

  /** 写交接超时：还没写进去的直接标已停止；写进去了的请驱动层停掉那一轮（turn.ended 再标已停止），停不下来再过一个超时直接标。 */
  const abandonIn = (p: Pending, session: AgentSessionRow, request: MessageDbRow, meta: HandoverMeta) => {
    if (request.status === "queued" || meta.abandoned === true) {
      transition(p, request.id, "stopped");
      settleFailures(p, session.conversationId!);
      return;
    }
    setMeta(request.id, { ...meta, abandoned: true, startedAt: now() });
    p.stops.push({ conversationId: session.conversationId!, sessionId: session.id });
  };

  /**
   * 守护进程每 AUTO_RENEW_TICK_MS 调一次：每个项目经理的当前会话，写交接超时的放弃；该自动换的发交接请求。
   * 先只读，有事要做才开事务。
   */
  const runAutoRenew = (): void => {
    const t = now();
    const conversations = db.all<ConversationDbRow>("SELECT * FROM conversations WHERE kind = 'pm' AND pm_id IS NOT NULL ORDER BY id");
    for (const conversation of conversations) {
      const session = currentSession(conversation.id);
      if (session === null || session.role !== "pm") continue;
      const request = requestOf(session);
      if (request !== undefined && IN_FLIGHT_STATUSES.has(request.status!)) {
        const meta = metaOf(request);
        // 还排着、会话在忙（用户点的开新会话碰上正在跑的一轮）：等那一轮结束才开始算
        if (request.status === "queued" && liveOf(session.id).activity !== "idle") continue;
        const since = meta.startedAt ?? meta.requestedAt ?? request.created_at;
        if (t - since >= timeoutMs) write((p) => abandonIn(p, session, request, meta));
        continue;
      }
      if (dueForAutoRenew(session, t)) write((p) => requestIn(p, session, true));
    }
  };

  return { renewSession, waitsForHandover, afterDriverEvent, actionFailedIn, sessionPreamble, runAutoRenew };
}
