// Handover runs in the background on a fork of the PM session and swaps sessions between two turns, so the user keeps chatting throughout.
import { agentTextOf } from "../../shared/attachments.ts";
import { waitingAsksSection } from "../../shared/waiting-asks.ts";
import type { WaitingAsk } from "../../shared/waiting-asks.ts";
import { describeFailure } from "../../shared/errors.ts";
import { systemEventOf, systemMessageDedupeKey, workerEventOf } from "../../shared/domain.ts";
import type { AgentSessionRow, ConversationId, Message, MessageId, PmId, SessionId, TokenUsage } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { ForkRef, ForkerKind, HandoverCleanJob, HandoverFailure, HandoverId, HandoverJob, HandoverStatus } from "../../shared/handover.ts";
import {
  AUTO_RENEW_IDLE_MS,
  AUTO_RENEW_MAX_ATTEMPTS,
  AUTO_RENEW_RETRY_BACKOFF_MS,
  HANDOVER_POST_CUT_MAX_CHARS,
  HANDOVER_READY_MAX_MS,
  HANDOVER_RECENT_CHARS,
  HANDOVER_TIMEOUT_MS,
  VENDOR_SWITCH_TRANSCRIPTS_MAX,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { handoverTokenThresholdOf, vendorLabel, type AgentSetting, type AgentVendor } from "../../shared/vendors.ts";
import { workerLineText } from "../../shared/worker.ts";
import { deletePendingSessionSend, hasRunningSessionAction } from "../actions/index.ts";
import { getAgentSession, type Db } from "../store/index.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { clearConsumedHandoverBlobsIn } from "./db-table-retention.ts";
import { pickRecent, recentText, type RecentMessage } from "./handover-recent.ts";
import {
  HANDOVER_EMPTY_REASON,
  HANDOVER_NOT_WRITTEN_TEXT,
  handoverRequestText,
  sessionPreambleText,
} from "./handover-text.ts";
import type { LedgerLoadedSkills } from "./loaded-skills.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toMessage, toPm } from "./rows.ts";
import type { MessageDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";
import {
  buildVendorSwitchPreamble,
  collectGenerationContext,
  describeGenerationTranscripts,
  type GenerationAnchor,
  type PriorSessionTranscriptRef,
} from "./vendor-switch-context.ts";

export { HANDOVER_EMPTY_REASON, HANDOVER_NOT_WRITTEN_TEXT, HANDOVER_STALE_HINT } from "./handover-text.ts";

type FindTranscript = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

export interface HandoverOptions {
  findTranscript?: FindTranscript;
  autoRenew?: { contextTokens?: number; idleMs?: number; timeoutMs?: number };
  log?: (line: string) => void;
  onHandoverClaimable?: () => void;
  liveActiveGraphsSection?: (pmId: PmId) => string | null;
  onRenewedIn?: (p: Pending, conversationId: ConversationId) => void;
  waitingAsks?: (conversationId: ConversationId) => WaitingAsk[];
  isSessionBusy?: (sessionId: SessionId) => boolean;
  hasPendingDriverEvents?: (sessionId: SessionId) => boolean;
  hasPendingTurnCompletions?: (sessionId: SessionId) => boolean;
}

/** These failure reasons do not count against the retry budget. */
const HANDOVER_REASONS = {
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
  skills_section: string | null;
  failure_reason: string | null;
  created_at: number;
  ready_at: number | null;
  updated_at: number;
}

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

/** Same condition as the partial unique index handovers_active, so queries can use it. */
const ACTIVE = "status IN ('queued', 'forking', 'writing', 'ready')";
const IN_FLIGHT = new Set(["queued", "delivered", "processing"]);
const IS_R = "sender = 'system' AND kind = 'text' AND json_extract(meta, '$.event') = 'session.renewed'";
const NOT_HANDOVER_TURN = "COALESCE(json_extract(CASE WHEN json_valid(m.meta) THEN m.meta END, '$.handover'), 0) != 1";
const RECENT_PAGE = 100;
const VENDOR_SWITCH_METHOD = "vendor_switch";
const isVendorSwitchRow = (row: Pick<HandoverDbRow, "method">): boolean =>
  row.method === VENDOR_SWITCH_METHOD || row.method === "direct";

function* recentRowsOf(db: Db, conversationId: ConversationId, upTo = Number.MAX_SAFE_INTEGER - 1): Generator<RecentMessage> {
  let before = upTo + 1;
  for (;;) {
    const rows = db.all<MessageDbRow & { generation: number | null }>(
      `SELECT m.*, s.generation AS generation FROM messages m LEFT JOIN agent_sessions s ON s.id = m.session_id
       WHERE m.conversation_id = ? AND m.id < ? AND m.kind = 'text'
         AND ((m.sender = 'agent' AND ${NOT_HANDOVER_TURN}) OR (m.sender = 'user' AND m.status IN ('replied', 'failed', 'stopped')))
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

function generationAnchorOfDb(db: Db, conversationId: ConversationId): GenerationAnchor {
  const row = db.get<{ text: string; cut_message_id: number | null; to_session_id: number | null }>(
    `SELECT text, cut_message_id, to_session_id
       FROM handovers
      WHERE conversation_id = ?
        AND status = 'switched'
        AND (method IS NULL OR method NOT IN ('direct', 'vendor_switch'))
        AND text IS NOT NULL
        AND trim(text) != ''
      ORDER BY id DESC
      LIMIT 1`,
    conversationId,
  );
  if (row !== undefined) {
    return { summaryText: row.text, cutMessageId: row.cut_message_id ?? 0, startSessionId: row.to_session_id ?? 0 };
  }
  const msg = db.get<{ id: number; text: string; session_id: number | null }>(
    `SELECT m.id, m.text,
            CASE WHEN json_valid(m.meta) THEN CAST(json_extract(m.meta, '$.sessionId') AS INTEGER) END AS session_id
       FROM messages m
      WHERE m.conversation_id = ?
        AND m.sender = 'system' AND m.kind = 'text'
        AND CASE WHEN json_valid(m.meta) THEN json_extract(m.meta, '$.event') = 'session.renewed' ELSE 0 END
        AND trim(m.text) != ''
        AND NOT EXISTS (
              SELECT 1 FROM handovers h
               WHERE h.id = CASE WHEN json_valid(m.meta) THEN CAST(json_extract(m.meta, '$.handoverId') AS INTEGER) END
                 AND h.method IN ('direct', 'vendor_switch')
            )
      ORDER BY m.id DESC
      LIMIT 1`,
    conversationId,
  );
  if (msg !== undefined) {
    return { summaryText: msg.text, cutMessageId: msg.id, startSessionId: msg.session_id ?? 0 };
  }
  return { summaryText: null, cutMessageId: 0, startSessionId: 0 };
}

function* generationMessagesNewestFirstOf(db: Db, conversationId: ConversationId, cutMessageId: MessageId): Generator<Message> {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = db.all<MessageDbRow>(
      `SELECT * FROM messages
        WHERE conversation_id = ? AND id > ? AND id < ? AND kind != 'tool'
        ORDER BY id DESC
        LIMIT ?`,
      conversationId,
      cutMessageId,
      before,
      RECENT_PAGE,
    );
    for (const row of page) yield toMessage(row);
    if (page.length < RECENT_PAGE) return;
    before = page.at(-1)!.id;
  }
}

function priorGenerationSessionsOfDb(
  db: Db,
  conversationId: ConversationId,
  startSessionId: SessionId,
  beforeSessionId: SessionId,
): PriorSessionTranscriptRef[] {
  return db
    .all<{ id: number; vendor: string; vendor_session_id: string; cwd: string }>(
      `SELECT s.id, s.vendor, s.vendor_session_id, s.cwd
         FROM agent_sessions s
        WHERE s.conversation_id = ?
          AND s.id >= ?
          AND s.id < ?
          AND (
            s.has_completed_turn = 1
            OR EXISTS (
              SELECT 1 FROM messages m
               WHERE m.session_id = s.id
                 AND (m.sender = 'agent' OR m.status IN ('replied', 'failed', 'stopped'))
            )
          )
        ORDER BY s.id DESC
        LIMIT ?`,
      conversationId,
      startSessionId,
      beforeSessionId,
      VENDOR_SWITCH_TRANSCRIPTS_MAX,
    )
    .map((r) => ({ id: r.id, vendor: r.vendor, vendorSessionId: r.vendor_session_id, cwd: r.cwd }));
}

function reportsAfterOf(db: Db, conversationId: ConversationId, cut: MessageId): string[] {
  return db
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
}

export function createLedgerHandover(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  loadedSkills: Pick<LedgerLoadedSkills, "carryIn">,
  options: HandoverOptions = {},
) {
  const { db, now, write, enqueue } = ctx;
  const { currentSession, insertSession, updateLive, liveOf } = sessions;
  const { getMessage, insertSystemMessage, transition } = messages;
  const { pmRow, requirePm, isPmArchived, assertPmNotArchived, privateConversation } = persona;
  const findTranscript = options.findTranscript ?? (() => null);
  const thresholdOf = (vendor: string) => options.autoRenew?.contextTokens ?? handoverTokenThresholdOf(vendor);
  const idleMs = options.autoRenew?.idleMs ?? AUTO_RENEW_IDLE_MS;
  const timeoutMs = options.autoRenew?.timeoutMs ?? HANDOVER_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const onClaimable = options.onHandoverClaimable ?? (() => {});
  const isSessionBusy = options.isSessionBusy ?? (() => false);
  const hasPendingDriverEvents = options.hasPendingDriverEvents ?? (() => false);
  const hasPendingTurnCompletions = options.hasPendingTurnCompletions ?? (() => false);

  /** Only a cache; the database is the source of truth and a startup query rebuilds it. */
  const queue = new Set<ConversationId>();
  for (const row of db.all<{ id: number; vendor: string; context: number | null }>(
    `SELECT s.conversation_id AS id, s.vendor,
            CASE WHEN json_valid(s.token_usage) THEN json_extract(s.token_usage, '$.context') END AS context
       FROM agent_sessions s
       LEFT JOIN pm_archives a ON a.pm_id = s.pm_id
       WHERE s.role = 'pm' AND s.conversation_id IS NOT NULL AND s.status NOT IN ('ended', 'broken') AND a.pm_id IS NULL`,
  )) {
    if ((row.context ?? 0) >= thresholdOf(row.vendor)) queue.add(row.id);
  }
  for (const { id } of db.all<{ id: number }>(`SELECT conversation_id AS id FROM handovers WHERE ${ACTIVE}`)) {
    queue.add(id);
  }

  const metaOf = (row: Pick<MessageDbRow, "meta">): HandoverMeta => JSON.parse(row.meta!) as HandoverMeta;
  const setMeta = (id: MessageId, meta: HandoverMeta) => db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), id);
  const transcriptOf = (session: AgentSessionRow) => findTranscript({ vendor: session.vendor, vendorSessionId: session.vendorSessionId, cwd: session.cwd });
  const maxMessageId = () => db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages")!.id ?? 0;

  const activeOf = (conversationId: ConversationId): HandoverDbRow | undefined =>
    db.get<HandoverDbRow>(`SELECT * FROM handovers WHERE conversation_id = ? AND ${ACTIVE}`, conversationId);
  const rowOf = (id: HandoverId): HandoverDbRow | undefined => db.get<HandoverDbRow>("SELECT * FROM handovers WHERE id = ?", id);

  const inFlightTo = (session: AgentSessionRow) =>
    db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND session_id = ? AND status IN ('delivered', 'processing') LIMIT 1", session.conversationId, session.id) !==
    undefined;

  const isQuiescent = (session: AgentSessionRow, opts?: { allowBackgroundTasks?: boolean }): boolean => {
    const live = liveOf(session.id);
    if (live.activity !== "idle") return false;
    if (!opts?.allowBackgroundTasks && (live.backgroundTasks ?? 0) > 0) return false;
    if (inFlightTo(session)) return false;
    if (hasRunningSessionAction(db, session.id)) return false;
    if (isSessionBusy(session.id)) return false;
    if (hasPendingDriverEvents(session.id)) return false;
    if (hasPendingTurnCompletions(session.id)) return false;
    return true;
  };

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
    p.after.push(() => queue.add(row.conversation_id), onClaimable);
    return row;
  };

  const autoAllowed = (session: AgentSessionRow) =>
    session.role === "pm" &&
    (session.pmId === null || !isPmArchived(session.pmId)) &&
    session.usage.context >= thresholdOf(session.vendor) &&
    session.status !== "ended" &&
    session.status !== "broken" &&
    attemptsOf(session.id).counted < AUTO_RENEW_MAX_ATTEMPTS;

  const stillCurrent = (session: AgentSessionRow | null): session is AgentSessionRow =>
    session !== null && session.status !== "ended" && session.status !== "broken" && currentSession(session.conversationId!)?.id === session.id;

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
        p.after.push(() => queue.delete(row.conversation_id));
        return;
      }
      if (stillCurrent(session)) insertRow(p, session, true);
      return;
    }
    const detail = kind === HANDOVER_REASONS.error || kind === HANDOVER_REASONS.failed ? reason.slice(kind.length + 1).trim() : "";
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
    // Do not retry immediately; the conversation re-enters the queue at the end of the next turn.
    p.after.push(() => queue.delete(row.conversation_id));
  };

  /** If too much happened after the cut point, the handover is abandoned and rewritten. */
  const switchIn = (p: Pending, row: HandoverDbRow, old: AgentSessionRow, handover: string, turnStartId?: MessageId): boolean => {
    const conversationId = row.conversation_id;
    const vendorSwitch = row.method === VENDOR_SWITCH_METHOD;
    const cut = row.cut_message_id ?? 0;
    let picked: RecentMessage[] = [];
    if (!vendorSwitch) {
      const recent = pickRecent(recentRowsOf(db, conversationId), cut, HANDOVER_RECENT_CHARS);
      if (!isVendorSwitchRow(row) && row.to_vendor === null && recent.postCutChars > HANDOVER_POST_CUT_MAX_CHARS) {
        failRow(p, row, withDetail(HANDOVER_REASONS.postCut, `${recent.postCutChars} 字`));
        return false;
      }
      picked = recent.picked;
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
    const skills = loadedSkills.carryIn(conversationId, old.generation, next);
    // A quota hit on the old session carries over to a same-vendor successor, otherwise its first message fails again; cross-vendor switches do not copy it.
    if (vendor === old.vendor && old.rateLimit !== null) {
      db.run("UPDATE agent_sessions SET rate_limit = ? WHERE id = ?", JSON.stringify(old.rateLimit), next.id);
      updateLive(p, next.id, () => {});
    }
    if (row.to_vendor !== null && old.pmId !== null) {
      db.run("UPDATE pms SET vendor = ?, default_model = ?, effort = ? WHERE id = ?", vendor, model, effort, old.pmId);
      p.changes.push({ type: "pm.updated", data: { pm: toPm(pmRow(old.pmId)!) } });
    }
    enqueue(p, { type: "session.end", params: { sessionId: old.id, generation: old.generation } });
    if (!vendorSwitch) {
      insertSystemMessage(
        p,
        conversationId,
        { event: "session.renewed", sessionId: next.id, fromSessionId: old.id, handoverId: row.id, ...(turnStartId !== undefined ? { turnStartId } : {}), ...(auto ? { auto } : {}) },
        handover,
      );
    }
    // Held messages move to the new session; the driver prepends the opening brief to the first one.
    const held = db.all<MessageDbRow>("SELECT * FROM messages WHERE conversation_id = ? AND session_id = ? AND status = 'queued' ORDER BY id", conversationId, old.id);
    for (const message of held) {
      deletePendingSessionSend(db, old.id, message.id);
      db.run("UPDATE messages SET session_id = ?, updated_at = ? WHERE id = ?", next.id, now(), message.id);
      enqueue(p, { type: "session.send", params: { sessionId: next.id, messageId: message.id, source: message.sender === "user" || message.sender === "pm" ? "user" : "system" } });
      p.changes.push({ type: "message.updated", data: { message: getMessage(message.id)! } });
    }
    const preamble = vendorSwitch
      ? null
      : sessionPreambleText({
          auto,
          skills,
          handover,
          recent: recentText(picked),
          reports: reportsAfterOf(db, conversationId, cut),
          transcriptPath: transcriptOf(old),
          fromVendor: old.vendor,
          toVendor: next.vendor,
        });
    // Prespawn the new process so the first reply does not wait for startup.
    enqueue(p, { type: "session.start", params: { sessionId: next.id, generation: next.generation } });
    const t = now();
    db.run(
      "UPDATE handovers SET status = 'switched', to_session_id = ?, text = ?, cut_message_id = ?, preamble = ?, skills_section = ?, switched_at = ?, updated_at = ? WHERE id = ?",
      next.id,
      vendorSwitch ? null : handover,
      vendorSwitch ? null : row.cut_message_id,
      preamble,
      skills,
      t,
      t,
      row.id,
    );
    p.after.push(() => queue.delete(conversationId));
    if (!vendorSwitch) options.onRenewedIn?.(p, conversationId);
    return true;
  };

  const trySwitch = (p: Pending, row: HandoverDbRow): boolean => {
    const old = getAgentSession(db, row.from_session_id);
    if (!stillCurrent(old) || !isQuiescent(old)) return false;
    return switchIn(p, row, old, row.text ?? "");
  };

  const claimHandover = (): HandoverJob | null => {
    if (queue.size === 0) return null;
    return write(() => {
      const t = now();
      for (const conversationId of queue) {
        const row = activeOf(conversationId);
        if (row === undefined || row.status !== "queued" || row.method === "in_session") continue;
        const session = getAgentSession(db, row.from_session_id);
        if (!stillCurrent(session) || !isQuiescent(session, { allowBackgroundTasks: true })) continue;
        if (row.auto === 1 && t < attemptsOf(session.id).until) continue;
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
        writing ? fork.kind : (row.method ?? fork.kind),
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

  const recoverAfterRestart = (): void => {
    write((p) => {
      const rows = db.all<HandoverDbRow>("SELECT * FROM handovers WHERE status IN ('forking', 'writing') AND (method IS NULL OR method != 'in_session')");
      for (const row of rows) failRow(p, row, HANDOVER_REASONS.restart);
    });
  };

  const renewSession = (pmId: PmId): { handoverId: HandoverId } =>
    write((p) => {
      requirePm(pmId);
      assertPmNotArchived(pmId);
      const conversation = privateConversation(pmId)!;
      const active = activeOf(conversation.id);
      if (active !== undefined) {
        if (active.auto === 1) db.run("UPDATE handovers SET auto = 0, updated_at = ? WHERE id = ?", now(), active.id);
        return { handoverId: active.id };
      }
      return { handoverId: insertRow(p, currentSession(conversation.id)!, false).id };
    });

  const cancelHandoverIn = (p: Pending, conversationId: ConversationId): void => {
    const active = activeOf(conversationId);
    if (active !== undefined) {
      if (active.method === "in_session") {
        const session = getAgentSession(db, active.from_session_id);
        const request = session === null ? undefined : requestOf(session);
        if (request !== undefined) {
          endWriting(request);
          if (request.status === "queued") transition(p, request.id, "stopped");
        }
      }
      db.run(
        "UPDATE handovers SET status = 'abandoned', failure_reason = 'archived', updated_at = ? WHERE id = ?",
        now(),
        active.id,
      );
    }
    queue.delete(conversationId);
    p.after.push(() => queue.delete(conversationId));
  };

  const switchVendorIn = (p: Pending, conversationId: ConversationId, agent: AgentSetting): void => {
    const session = currentSession(conversationId);
    if (session === null) return;
    const active = activeOf(conversationId);
    if (active !== undefined) {
      if (!isVendorSwitchRow(active) && active.status === "ready" && (active.text ?? "").trim() !== "") {
        const updated = db.get<HandoverDbRow>(
          "UPDATE handovers SET to_vendor = ?, to_model = ?, to_effort = ?, auto = 0, updated_at = ? WHERE id = ? RETURNING *",
          agent.vendor,
          agent.model,
          agent.effort,
          now(),
          active.id,
        )!;
        queue.add(conversationId);
        trySwitch(p, updated);
        return;
      }
      if (active.method === "in_session") {
        const request = requestOf(session);
        if (request !== undefined) {
          if (request.status === "queued") {
            transition(p, request.id, "stopped");
          } else if (request.status === "delivered" || request.status === "processing") {
            endWriting(request);
            p.stops.push({ conversationId, sessionId: session.id });
          }
        }
      }
      const t = now();
      const updated = db.get<HandoverDbRow>(
        `UPDATE handovers
            SET status = 'ready', method = ?, auto = 0,
                to_vendor = ?, to_model = ?, to_effort = ?,
                cut_message_id = NULL, text = NULL, preamble = NULL, ready_at = ?, updated_at = ?
          WHERE id = ? RETURNING *`,
        VENDOR_SWITCH_METHOD,
        agent.vendor,
        agent.model,
        agent.effort,
        t,
        t,
        active.id,
      )!;
      queue.add(conversationId);
      trySwitch(p, updated);
      return;
    }
    const t = now();
    const row = db.get<HandoverDbRow>(
      `INSERT INTO handovers (conversation_id, from_session_id, auto, method, status, to_vendor, to_model, to_effort, cut_message_id, text, ready_at, created_at, updated_at)
       VALUES (?, ?, 0, ?, 'ready', ?, ?, ?, NULL, NULL, ?, ?, ?) RETURNING *`,
      conversationId,
      session.id,
      VENDOR_SWITCH_METHOD,
      agent.vendor,
      agent.model,
      agent.effort,
      t,
      t,
      t,
    )!;
    queue.add(conversationId);
    trySwitch(p, row);
  };

  const clearVendorSwitchIn = (conversationId: ConversationId): void => {
    const active = activeOf(conversationId);
    if (active === undefined || active.to_vendor === null) return;
    if (isVendorSwitchRow(active)) {
      db.run(
        "UPDATE handovers SET status = 'abandoned', failure_reason = ?, to_vendor = NULL, to_model = NULL, to_effort = NULL, updated_at = ? WHERE id = ?",
        HANDOVER_REASONS.userMessage,
        now(),
        active.id,
      );
      const old = getAgentSession(db, active.from_session_id);
      if (old === null || !autoAllowed(old)) queue.delete(conversationId);
      return;
    }
    db.run("UPDATE handovers SET to_vendor = NULL, to_model = NULL, to_effort = NULL, updated_at = ? WHERE id = ?", now(), active.id);
  };

  const requestOf = (session: AgentSessionRow): MessageDbRow | undefined =>
    db.get<MessageDbRow>(
      "SELECT * FROM messages WHERE dedupe_key = ?",
      systemMessageDedupeKey(session.conversationId!, { event: "handover.requested", sessionId: session.id }),
    );

  const renewedOf = (session: AgentSessionRow): MessageDbRow | undefined =>
    db.get<MessageDbRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND ${IS_R} AND json_extract(meta, '$.sessionId') = ? ORDER BY id DESC LIMIT 1`,
      session.conversationId,
      session.id,
    );

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
      // A stop that the driver has not finished yet keeps the same request queued rather than creating a new one.
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

  const inSessionOf = (conversationId: ConversationId): HandoverDbRow | undefined => {
    const row = activeOf(conversationId);
    return row?.method === "in_session" && row.status === "writing" ? row : undefined;
  };

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

  const endWriting = (request: MessageDbRow) => {
    const meta = metaOf(request);
    if (meta.writing === true) setMeta(request.id, { ...meta, writing: false });
  };

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

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "pm" || session.conversationId === null) return;
    const conversationId = session.conversationId;
    if (event.type === "message.processing") {
      if (event.preamble === true && session.generation > 1) {
        db.run("INSERT OR IGNORE INTO session_preamble_seen (session_id, seen_at) VALUES (?, ?)", session.id, now());
        clearConsumedHandoverBlobsIn(db, session.id);
        const renewed = renewedOf(session);
        if (renewed !== undefined && metaOf(renewed).seen !== true) setMeta(renewed.id, { ...metaOf(renewed), seen: true });
      }
      if (inSessionOf(conversationId) === undefined) return;
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
      if (event.count === 0 && queue.has(conversationId)) {
        const row = activeOf(conversationId);
        if (row?.status === "ready") trySwitch(p, row);
      }
      return;
    }
    if (event.type === "message.requeued" || event.type === "message.cancelled") {
      if (!queue.has(conversationId) || !stillCurrent(session)) return;
      const row = activeOf(conversationId);
      if (row?.status === "ready" && row.from_session_id === session.id) trySwitch(p, row);
      else if (row?.status === "queued" && row.method !== "in_session" && isQuiescent(session, { allowBackgroundTasks: true })) p.after.push(onClaimable);
      return;
    }
    if (event.type !== "turn.ended" && event.type !== "session.exited" && event.type !== "driver.error") return;
    if (!queue.has(conversationId) && activeOf(conversationId) === undefined &&
        (event.type !== "turn.ended" || session.usage.context < thresholdOf(session.vendor))) return;
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
    if (row?.status === "ready" && row.from_session_id === session.id) {
      trySwitch(p, row);
      return;
    }
    if (row === undefined && event.type === "turn.ended") {
      if (autoAllowed(session)) insertRow(p, session, true);
      return;
    }
    if (row?.status === "queued" && row.method !== "in_session") p.after.push(onClaimable);
  };

  const actionFailedIn = (p: Pending, action: AnyActionRow) => {
    if (action.type !== "session.send") return;
    const message = getMessage(action.params.messageId);
    if (message !== null && message.sessionId === action.params.sessionId) settleInSession(p, message.conversationId);
  };

  const sessionPreamble = (sessionId: SessionId): string | null => {
    const session = getAgentSession(db, sessionId);
    if (session === null || session.role !== "pm" || session.conversationId === null || session.generation <= 1) return null;
    if (db.get("SELECT 1 AS x FROM session_preamble_seen WHERE session_id = ?", sessionId) !== undefined) return null;

    const hRow = db.get<HandoverDbRow>(
      "SELECT * FROM handovers WHERE to_session_id = ? AND status = 'switched' ORDER BY id DESC LIMIT 1",
      sessionId,
    );
    let base: string | null;
    if (hRow !== undefined && hRow.method === VENDOR_SWITCH_METHOD) {
      const anchor = generationAnchorOfDb(db, session.conversationId);
      const context = collectGenerationContext(
        generationMessagesNewestFirstOf(db, session.conversationId, anchor.cutMessageId),
        { targetSessionId: session.id },
      );
      const priorSessions = priorGenerationSessionsOfDb(db, session.conversationId, anchor.startSessionId, session.id);
      const fromSession = getAgentSession(db, hRow.from_session_id);
      base = buildVendorSwitchPreamble({
        fromVendor: fromSession?.vendor ?? session.vendor,
        toVendor: session.vendor,
        anchor,
        context,
        skills: hRow.skills_section,
        transcriptSummary: describeGenerationTranscripts(priorSessions, findTranscript),
      });
    } else {
      const row = renewedOf(session);
      if (row === undefined || row.status !== null) return null;
      const meta = metaOf(row);
      if (meta.seen === true) return null;
      if (hRow !== undefined) {
        base = hRow.preamble;
      } else if (meta.handoverId !== undefined) {
        base = db.get<{ preamble: string | null }>("SELECT preamble FROM handovers WHERE id = ?", meta.handoverId)?.preamble ?? null;
      } else {
        const old = meta.fromSessionId === undefined ? null : getAgentSession(db, meta.fromSessionId);
        const upTo = meta.turnStartId ?? row.id;
        const { picked } = pickRecent(recentRowsOf(db, session.conversationId, upTo), upTo, HANDOVER_RECENT_CHARS);
        base = sessionPreambleText({
          auto: meta.auto === true,
          skills: null,
          handover: row.text,
          recent: recentText(picked),
          reports: [],
          transcriptPath: old === null ? null : transcriptOf(old),
          fromVendor: old?.vendor,
          toVendor: session.vendor,
        });
      }
    }
    if (base === null) return null;
    const waiting = `${base}\n\n## 在等用户的提问卡（账本实时状态）\n\n${waitingAsksSection(options.waitingAsks?.(session.conversationId) ?? [])}`;
    const liveGraphs = session.pmId === null ? null : (options.liveActiveGraphsSection?.(session.pmId) ?? null);
    return liveGraphs === null || liveGraphs === ""
      ? waiting
      : `${waiting}\n\n## 未完结的任务图（账本实时状态）\n\n${liveGraphs}`;
  };

  const waitsForHandover = (messageId: MessageId): boolean => {
    const message = db.get<MessageDbRow>("SELECT * FROM messages WHERE id = ?", messageId);
    if (message === undefined) return false;
    if (systemEventOf(toMessage(message))?.event === "handover.requested") {
      if (message.session_id === null) return false;
      const session = getAgentSession(db, message.session_id);
      if (session === null) return false;
      return (
        liveOf(session.id).activity !== "idle" ||
        inFlightTo(session) ||
        isSessionBusy(session.id) ||
        hasPendingDriverEvents(session.id) ||
        hasPendingTurnCompletions(session.id)
      );
    }
    if (message.status !== "queued" || !queue.has(message.conversation_id)) return false;
    const row = activeOf(message.conversation_id);
    if (row === undefined || message.session_id !== row.from_session_id) return false;
    if (row.status === "ready") return (liveOf(row.from_session_id).backgroundTasks ?? 0) === 0;
    if (row.method !== "in_session" || row.status !== "writing") return false;
    const session = getAgentSession(db, row.from_session_id);
    const request = session === null ? undefined : requestOf(session);
    return request !== undefined && IN_FLIGHT.has(request.status!);
  };

  const onSessionQuiescent = (sessionId: SessionId): void => {
    if (queue.size === 0) return;
    const session = getAgentSession(db, sessionId);
    if (session === null || session.role !== "pm" || session.conversationId === null || !queue.has(session.conversationId)) return;
    const row = activeOf(session.conversationId);
    if (row === undefined || row.from_session_id !== sessionId) return;
    if (row.status === "ready" && isQuiescent(session)) {
      write((p) => {
        const fresh = activeOf(session.conversationId!);
        if (fresh?.status === "ready" && fresh.from_session_id === sessionId) trySwitch(p, fresh);
      });
    } else if (row.status === "queued" && row.method !== "in_session" && isQuiescent(session, { allowBackgroundTasks: true })) {
      onClaimable();
    }
  };

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
        if (!isVendorSwitchRow(row) && t - (row.ready_at ?? row.updated_at) >= HANDOVER_READY_MAX_MS) write((p) => failRow(p, row, HANDOVER_REASONS.stale));
        else if (row.from_session_id === session.id && isQuiescent(session)) write((p) => trySwitch(p, row));
        continue;
      }
      if (row.method !== "in_session") continue;
      if (row.status === "queued") {
        if (!isQuiescent(session)) continue;
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
      if (request.status === "queued" && live.activity !== "idle") continue;
      const since = meta.startedAt ?? meta.requestedAt ?? request.created_at;
      if (t - since >= timeoutMs) write((p) => abandonIn(p, session, request, meta));
    }
  };

  return {
    renewSession,
    cancelHandoverIn,
    switchVendorIn,
    clearVendorSwitchIn,
    waitsForHandover,
    onSessionQuiescent,
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
