// 数据库行 ↔ src/shared 的形状（驼峰 ↔ 下划线、JSON、布尔）。
import type { Conversation, ConversationKind, HealthEntry, HealthModule, Message, MessageKind, MessageSender, MessageStatus, Pm } from "../../shared/domain.ts";

export interface PmDbRow {
  id: number;
  name: string;
  avatar_file: string | null;
  mode: string;
  default_model: string | null;
  persona_file: string | null;
  created_at: number;
}

export interface ConversationDbRow {
  id: number;
  kind: string;
  pm_id: number | null;
  project_id: number | null;
  title: string;
  created_at: number;
}

export interface MessageDbRow {
  id: number;
  conversation_id: number;
  session_id: number | null;
  ticket_id: number | null;
  sender: string;
  kind: string;
  text: string;
  meta: string | null;
  collapsed: number;
  dedupe_key: string;
  status: string | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface HealthDbRow {
  module: string;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: number;
}

export function toPm(row: PmDbRow): Pm {
  return {
    id: row.id,
    name: row.name,
    avatarFile: row.avatar_file,
    mode: row.mode,
    defaultModel: row.default_model,
    personaFile: row.persona_file,
    createdAt: row.created_at,
  };
}

export function toConversation(row: ConversationDbRow): Conversation {
  return {
    id: row.id,
    kind: row.kind as ConversationKind,
    pmId: row.pm_id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
  };
}

export function toMessage(row: MessageDbRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    ticketId: row.ticket_id,
    sender: row.sender as MessageSender,
    kind: row.kind as MessageKind,
    text: row.text,
    meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>),
    collapsed: row.collapsed === 1,
    dedupeKey: row.dedupe_key,
    status: row.status as MessageStatus | null,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toHealth(row: HealthDbRow): HealthEntry {
  return {
    module: row.module as HealthModule,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
