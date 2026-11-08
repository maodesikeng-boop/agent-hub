// 换新会话：项目经理的上下文太长时，复制一份它的会话在后台写交接，项目经理照常聊；写好后在它两轮之间换一个新会话接着干。
// 用户看来还是同一个对话，聊天里只多一条很淡的分隔线。方案见 docs/background-handover-design.md；这里是账本这一半（同步、只做判断），
// 干活的是 daemon/handover/runner.ts（跑腿的），两边的约定在 shared/handover.ts（LedgerHandoverWork）。
//
// 一次交接是 handovers 表的一行（0013），状态 queued → forking → writing → ready → switched，没成是 failed / abandoned：
// 1. 进队列：项目经理这一轮结束（turn.ended）时会话用量到 AUTO_RENEW_CONTEXT_TOKENS，同一个事务里登记一行 queued（auto）；资料页的
//    “开新会话”跳过门槛直接登记（auto = 0），已有一行在跑就并进去改成手动的（renewSession）。内存里有个对话队列（只是缓存，启动时一条查询重建）：
//    5 秒一次的检查（runAutoRenew）、跑腿的领活（claimHandover）都只看队列里的，队列空一条 SQL 都不跑；
// 2. 开始：跑腿的领活时，旧会话空闲、没有发给它还在路上的消息、过了退避 → forking，记切点（那一刻库里最大的消息编号），交出交接提示词；
// 3. 跑腿的复制好了（handoverForked → writing）、写完了（handoverWritten → ready）；写出来是空的、出错、超时（handoverFailed）→ failed；
// 4. 换代：ready 时旧会话空闲（没后台任务、没有在路上的消息）→ 同一个事务里换（switchIn）；否则之后发给旧会话的新消息压着（waitsForHandover），
//    旧会话这一轮结束（不管成没成、有没有被打断）时换，压着的改发给新会话。换代时开场说明定稿（交接 + 约 HANDOVER_RECENT_CHARS 字原话 +
//    切点之后的 Worker 汇报目录），存在这一行的 preamble；新会话预先起好进程（session.start），开场说明由驱动层拼在第一条消息前面（sessionPreamble）。
//    有后台任务时不压消息也不换，等后台任务没了；ready 放超过 HANDOVER_READY_MAX_MS 作废重来；切点之后聊得太多（HANDOVER_POST_CUT_MAX_CHARS）也作废重来；
// 5. 没成：自动的每一代最多算 AUTO_RENEW_MAX_ATTEMPTS 次（重启、关机、用户发消息打断、作废不算），之间按 AUTO_RENEW_RETRY_BACKOFF_MS 退避翻倍，
//    满了记一条日志、这一代不再自动试；手动的不自动重试，对话里提示一句。
// 兜底（这家厂商复制不了，跑腿的报 unsupported）：本会话写交接（method in_session）。和 #113 一样给旧会话发一条 handover.requested（H），
// 自动的要空闲 AUTO_RENEW_IDLE_MS 才发；这一轮 agent 的文字记 meta.handover（messages.ts），网页不显示；写交接时来了用户的消息就请驱动层停掉这一轮
// （不算失败次数），用户的消息等这一轮停下后照常发给旧会话；这一轮正常写完就在它的 turn.ended 里换代。
// H 的 meta 里另记几个字段（只有这里用）：handoverId、requestedAt、startedAt 和 turnStartId（H 开始处理的时间、那时库里最大的消息编号）、
// writing（agent 正在写交接的那一轮，见 messages.ts）、abandoned（超时请驱动层停掉了）、interruptedBy（用户发消息打断的）。R 的 meta 另记 seen。
import { agentTextOf } from "../../shared/attachments.ts";
import { describeFailure } from "../../shared/errors.ts";
import { systemEventOf, systemMessageDedupeKey, workerEventOf } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, MessageId, PmId, SessionId, TokenUsage } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { ForkRef, ForkerKind, HandoverCleanJob, HandoverFailure, HandoverId, HandoverJob, HandoverStatus } from "../../shared/handover.ts";
import {
  AUTO_RENEW_CONTEXT_TOKENS,
  AUTO_RENEW_IDLE_MS,
  AUTO_RENEW_MAX_ATTEMPTS,
  AUTO_RENEW_RETRY_BACKOFF_MS,
  HANDOVER_POST_CUT_MAX_CHARS,
  HANDOVER_READY_MAX_MS,
  HANDOVER_RECENT_CHARS,
  HANDOVER_TIMEOUT_MS,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { vendorLabel, type AgentSetting, type AgentVendor } from "../../shared/vendors.ts";
import { workerLineText } from "../../shared/worker.ts";
import { getAgentSession } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { pickRecent, recentText } from "./handover-recent.ts";
import type { RecentMessage } from "./handover-recent.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage, toPm } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 找会话的原始记录（厂商自己存的文件，driver/transcript.ts 的 vendorTranscriptPath）；找不到是 null。 */
export type FindTranscript = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

export interface HandoverOptions {
  /** 默认都找不到（只给测试）；守护进程传 vendorTranscriptPath。 */
  findTranscript?: FindTranscript;
  /** 自动换新会话的门槛、本会话写交接空闲多久才发、写交接最多多久，默认见 limits.ts；冒烟测试改小。 */
  autoRenew?: { contextTokens?: number; idleMs?: number; timeoutMs?: number };
  /** 写守护进程日志（自动换新会话试满了次数）；默认不写。 */
  log?: (line: string) => void;
  /** 有交接可以领了（shared/handover.ts 的 claimHandover）：守护进程接到跑腿的 wake。默认什么都不做。 */
  onHandoverClaimable?: () => void;
}

const SEARCH_COMMANDS = `\`${HUB_COMMAND} worker search\`、\`${HUB_COMMAND} worker show --task / --report\``;

/** 原始记录那一行：找得到写路径，找不到也说有这么个东西（新会话开场说明里会再给一次路径）。 */
const transcriptLine = (path: string | null) =>
  path === null ? "上一个会话的原始记录（厂商自己存的完整原文；这次没找到文件，翻不了）" : `上一个会话的原始记录：${path}（要查原话可以去翻）`;

/**
 * 交接提示词。照 Claude Code 压缩上下文的提示词的写法（先讲后果，再分节写），换成项目经理的场景。auto：系统因为对话太长自动换的。
 * forked：发给复制出来的那一份（后台写交接，平常都是）；否则发给项目经理会话本身（兜底的本会话写交接）。
 */
export function handoverRequestText(options: {
  auto: boolean;
  transcriptPath: string | null;
  forked: boolean;
  fromVendor?: string;
  toVendor?: string | null;
}): string {
  const why = options.auto
    ? "你的对话太长了，系统要自动给你换一个新会话——这是系统定的，不是用户要换；用户看不到这里，也不知道换会话的事。"
    : "用户要给你换一个新会话（现在的上下文太长了）。";
  const opening = options.forked
    ? `【系统】这是从你的会话复制出来的一份，只用来写交接：${why}用户看不到这里；这里没有 hub 凭证，不要调用工具，直接把交接写成这一轮的回复。`
    : `【系统】${why}这一轮请写一份交接，直接写成这一轮的回复。`;
  const only = options.forked ? "这一轮只写交接：不调用工具、不回复用户、不派活。" : "这一轮只写交接：不回复用户、不派活、不做别的事。";
  const vendorNote =
    options.toVendor != null && options.fromVendor !== undefined && options.toVendor !== options.fromVendor
      ? `\n新会话换成 ${vendorLabel(options.toVendor)}（${options.toVendor}），别写只有 ${vendorLabel(options.fromVendor)}（${options.fromVendor}）才有的工具用法（比如 claude 的后台任务、codex 的 apply_patch），写成要做的事和现在的状态。`
      : "";
  return `${opening}

这份交接会替换掉你现在的全部上下文。新会话手里只有：
- 最新的系统提示词和性格设定；
- 这份交接；
- 交接之前约 ${HANDOVER_RECENT_CHARS / 10_000} 万字你和用户的原话（写交接期间又聊的也会全部带上）；
- 能搜的账本：${SEARCH_COMMANDS}（派过的活、Worker 的汇报都在里面）；
- ${transcriptLine(options.transcriptPath)}。
交接里漏掉的，新会话连去找都不会知道要去找。所以要写的是理解，不是流水账：用户想做成什么、为什么，定了什么，试过和否掉了什么，做到哪了，下一步是什么。${vendorNote}

按下面几节写：
1. 用户要做成什么、为什么：用户明确提过的每个要求和背后的用意，写细。
2. 定下的事：做法、约束、分工；用户纠正过的做法单独写清楚（原来怎么做、用户要怎么做）。
3. 试过和否掉的：试过什么办法、为什么不行，免得新会话再走一遍。
4. 在跑的 Worker 和 PR：编号、在做什么、到哪一步、在等什么。
5. 在等用户拍板的事：每件写清楚选项，并带上你的推荐。
6. 用户这段时间说过的话：要点逐条列全，规矩、约束类的保留原话。
7. 下一步：写清楚最后在做什么、做到哪了、接下来要做什么。原话会另外带给新会话，这里不用抄。

你这个会话开头要是带着上一份交接：它的第 1 节和第 5 节原样带过来，再补上之后新的。
控制在 2000 字左右。做过的细节（任务说明、汇报全文、命令输出）账本里搜得到，不往交接里抄，写一句去哪搜就行。
${only}`;
}

/**
 * 新会话第一条消息前面的开场说明（换代时定稿，驱动层拼在那条消息最前面，见 DriverOptions.sessionPreamble）：
 * 说明 + 交接 + 原话（handover-recent.ts 拼好的）+ 交接之后到的 Worker 汇报目录（每条一行，不带全文）。
 */
export function sessionPreambleText(options: {
  auto: boolean;
  handover: string;
  recent: string;
  reports: string[];
  transcriptPath: string | null;
  fromVendor?: string;
  toVendor?: string;
}): string {
  const why = options.auto ? "上一个会话对话太长，系统自动给你换了这个新会话" : "用户点了开新会话（上一个会话太长了）";
  const switchedVendor = options.fromVendor !== undefined && options.toVendor !== undefined && options.fromVendor !== options.toVendor;
  const vendorNote = switchedVendor ? `上一个会话是 ${vendorLabel(options.fromVendor!)}（${options.fromVendor}），提到的工具名按你自己的工具理解。` : "";
  const transcript =
    switchedVendor && options.fromVendor === "agy" && options.toVendor !== "agy"
      ? "上一个会话的原始记录：格式是 agy 的，读不了，只看交接和原话"
      : transcriptLine(options.transcriptPath);
  const parts = [
    `【系统】这是新会话：你还是同一个项目经理，接着上一个会话干。${why}，上一个会话写完交接后换成了你；用户那边还是同一个对话，不用跟用户提换会话的事。${vendorNote}
下面是上一个会话写的交接，和交接之前约 ${HANDOVER_RECENT_CHARS / 10_000} 万字你和用户的原话。交接写于切点，之后的事看下面的原话和 Worker 汇报目录。还在跑的 Worker 照常会把汇报发给你。做过的细节用 ${SEARCH_COMMANDS} 搜；${transcript}。
不用回复“已接上”：读完直接处理这段说明后面的那条消息。`,
    `## 交接\n\n${options.handover.trim() === "" ? "（上一个会话没有写交接）" : options.handover}`,
    `## 最近的原话\n\n${options.recent === "" ? "（没有）" : options.recent}`,
  ];
  if (options.reports.length > 0) parts.push(`## 交接之后到的 Worker 汇报（交接里没有，只列目录）\n\n${options.reports.join("\n")}`);
  return parts.join("\n\n");
}

/** 交接写出来是空的：handovers.failure_reason（本会话写交接时 H 也标这个）。 */
export const HANDOVER_EMPTY_REASON = "handover_empty";

/** 用户点的开新会话没写成时对话里的提示（自动换的不提示）。 */
export const HANDOVER_NOT_WRITTEN_TEXT = "交接没写成，没换会话";

/**
 * handovers.failure_reason 的开头（后面可能跟“: 详情”）。
 * 不算失败次数：restart（守护进程重启时还在复制、写）、shutdown（关机时跑腿的取消了）、user_message（本会话写交接时用户发了消息，停掉了）、
 * stale（ready 放太久）、post_cut（切点之后聊得太多，交接太旧）。其余算一次（handover_empty、error、timeout、failed、stopped）。
 */
export const HANDOVER_REASONS = {
  empty: HANDOVER_EMPTY_REASON,
  error: "error",
  timeout: "timeout",
  failed: "failed",
  stopped: "stopped",
  restart: "restart",
  shutdown: "shutdown",
  userMessage: "user_message",
  stale: "stale",
  postCut: "post_cut",
} as const;
const UNCOUNTED: ReadonlySet<string> = new Set([HANDOVER_REASONS.restart, HANDOVER_REASONS.shutdown, HANDOVER_REASONS.userMessage, HANDOVER_REASONS.stale, HANDOVER_REASONS.postCut]);
/** 记 abandoned（作废）而不是 failed 的。 */
const ABANDONED: ReadonlySet<string> = new Set([HANDOVER_REASONS.stale, HANDOVER_REASONS.postCut]);
const reasonKind = (reason: string | null) => (reason ?? "").split(":")[0]!;
const withDetail = (kind: string, detail: string) => (detail === "" ? kind : `${kind}: ${detail}`);

interface HandoverDbRow {
  id: HandoverId;
  conversation_id: ConversationId;
  from_session_id: SessionId;
  to_session_id: SessionId | null;
  to_vendor: string | null;
  to_model: string | null;
  to_effort: string | null;
  auto: number;
  method: string | null;
  status: HandoverStatus;
  cut_message_id: MessageId | null;
  fork_ref: string | null;
  text: string | null;
  preamble: string | null;
  failure_reason: string | null;
  created_at: number;
  ready_at: number | null;
  updated_at: number;
}

/** H、R 的 meta（SystemMessageMeta 里那两种，加上只有这里用的几个字段，见文件开头）。 */
type HandoverMeta = {
  event: "handover.requested" | "session.renewed";
  sessionId: SessionId;
  handoverId?: HandoverId;
  fromSessionId?: SessionId;
  auto?: boolean;
  requestedAt?: number;
  startedAt?: number;
  turnStartId?: number;
  writing?: boolean;
  abandoned?: boolean;
  interruptedBy?: "user";
  seen?: boolean;
};

/** 和 0013 的部分唯一索引 handovers_active 同一个条件（同 ACTIVE_HANDOVER_STATUSES），查询才用得上它。 */
const ACTIVE = "status IN ('queued', 'forking', 'writing', 'ready')";
const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);
const IS_R = "sender = 'system' AND kind = 'text' AND json_extract(meta, '$.event') = 'session.renewed'";
/** agent 的消息是写交接那一轮的（meta.handover，messages.ts）；meta 不是合法 JSON 的当不是。 */
const NOT_HANDOVER_TURN = "COALESCE(json_extract(CASE WHEN json_valid(m.meta) THEN m.meta END, '$.handover'), 0) != 1";
/** 原话一页取几条（倒着走索引，够数就停）。 */
const RECENT_PAGE = 100;

export type LedgerHandover = ReturnType<typeof createLedgerHandover>;

export function createLedgerHandover(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, persona: LedgerPersona, options: HandoverOptions = {}) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, updateLive, liveOf } = sessions;
  const { getMessage, insertSystemMessage, transition } = messages;
  const { pmRow, requirePm, privateConversation } = persona;
  const findTranscript = options.findTranscript ?? (() => null);
  const contextTokens = options.autoRenew?.contextTokens ?? AUTO_RENEW_CONTEXT_TOKENS;
  const idleMs = options.autoRenew?.idleMs ?? AUTO_RENEW_IDLE_MS;
  const timeoutMs = options.autoRenew?.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const onClaimable = options.onHandoverClaimable ?? (() => {});

  /**
   * 要看的对话：用量到门槛的、有交接在跑的。只是缓存，真相在库里：启动时一条查询重建。
   * 进：turn.ended 时到门槛、手动开新会话；出：换代了、这一代试满了、会话结束了。
   */
  const queue = new Set<ConversationId>();
  for (const { id } of db.all<{ id: number }>(
    `SELECT conversation_id AS id FROM agent_sessions
       WHERE role = 'pm' AND conversation_id IS NOT NULL AND status NOT IN ('ended', 'broken')
         AND CASE WHEN json_valid(token_usage) THEN json_extract(token_usage, '$.context') END >= ?
     UNION SELECT conversation_id FROM handovers WHERE ${ACTIVE}`,
    contextTokens,
  ))
    queue.add(id);

  const metaOf = (row: Pick<MessageDbRow, "meta">): HandoverMeta => JSON.parse(row.meta!) as HandoverMeta;
  const setMeta = (id: MessageId, meta: HandoverMeta) => db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), id);
  const transcriptOf = (session: AgentSessionRow) => findTranscript({ vendor: session.vendor, vendorSessionId: session.vendorSessionId, cwd: session.cwd });
  const maxMessageId = () => db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

  const activeOf = (conversationId: ConversationId): HandoverDbRow | undefined =>
    db.get<HandoverDbRow>(`SELECT * FROM handovers WHERE conversation_id = ? AND ${ACTIVE}`, conversationId);
  const rowOf = (id: HandoverId): HandoverDbRow | undefined => db.get<HandoverDbRow>("SELECT * FROM handovers WHERE id = ?", id);

  /** 发给这个会话、还在路上的消息（已送达、处理中）。 */
  const inFlightTo = (session: AgentSessionRow) =>
    db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND session_id = ? AND status IN ('delivered', 'processing') LIMIT 1", session.conversationId, session.id) !==
    undefined;

  /** 这一代自动试的：算次数的失败几次；退避到什么时候（最近一次算次数的失败或作废之后，按次数翻倍；没有就是 0）。 */
  const attemptsOf = (fromSessionId: SessionId): { counted: number; until: number } => {
    const rows = db.all<Pick<HandoverDbRow, "failure_reason" | "updated_at">>(
      "SELECT failure_reason, updated_at FROM handovers WHERE from_session_id = ? AND auto = 1 AND status IN ('failed', 'abandoned')",
      fromSessionId,
    );
    let counted = 0;
    let last = 0;
    for (const row of rows) {
      const kind = reasonKind(row.failure_reason);
      if (!UNCOUNTED.has(kind)) counted++;
      else if (kind !== HANDOVER_REASONS.stale) continue;
      last = Math.max(last, row.updated_at);
    }
    return { counted, until: last === 0 ? 0 : last + AUTO_RENEW_RETRY_BACKOFF_MS * 2 ** (Math.max(counted, 1) - 1) };
  };

  /** 登记一行 queued（调之前这个对话没有不在终态的行），提交后叫醒跑腿的。 */
  const insertRow = (
    p: Pending,
    session: AgentSessionRow,
    auto: boolean,
    target?: { to_vendor: string | null; to_model: string | null; to_effort: string | null },
  ): HandoverDbRow => {
    const t = now();
    const row = db.get<HandoverDbRow>(
      `INSERT INTO handovers (conversation_id, from_session_id, auto, status, to_vendor, to_model, to_effort, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *`,
      session.conversationId,
      session.id,
      auto ? 1 : 0,
      target?.to_vendor ?? null,
      target?.to_model ?? null,
      target?.to_effort ?? null,
      t,
      t,
    )!;
    queue.add(row.conversation_id);
    p.after.push(onClaimable);
    return row;
  };

  /** 这一代还能自动换：对话够长、会话还在用、试的次数没满。 */
  const autoAllowed = (session: AgentSessionRow) =>
    session.role === "pm" && session.usage.context >= contextTokens && session.status !== "ended" && session.status !== "broken" && attemptsOf(session.id).counted < AUTO_RENEW_MAX_ATTEMPTS;

  /** 是这个对话现在的这一代、还在用。 */
  const stillCurrent = (session: AgentSessionRow | null): session is AgentSessionRow =>
    session !== null && session.status !== "ended" && session.status !== "broken" && currentSession(session.conversationId!)?.id === session.id;

  /**
   * 这一次没成（failed）或作废（abandoned）。不算次数的、自动的没试满的：马上登记下一行 queued（退避由 claimHandover 看）；
   * 自动的试满了：记日志、移出队列；手动的：对话里提示一句，不自动重试。
   */
  const failRow = (p: Pending, row: HandoverDbRow, reason: string) => {
    const kind = reasonKind(reason);
    db.run(
      "UPDATE handovers SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
      ABANDONED.has(kind) ? "abandoned" : "failed",
      reason,
      now(),
      row.id,
    );
    const session = getAgentSession(db, row.from_session_id);
    if (UNCOUNTED.has(kind)) {
      if (stillCurrent(session)) insertRow(p, session, row.auto === 1, row);
      return;
    }
    if (row.auto === 1) {
      const { counted } = attemptsOf(row.from_session_id);
      if (counted >= AUTO_RENEW_MAX_ATTEMPTS) {
        log(`[auto-renew] 项目经理 ${row.from_session_id} 号会话自动换新会话试了 ${counted} 次都没写成交接，这一代不再自动换（资料页的“开新会话”照常能用）：${reason}`);
        queue.delete(row.conversation_id);
        return;
      }
      if (stillCurrent(session)) insertRow(p, session, true);
      return;
    }
    const detail = kind === HANDOVER_REASONS.error || kind === HANDOVER_REASONS.failed ? reason.slice(kind.length + 1).trim() : "";
    // 认得出的失败（繁忙、额度、断网……）才补一句人话；认不出的不写“出错了”凑数，原文照样存进 meta
    const failure = detail === "" ? undefined : describeFailure(detail);
    const noticeText =
      row.to_vendor !== null
        ? `换到 ${vendorLabel(row.to_vendor)} 没成：${failure === undefined || failure.kind === "unknown" ? HANDOVER_NOT_WRITTEN_TEXT : failure.text}，还在用 ${vendorLabel(session?.vendor ?? "")}`
        : failure === undefined || failure.kind === "unknown"
          ? HANDOVER_NOT_WRITTEN_TEXT
          : `${HANDOVER_NOT_WRITTEN_TEXT}：${failure.text}`;
    insertSystemMessage(
      p,
      row.conversation_id,
      { event: "handover.failed", handoverId: row.id, attempt: 1, ...(detail === "" ? {} : { rawReason: detail }) },
      noticeText,
    );
    if (row.to_vendor !== null && session?.pmId != null) {
      p.changes.push({ type: "pm.updated", data: { pm: toPm(pmRow(session.pmId)!) } });
    }
    // 不马上接着自动试：对话够长的话，下一轮结束时照常进队列
    queue.delete(row.conversation_id);
  };

  /** 原话：这个对话里（upTo 含）用户（已回复的）和项目经理（不含写交接那几轮）的文字，从新到旧，一页一页倒着走索引，调用方够数就不再取。 */
  function* recentRows(conversationId: ConversationId, upTo = Number.MAX_SAFE_INTEGER - 1): Generator<RecentMessage> {
    let before = upTo + 1;
    for (;;) {
      const rows = db.all<MessageDbRow & { generation: number | null }>(
        `SELECT m.*, s.generation AS generation FROM messages m LEFT JOIN agent_sessions s ON s.id = m.session_id
         WHERE m.conversation_id = ? AND m.id < ? AND m.kind = 'text'
           AND ((m.sender = 'agent' AND ${NOT_HANDOVER_TURN}) OR (m.sender = 'user' AND m.status = 'replied'))
         ORDER BY m.id DESC LIMIT ?`,
        conversationId,
        before,
        RECENT_PAGE,
      );
      for (const row of rows) yield { id: row.id, sender: row.sender === "user" ? "user" : "agent", text: agentTextOf(toMessage(row)), generation: row.generation ?? 1 };
      if (rows.length < RECENT_PAGE) return;
      before = rows.at(-1)!.id;
    }
  }

  /** 切点之后交给了项目经理（不是还压着）的 Worker 汇报：每条一行目录。 */
  const reportsAfter = (conversationId: ConversationId, cut: MessageId): string[] =>
    db
      .all<MessageDbRow>(
        "SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND kind = 'worker' AND status IS NOT NULL AND status != 'queued' ORDER BY id",
        conversationId,
        cut,
      )
      .flatMap((row) => {
        const meta = workerEventOf(toMessage(row));
        if (meta === null) return [];
        const line = workerLineText({ ...meta, summary: null }).replace(/^Worker/, "");
        const where = `${HUB_COMMAND} worker show ${meta.workerId}${meta.event === "report" ? " --report" : ""}`;
        return [`- #${meta.workerId}${line}，全文 \`${where}\``];
      });

  /**
   * 换代（ready 的这一行，旧会话 old 正空闲或刚结束一轮）。切点之后聊得太多就作废重来，返回 false。
   * turnStartId 只给本会话写交接：网页把分隔线挪到写交接那一轮开始的地方。
   */
  const switchIn = (p: Pending, row: HandoverDbRow, old: AgentSessionRow, handover: string, turnStartId?: MessageId): boolean => {
    const conversationId = row.conversation_id;
    const cut = row.cut_message_id ?? 0;
    const { picked, postCutChars } = pickRecent(recentRows(conversationId), cut, HANDOVER_RECENT_CHARS);
    if (postCutChars > HANDOVER_POST_CUT_MAX_CHARS) {
      failRow(p, row, withDetail(HANDOVER_REASONS.postCut, `${postCutChars} 字`));
      return false;
    }
    const auto = row.auto === 1;
    const vendor = (row.to_vendor ?? old.vendor) as AgentVendor;
    const model = row.to_vendor !== null ? row.to_model : old.model;
    const effort = row.to_vendor !== null ? row.to_effort : old.effort;
    const next = insertSession(p, {
      conversationId,
      pmId: old.pmId,
      cwd: old.cwd,
      addDirs: old.addDirs,
      generation: old.generation + 1,
      vendor,
      model,
      effort,
    });
    // 旧会话刚报额度用完的话，同厂商的新会话也要知道，不然第一条立刻撞上额度失败；跨厂商不抄
    if (vendor === old.vendor && old.rateLimit !== null) {
      db.run("UPDATE agent_sessions SET rate_limit = ? WHERE id = ?", JSON.stringify(old.rateLimit), next.id);
      updateLive(p, next.id, () => {});
    }
    if (row.to_vendor !== null && old.pmId !== null) {
      db.run("UPDATE pms SET vendor = ?, default_model = ?, effort = ? WHERE id = ?", vendor, model, effort, old.pmId);
      p.changes.push({ type: "pm.updated", data: { pm: toPm(pmRow(old.pmId)!) } });
    }
    enqueue(p, { type: "session.end", params: { sessionId: old.id, generation: old.generation } });
    insertSystemMessage(
      p,
      conversationId,
      { event: "session.renewed", sessionId: next.id, fromSessionId: old.id, handoverId: row.id, ...(turnStartId !== undefined ? { turnStartId } : {}), ...(auto ? { auto } : {}) },
      handover,
    );
    // 压着的、还在排队的消息（用户的、Worker 的汇报）改发给新会话：第一条写进去时驱动层在前面拼开场说明
    const held = db.all<MessageDbRow>("SELECT * FROM messages WHERE conversation_id = ? AND session_id = ? AND status = 'queued' ORDER BY id", conversationId, old.id);
    for (const message of held) {
      db.run("UPDATE messages SET session_id = ?, updated_at = ? WHERE id = ?", next.id, now(), message.id);
      enqueue(p, { type: "session.send", params: { sessionId: next.id, messageId: message.id, source: message.sender === "user" || message.sender === "pm" ? "user" : "system" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(message.id)! } });
    }
    const preamble = sessionPreambleText({
      auto,
      handover,
      recent: recentText(picked),
      reports: reportsAfter(conversationId, cut),
      transcriptPath: transcriptOf(old),
      fromVendor: old.vendor,
      toVendor: next.vendor,
    });
    // 预先起好新会话的进程（只起进程，不预读）：第一条回复不用等进程启动
    enqueue(p, { type: "session.start", params: { sessionId: next.id, generation: next.generation } });
    const t = now();
    db.run(
      "UPDATE handovers SET status = 'switched', to_session_id = ?, text = ?, preamble = ?, switched_at = ?, updated_at = ? WHERE id = ?",
      next.id,
      handover,
      preamble,
      t,
      t,
      row.id,
    );
    queue.delete(conversationId);
    return true;
  };

  /** ready 的这一行：旧会话空闲、没后台任务、没有在路上的消息就换代。 */
  const trySwitch = (p: Pending, row: HandoverDbRow): boolean => {
    const old = getAgentSession(db, row.from_session_id);
    if (!stillCurrent(old)) return false;
    const live = liveOf(old.id);
    if (live.activity !== "idle" || (live.backgroundTasks ?? 0) > 0 || inFlightTo(old)) return false;
    return switchIn(p, row, old, row.text ?? "");
  };

  // ---- 跑腿的用的（shared/handover.ts 的 LedgerHandoverWork）----

  const claimHandover = (): HandoverJob | null => {
    if (queue.size === 0) return null;
    return write(() => {
      const t = now();
      for (const conversationId of queue) {
        const row = activeOf(conversationId);
        if (row === undefined || row.status !== "queued" || row.method === "in_session") continue;
        const session = getAgentSession(db, row.from_session_id);
        if (!stillCurrent(session) || liveOf(session.id).activity !== "idle") continue;
        if (row.auto === 1 && t < attemptsOf(session.id).until) continue;
        if (inFlightTo(session)) continue;
        db.run("UPDATE handovers SET status = 'forking', cut_message_id = ?, started_at = ?, updated_at = ? WHERE id = ?", maxMessageId(), t, t, row.id);
        const auto = row.auto === 1;
        return {
          handoverId: row.id,
          conversationId,
          session,
          auto,
          prompt: handoverRequestText({ auto, transcriptPath: transcriptOf(session), forked: true, fromVendor: session.vendor, toVendor: row.to_vendor }),
        };
      }
      return null;
    });
  };

  const handoverForked = (handoverId: HandoverId, fork: { kind: ForkerKind; ref: ForkRef }): boolean =>
    write(() => {
      const row = rowOf(handoverId);
      if (row === undefined) return false;
      const writing = row.status === "forking";
      db.run(
        "UPDATE handovers SET fork_ref = ?, method = ?, status = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(fork.ref),
        fork.kind,
        writing ? "writing" : row.status,
        now(),
        handoverId,
      );
      return writing;
    });

  const handoverWritten = (handoverId: HandoverId, result: { text: string; usage: TokenUsage }): void =>
    write((p) => {
      const row = rowOf(handoverId);
      if (row === undefined || row.status !== "writing" || row.method === "in_session") return;
      const t = now();
      db.run("UPDATE handovers SET usage = ?, updated_at = ? WHERE id = ?", JSON.stringify(result.usage), t, handoverId);
      if (result.text.trim() === "") {
        failRow(p, row, HANDOVER_REASONS.empty);
        return;
      }
      db.run("UPDATE handovers SET status = 'ready', text = ?, ready_at = ?, updated_at = ? WHERE id = ?", result.text, t, t, handoverId);
      trySwitch(p, { ...row, status: "ready", text: result.text, ready_at: t });
    });

  const handoverFailed = (handoverId: HandoverId, failure: HandoverFailure): void =>
    write((p) => {
      const row = rowOf(handoverId);
      if (row === undefined || (row.status !== "forking" && row.status !== "writing") || row.method === "in_session") return;
      if (failure.kind === "unsupported") {
        // 这家复制不了：退回本会话写交接（runAutoRenew 等旧会话空闲够久再发交接请求），不算失败
        db.run("UPDATE handovers SET status = 'queued', method = 'in_session', failure_reason = ?, updated_at = ? WHERE id = ?", failure.detail, now(), handoverId);
        return;
      }
      failRow(p, row, withDetail(failure.kind, failure.detail));
    });

  const handoverCleaned = (handoverId: HandoverId): void => {
    db.run("UPDATE handovers SET cleaned_at = ? WHERE id = ? AND cleaned_at IS NULL", now(), handoverId);
  };

  const uncleanedHandovers = (): HandoverCleanJob[] =>
    db
      .all<{ id: number; fork_ref: string; vendor: string }>(
        `SELECT h.id, h.fork_ref, s.vendor FROM handovers h JOIN agent_sessions s ON s.id = h.from_session_id
         WHERE h.cleaned_at IS NULL AND h.fork_ref IS NOT NULL AND h.status NOT IN ('forking', 'writing') ORDER BY h.id`,
      )
      .map((row) => ({ handoverId: row.id, vendor: row.vendor, ref: JSON.parse(row.fork_ref) as ForkRef }));

  /** 守护进程启动时（ledger.recoverAfterRestart）：上次还在复制、写的记失败（restart，不算次数）并重新排队；跑腿的随后补清复制那份。 */
  const recoverAfterRestart = (): void => {
    write((p) => {
      const rows = db.all<HandoverDbRow>("SELECT * FROM handovers WHERE status IN ('forking', 'writing') AND (method IS NULL OR method != 'in_session')");
      for (const row of rows) failRow(p, row, HANDOVER_REASONS.restart);
    });
  };

  // ---- 开新会话（资料页）----

  const renewSession = (pmId: PmId): { handoverId: HandoverId } =>
    write((p) => {
      requirePm(pmId);
      const conversation = privateConversation(pmId)!;
      const active = activeOf(conversation.id);
      if (active !== undefined) {
        // 自动的在跑：并进去，改成手动的（没成要提示）
        if (active.auto === 1) db.run("UPDATE handovers SET auto = 0, updated_at = ? WHERE id = ?", now(), active.id);
        return { handoverId: active.id };
      }
      return { handoverId: insertRow(p, currentSession(conversation.id)!, false).id };
    });

  /** 资料页换厂商（或在换厂商交接期间改新厂商下的模型、思考程度）：没有活跃交接就登记一行手动交接，已有就并进去；已 ready 则尝试当场换代。 */
  const switchVendorIn = (p: Pending, conversationId: ConversationId, agent: AgentSetting): void => {
    const active = activeOf(conversationId);
    if (active === undefined) {
      const session = currentSession(conversationId);
      if (session !== null) {
        insertRow(p, session, false, { to_vendor: agent.vendor, to_model: agent.model, to_effort: agent.effort });
      }
      return;
    }
    const updated = db.get<HandoverDbRow>(
      "UPDATE handovers SET to_vendor = ?, to_model = ?, to_effort = ?, auto = 0, updated_at = ? WHERE id = ? RETURNING *",
      agent.vendor,
      agent.model,
      agent.effort,
      now(),
      active.id,
    )!;
    if (updated.status === "ready") trySwitch(p, updated);
  };

  /** 换厂商交接期间改回旧厂商或撤销：把活跃交接行的 to_vendor 三列清回 NULL（照常作为普通换会话走完）。 */
  const clearVendorSwitchIn = (conversationId: ConversationId): void => {
    const active = activeOf(conversationId);
    if (active !== undefined && active.to_vendor !== null) {
      db.run("UPDATE handovers SET to_vendor = NULL, to_model = NULL, to_effort = NULL, updated_at = ? WHERE id = ?", now(), active.id);
    }
  };

  // ---- 兜底：本会话写交接（H）----

  /** 这一代会话的交接请求（每一代最多一条，没成的同一条重新排队）。 */
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

  /** 发（或把上次没成的同一条重新排队）这一代的交接请求，这一行改成 writing。 */
  const requestIn = (p: Pending, session: AgentSessionRow, row: HandoverDbRow) => {
    const t = now();
    const auto = row.auto === 1;
    const text = handoverRequestText({ auto, transcriptPath: transcriptOf(session), forked: false, fromVendor: session.vendor, toVendor: row.to_vendor });
    const meta: HandoverMeta = { event: "handover.requested", sessionId: session.id, handoverId: row.id, ...(auto ? { auto: true } : {}), requestedAt: t };
    const existing = requestOf(session);
    if (existing === undefined) {
      const created = db.get<MessageDbRow>(
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
      p.changes.push({ type: "message.created", data: { message: toMessage(created) } });
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: created.id, source: "system" } });
    } else if (!IN_FLIGHT.has(existing.status!)) {
      // 上一次被停止、失败了：同一条重新排队。上一次被标了停止、驱动层那一轮还没真停下来：那一轮剩下的文字照样不显示
      const writing = metaOf(existing).writing === true;
      db.run(
        "UPDATE messages SET status = 'queued', failure_reason = NULL, text = ?, meta = ?, updated_at = ? WHERE id = ?",
        text,
        JSON.stringify({ ...meta, ...(writing ? { writing } : {}) }),
        t,
        existing.id,
      );
      enqueue(p, { type: "session.send", params: { sessionId: session.id, messageId: existing.id, source: "system" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(existing.id)! } });
    }
    db.run("UPDATE handovers SET status = 'writing', started_at = ?, updated_at = ? WHERE id = ?", t, t, row.id);
  };

  /** 交接全文：交接那一轮开始时库里最大的编号（turnStartId）之后，旧会话说的文字。 */
  const handoverTextOf = (old: AgentSessionRow, request: MessageDbRow): string =>
    db
      .all<{ text: string }>(
        "SELECT text FROM messages WHERE conversation_id = ? AND session_id = ? AND sender = 'agent' AND kind = 'text' AND id > ? ORDER BY id",
        old.conversationId,
        old.id,
        metaOf(request).turnStartId ?? request.id,
      )
      .map((r) => r.text)
      .join("\n\n");

  /** 正在本会话写交接的那一行（in_session、writing）。 */
  const inSessionOf = (conversationId: ConversationId): HandoverDbRow | undefined => {
    if (!queue.has(conversationId)) return undefined;
    const row = activeOf(conversationId);
    return row?.method === "in_session" && row.status === "writing" ? row : undefined;
  };

  /** 本会话写交接的 H 没成（失败、被停止）：这一行记失败。用户发消息打断的不算次数。 */
  const settleInSession = (p: Pending, conversationId: ConversationId) => {
    const row = inSessionOf(conversationId);
    if (row === undefined) return;
    const session = getAgentSession(db, row.from_session_id);
    const request = session === null ? undefined : requestOf(session);
    if (request === undefined || (request.status !== "failed" && request.status !== "stopped")) return;
    const meta = metaOf(request);
    const reason =
      request.status === "failed"
        ? request.failure_reason === HANDOVER_EMPTY_REASON
          ? HANDOVER_REASONS.empty
          : withDetail(HANDOVER_REASONS.failed, request.failure_reason ?? "")
        : meta.interruptedBy === "user"
          ? HANDOVER_REASONS.userMessage
          : meta.abandoned === true
            ? HANDOVER_REASONS.timeout
            : HANDOVER_REASONS.stopped;
    failRow(p, row, reason);
  };

  /** 写交接超时：还没写进去的直接标已停止；写进去了的请驱动层停掉那一轮（turn.ended 再标已停止），停不下来再过一个超时直接标。 */
  const abandonIn = (p: Pending, session: AgentSessionRow, request: MessageDbRow, meta: HandoverMeta) => {
    if (request.status === "queued" || meta.abandoned === true) {
      setMeta(request.id, { ...meta, abandoned: true });
      transition(p, request.id, "stopped");
      settleInSession(p, session.conversationId!);
      return;
    }
    setMeta(request.id, { ...meta, abandoned: true, startedAt: now() });
    p.stops.push({ conversationId: session.conversationId!, sessionId: session.id });
  };

  /**
   * 用户在这个对话里发了一条消息（messages.ts 的 postUserMessage，同一个事务）：正在本会话写交接的，还没写进去就直接停掉，
   * 写进去了就请驱动层停掉那一轮（不算失败次数）。用户的消息在那之前压着，停下来后照常发给旧会话。
   */
  const userPostedIn = (p: Pending, conversationId: ConversationId) => {
    const row = inSessionOf(conversationId);
    if (row === undefined) return;
    const session = getAgentSession(db, row.from_session_id)!;
    const request = requestOf(session);
    if (request === undefined || !IN_FLIGHT.has(request.status!)) return;
    const meta = metaOf(request);
    if (meta.interruptedBy === "user") return;
    setMeta(request.id, { ...meta, interruptedBy: "user" });
    if (request.status === "queued") {
      transition(p, request.id, "stopped");
      settleInSession(p, conversationId);
      return;
    }
    p.stops.push({ conversationId, sessionId: session.id });
  };

  /** agent 不再写这条交接请求的那一轮了（见文件开头的 writing）。 */
  const endWriting = (request: MessageDbRow) => {
    const meta = metaOf(request);
    if (meta.writing === true) setMeta(request.id, { ...meta, writing: false });
  };

  /** 本会话写交接那一轮正常结束（H 已回复）：写了字就换代，一个字没写当没写成。 */
  const inSessionWritten = (p: Pending, session: AgentSessionRow, request: MessageDbRow) => {
    const row = inSessionOf(session.conversationId!);
    if (row === undefined || row.from_session_id !== session.id || !stillCurrent(session)) return;
    const handover = handoverTextOf(session, request);
    if (handover.trim() === "") {
      db.run("UPDATE messages SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", HANDOVER_EMPTY_REASON, now(), request.id);
      p.changes.push({ type: "message.updated", data: { message: getMessage(request.id)! } });
      failRow(p, row, HANDOVER_REASONS.empty);
      return;
    }
    const t = now();
    db.run("UPDATE handovers SET status = 'ready', text = ?, ready_at = ?, updated_at = ? WHERE id = ?", handover, t, t, row.id);
    switchIn(p, { ...row, status: "ready", text: handover }, session, handover, metaOf(request).turnStartId);
  };

  // ---- 驱动层事件、消息 ----

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "pm" || session.conversationId === null) return;
    const conversationId = session.conversationId;
    if (event.type === "message.processing") {
      // 带着开场说明的那一行开始处理：agent 读到了，之后不再拼
      if (event.preamble === true && session.generation > 1) {
        const renewed = renewedOf(session);
        if (renewed !== undefined && metaOf(renewed).seen !== true) setMeta(renewed.id, { ...metaOf(renewed), seen: true });
      }
      if (inSessionOf(conversationId) === undefined) return;
      // H 开始处理：记下那一刻库里最大的编号（之后的文字才是交接，也是切点）和时间（算超时），从这起 agent 在写交接（writing）；
      // 之前请驱动层停过却没东西可停的（守护进程停了很久再起，超时检查跑在重发之前）不算数，超时了重新请它停
      const request = requestOf(session);
      if (request === undefined) return;
      if (event.messageIds.includes(request.id)) {
        const max = maxMessageId();
        const { abandoned: _, ...meta } = metaOf(request);
        setMeta(request.id, { ...meta, turnStartId: max, startedAt: now(), writing: true });
        if (meta.handoverId !== undefined) db.run("UPDATE handovers SET cut_message_id = ?, updated_at = ? WHERE id = ?", max, now(), meta.handoverId);
      } else endWriting(request);
      return;
    }
    if (event.type === "background.changed") {
      // 后台任务没了：写好的交接这时换
      if (event.count === 0 && queue.has(conversationId)) {
        const row = activeOf(conversationId);
        if (row?.status === "ready") trySwitch(p, row);
      }
      return;
    }
    if (event.type !== "turn.ended" && event.type !== "session.exited" && event.type !== "driver.error") return;
    if (!queue.has(conversationId) && (event.type !== "turn.ended" || session.usage.context < contextTokens)) return;
    // 本会话写交接：那一轮结束、进程退出时写交接到此为止；H 没成就记失败；正常写完就换代
    const request = inSessionOf(conversationId) === undefined ? undefined : requestOf(session);
    if (request !== undefined && event.type !== "driver.error") endWriting(request);
    settleInSession(p, conversationId);
    if (event.type === "driver.error") return;
    if (request !== undefined && event.type === "turn.ended" && event.ok && !event.interrupted && event.messageIds.includes(request.id)) {
      const fresh = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", request.id)!;
      if (fresh.status === "replied") inSessionWritten(p, session, fresh);
      return;
    }
    if (!stillCurrent(session)) return;
    const row = activeOf(conversationId);
    // 交接写好了：旧会话这一轮结束就换（不管成没成、有没有被打断）
    if (row?.status === "ready" && row.from_session_id === session.id) {
      trySwitch(p, row);
      return;
    }
    // 到门槛了：进队列，登记一行等旧会话两轮之间的空当
    if (row === undefined && event.type === "turn.ended") {
      if (autoAllowed(session)) insertRow(p, session, true);
      return;
    }
    if (row?.status === "queued" && row.method !== "in_session") p.after.push(onClaimable);
  };

  /** session.send 次数用完（ledger.onActionFailed，消息已经标了 failed）：本会话写交接的 H 发不出去就记失败。 */
  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type !== "session.send") return;
    const conversationId = getMessage(action.params.messageId)?.conversationId;
    if (conversationId !== undefined) settleInSession(p, conversationId);
  };

  /** 驱动层往新会话写一行之前问（DriverOptions.sessionPreamble）：还没读到开场说明就给全文（换代时定稿的），否则 null。 */
  const sessionPreamble = (sessionId: SessionId): string | null => {
    const session = getAgentSession(db, sessionId);
    if (session === null || session.role !== "pm" || session.conversationId === null || session.generation <= 1) return null;
    const row = renewedOf(session);
    // 升级前手动换代留下的那一行是发给 agent 的（有状态，早就读过）；现在这一行状态恒为 null
    if (row === undefined || row.status !== null) return null;
    const meta = metaOf(row);
    if (meta.seen === true) return null;
    if (meta.handoverId !== undefined) return db.get<{ preamble: string | null }>("SELECT preamble FROM handovers WHERE id = ?", meta.handoverId)?.preamble ?? null;
    // #113 换代、新会话还没读到就升级了：按现在的办法现拼一份
    const old = meta.fromSessionId === undefined ? null : getAgentSession(db, meta.fromSessionId);
    const upTo = meta.turnStartId ?? row.id;
    const { picked } = pickRecent(recentRows(session.conversationId, upTo), upTo, HANDOVER_RECENT_CHARS);
    return sessionPreambleText({
      auto: meta.auto === true,
      handover: row.text,
      recent: recentText(picked),
      reports: [],
      transcriptPath: old === null ? null : transcriptOf(old),
      fromVendor: old?.vendor,
      toVendor: session.vendor,
    });
  };

  /**
   * 压着不发：H 自己等它的会话空闲（单独一轮）；交接写好了（ready）、旧会话没后台任务时，发给旧会话的消息压着等换代；
   * 本会话写交接还没结果时，发给旧会话的别的消息也压着。
   */
  const waitsForHandover = (messageId: MessageId): boolean => {
    const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (message === undefined) return false;
    if (systemEventOf(toMessage(message))?.event === "handover.requested") return message.session_id !== null && liveOf(message.session_id).activity !== "idle";
    if (message.status !== "queued" || !queue.has(message.conversation_id)) return false;
    const row = activeOf(message.conversation_id);
    if (row === undefined || message.session_id !== row.from_session_id) return false;
    if (row.status === "ready") return (liveOf(row.from_session_id).backgroundTasks ?? 0) === 0;
    if (row.method !== "in_session" || row.status !== "writing") return false;
    const session = getAgentSession(db, row.from_session_id);
    const request = session === null ? undefined : requestOf(session);
    return request !== undefined && IN_FLIGHT.has(request.status!);
  };

  /**
   * 守护进程每 AUTO_RENEW_TICK_MS 调一次：只看队列里的对话，队列空什么都不查。没有行的（重启后重建的）够格就登记；
   * ready 的放太久作废、旧会话空闲就换代；本会话写交接的空闲够久就发 H、超时放弃。先只读，有事要做才开事务。
   */
  const runAutoRenew = (): void => {
    if (queue.size === 0) return;
    const t = now();
    for (const conversationId of [...queue]) {
      const session = currentSession(conversationId);
      const row = activeOf(conversationId);
      if (session === null || session.role !== "pm" || session.status === "ended" || session.status === "broken") {
        if (row === undefined) queue.delete(conversationId);
        continue;
      }
      if (row === undefined) {
        if (autoAllowed(session)) write((p) => insertRow(p, session, true));
        else queue.delete(conversationId);
        continue;
      }
      const live = liveOf(session.id);
      if (row.status === "ready") {
        if (t - (row.ready_at ?? row.updated_at) >= HANDOVER_READY_MAX_MS) write((p) => failRow(p, row, HANDOVER_REASONS.stale));
        else if (live.activity === "idle" && (live.backgroundTasks ?? 0) === 0) write((p) => trySwitch(p, row));
        continue;
      }
      // 复制、写交给跑腿的（它自己按 AUTO_RENEW_TICK_MS 领活、计时），这里不管
      if (row.method !== "in_session") continue;
      if (row.status === "queued") {
        // 本会话写交接：手动的空闲就发；自动的要空闲够久、对话里没有在路上的消息（来了新消息就等下一次空闲）
        if (live.activity !== "idle" || (live.backgroundTasks ?? 0) > 0) continue;
        if (row.auto === 1) {
          if (t - Math.max(row.updated_at, session.lastEventAt ?? 0) < idleMs) continue;
          if (db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND status IN ('queued', 'delivered', 'processing') LIMIT 1", conversationId) !== undefined) continue;
        }
        write((p) => requestIn(p, session, row));
        continue;
      }
      if (row.status !== "writing") continue;
      const request = requestOf(session);
      if (request === undefined || !IN_FLIGHT.has(request.status!)) continue;
      const meta = metaOf(request);
      // 还排着、会话在忙：等那一轮结束才开始算
      if (request.status === "queued" && live.activity !== "idle") continue;
      const since = meta.startedAt ?? meta.requestedAt ?? request.created_at;
      if (t - since >= timeoutMs) write((p) => abandonIn(p, session, request, meta));
    }
  };

  return {
    renewSession,
    switchVendorIn,
    clearVendorSwitchIn,
    waitsForHandover,
    afterDriverEvent,
    actionFailedIn,
    userPostedIn,
    sessionPreamble,
    runAutoRenew,
    recoverAfterRestart,
    claimHandover,
    handoverForked,
    handoverWritten,
    handoverFailed,
    handoverCleaned,
    uncleanedHandovers,
  };
}
