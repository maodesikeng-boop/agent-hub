import { agentTextOf } from "../../shared/attachments.ts";
import { workerEventOf, type AgentSessionRow, type ConversationId, type Message, type MessageId, type SessionId } from "../../shared/domain.ts";
import type { SessionPreambleOptions } from "../../shared/driver.ts";
import type { HandoverId } from "../../shared/handover.ts";
import {
  HANDOVER_RECENT_CHARS,
  HANDOVER_RECENT_MAX_BYTES,
  VENDOR_SWITCH_CONTEXT_MAX_BYTES,
  VENDOR_SWITCH_TRANSCRIPTS_MAX,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { pendingAsksSection } from "../../shared/pending-asks.ts";
import { preambleAgendaSection } from "../../shared/pm-agenda.ts";
import { workerLineText } from "../../shared/worker.ts";
import { getAgentSession, type Db } from "../store/index.ts";
import { PROCESS_MESSAGE_KINDS_SQL } from "./checklist.ts";
import {
  assembleBudgetedPreamble,
  computePreambleByteBudget,
  fitLegacyPreambleToBudget,
  type PreambleBudgetOptions,
} from "./handover-budget.ts";
import { pickRecent, recentEntriesNewestFirst, type RecentMessage } from "./handover-recent.ts";
import { HANDOVER_STALE_HINT, sessionPreambleHeader } from "./handover-text.ts";
import { pendingAsksOfPm } from "./pending-asks.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { toMessage, type MessageDbRow } from "./rows.ts";
import {
  VENDOR_SWITCH_ANCHOR_HINT,
  VENDOR_SWITCH_TRUNCATED_HINT,
  collectGenerationEntriesNewestFirst,
  describeGenerationTranscripts,
  vendorSwitchPreambleHeader,
  type GenerationAnchor,
  type PriorSessionTranscriptRef,
  type TranscriptLookup,
} from "./vendor-switch-context.ts";

export interface HandoverPreambleRow {
  id: HandoverId;
  conversation_id: ConversationId;
  from_session_id: SessionId;
  to_session_id: SessionId | null;
  auto: number;
  method: string | null;
  cut_message_id: MessageId | null;
  text: string | null;
  preamble: string | null;
  skills_section: string | null;
}

export interface RenewedMessageMeta {
  handoverId?: HandoverId;
  fromSessionId?: SessionId;
  auto?: boolean;
  turnStartId?: number;
  seen?: boolean;
}

const NOT_HANDOVER_TURN = "COALESCE(json_extract(CASE WHEN json_valid(m.meta) THEN m.meta END, '$.handover'), 0) != 1";
const RECENT_PAGE = 100;

export function* recentRowsOf(
  db: Db,
  conversationId: ConversationId,
  upTo = Number.MAX_SAFE_INTEGER - 1,
  excludeSessionId?: SessionId,
): Generator<RecentMessage> {
  let before = upTo + 1;
  for (;;) {
    const rows =
      excludeSessionId === undefined
        ? db.all<MessageDbRow & { generation: number | null }>(
            `SELECT m.*, s.generation AS generation FROM messages m LEFT JOIN agent_sessions s ON s.id = m.session_id
             WHERE m.conversation_id = ? AND m.id < ? AND m.kind = 'text'
               AND ((m.sender = 'agent' AND ${NOT_HANDOVER_TURN}) OR (m.sender = 'user' AND m.status IN ('replied', 'failed', 'stopped')))
             ORDER BY m.id DESC LIMIT ?`,
            conversationId,
            before,
            RECENT_PAGE,
          )
        : db.all<MessageDbRow & { generation: number | null }>(
            `SELECT m.*, s.generation AS generation FROM messages m LEFT JOIN agent_sessions s ON s.id = m.session_id
             WHERE m.conversation_id = ? AND m.id < ? AND m.kind = 'text'
               AND (m.session_id IS NULL OR m.session_id != ?)
               AND ((m.sender = 'agent' AND ${NOT_HANDOVER_TURN}) OR (m.sender = 'user' AND m.status IN ('replied', 'failed', 'stopped')))
             ORDER BY m.id DESC LIMIT ?`,
            conversationId,
            before,
            excludeSessionId,
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

function* generationMessagesNewestFirstOf(
  db: Db,
  conversationId: ConversationId,
  cutMessageId: MessageId,
  targetSessionId: SessionId,
): Generator<Message> {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = db.all<MessageDbRow>(
      `SELECT * FROM messages
        WHERE conversation_id = ? AND id > ? AND id < ? AND kind NOT IN ${PROCESS_MESSAGE_KINDS_SQL}
          AND NOT (session_id = ? AND sender IN ('user', 'agent'))
        ORDER BY id DESC
        LIMIT ?`,
      conversationId,
      cutMessageId,
      before,
      targetSessionId,
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

export function buildBudgetedSessionPreamble(input: {
  db: Db;
  session: AgentSessionRow;
  hRow: HandoverPreambleRow | undefined;
  renewedRow: MessageDbRow | undefined;
  renewedMeta: RenewedMessageMeta | undefined;
  rowById: (id: HandoverId) => HandoverPreambleRow | undefined;
  findTranscript: TranscriptLookup;
  at: number;
  options?: SessionPreambleOptions;
}): string | null {
  const { db, session, hRow, renewedRow, renewedMeta, rowById, findTranscript, at, options } = input;
  if (session.conversationId === null) return null;

  const pendingAsksText = `## 在等用户的提问卡（账本实时状态）\n\n${pendingAsksSection(session.pmId === null ? [] : pendingAsksOfPm(db, session.pmId), at)}`;
  let agendaText: string | null = null;
  if (session.pmId !== null) {
    const agenda = pmAgendaOf(db, session.pmId, at);
    if (agenda.graphs.length > 0 || agenda.outside.length > 0 || agenda.userCards > 0) {
      agendaText = preambleAgendaSection(agenda, at);
    }
  }
  const budgetOpts: PreambleBudgetOptions = {
    vendor: session.vendor,
    ...(options?.reservedBytes !== undefined ? { reservedBytes: options.reservedBytes } : {}),
  };

  if (hRow !== undefined && hRow.method === "vendor_switch") {
    const anchor = generationAnchorOfDb(db, session.conversationId);
    const maxHistoryBytes = Math.min(VENDOR_SWITCH_CONTEXT_MAX_BYTES, computePreambleByteBudget(session.vendor, options?.reservedBytes));
    const collected = collectGenerationEntriesNewestFirst(
      generationMessagesNewestFirstOf(db, session.conversationId, anchor.cutMessageId, session.id),
      { targetSessionId: session.id, maxBytes: Math.max(maxHistoryBytes, 0) },
    );
    const priorSessions = priorGenerationSessionsOfDb(db, session.conversationId, anchor.startSessionId, session.id);
    const fromSession = getAgentSession(db, hRow.from_session_id);
    return assembleBudgetedPreamble(
      {
        header: vendorSwitchPreambleHeader({
          fromVendor: fromSession?.vendor ?? session.vendor,
          toVendor: session.vendor,
          hasSkills: hRow.skills_section !== null,
          transcriptSummary: describeGenerationTranscripts(priorSessions, findTranscript),
        }),
        skillsIndex: hRow.skills_section,
        summaryHeading: "## 本代起点摘要（上次会话换代时保存的背景）",
        summaryBody: anchor.summaryText !== null && anchor.summaryText.trim() !== "" ? `${VENDOR_SWITCH_ANCHOR_HINT}\n\n${anchor.summaryText}` : null,
        historyHeading: "## 本代完整对话与 Worker 汇报记录",
        historyEntriesNewestFirst: collected.entries,
        historyEmptyText: "（本代尚无历史消息）",
        historyTruncatedHint: VENDOR_SWITCH_TRUNCATED_HINT,
        pendingAsksSection: pendingAsksText,
        agendaSection: agendaText,
      },
      { ...budgetOpts, historyMaxBytes: VENDOR_SWITCH_CONTEXT_MAX_BYTES },
    ).text;
  }

  if (renewedRow === undefined || renewedRow.status !== null || renewedMeta?.seen === true) return null;
  const handoverRow = hRow ?? (renewedMeta?.handoverId !== undefined ? rowById(renewedMeta.handoverId) : undefined);
  if (handoverRow?.preamble != null) {
    const live = agendaText === null ? [pendingAsksText] : [pendingAsksText, agendaText];
    return fitLegacyPreambleToBudget(handoverRow.preamble, live, budgetOpts).text;
  }

  const fromSession =
    handoverRow !== undefined
      ? getAgentSession(db, handoverRow.from_session_id)
      : renewedMeta?.fromSessionId === undefined
        ? null
        : getAgentSession(db, renewedMeta.fromSessionId);
  const cut = handoverRow !== undefined ? (handoverRow.cut_message_id ?? 0) : (renewedMeta?.turnStartId ?? renewedRow.id);
  const upTo = handoverRow !== undefined ? Number.MAX_SAFE_INTEGER - 1 : cut;
  const { picked } = pickRecent(recentRowsOf(db, session.conversationId, upTo, session.id), cut, HANDOVER_RECENT_CHARS);
  const handoverText = handoverRow?.text ?? renewedRow.text;
  const skills = handoverRow?.skills_section ?? null;
  const transcriptPath =
    fromSession === null
      ? null
      : findTranscript({ vendor: fromSession.vendor, vendorSessionId: fromSession.vendorSessionId, cwd: fromSession.cwd });
  return assembleBudgetedPreamble(
    {
      header: sessionPreambleHeader({
        auto: handoverRow !== undefined ? handoverRow.auto === 1 : renewedMeta?.auto === true,
        hasSkills: skills !== null,
        transcriptPath,
        fromVendor: fromSession?.vendor,
        toVendor: session.vendor,
      }),
      skillsIndex: skills,
      summaryHeading: "## 交接",
      summaryBody: handoverText.trim() === "" ? "（上一个会话没有写交接）" : `${HANDOVER_STALE_HINT}\n\n${handoverText}`,
      historyHeading: "## 最近的原话",
      historyEntriesNewestFirst: recentEntriesNewestFirst(picked),
      historyEmptyText: "（没有）",
      historyTruncatedHint: "（注：更早的原话已按消息预算省略，以下为离当前最近的内容）",
      reportsHeading: "## 交接之后到的 Worker 汇报（交接里没有，只列目录）",
      reports: handoverRow !== undefined ? reportsAfterOf(db, session.conversationId, cut) : [],
      pendingAsksSection: pendingAsksText,
      agendaSection: agendaText,
    },
    { ...budgetOpts, historyMaxBytes: HANDOVER_RECENT_MAX_BYTES },
  ).text;
}
