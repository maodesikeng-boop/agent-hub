// 数据库行 ↔ src/shared 的形状（驼峰 ↔ 下划线、JSON、布尔）。
import type {
  Conversation,
  ConversationKind,
  Handoff,
  HandoffReason,
  HealthEntry,
  HealthModule,
  Message,
  MessageKind,
  MessageSender,
  MessageStatus,
  PersonaActor,
  PersonaChange,
  Pm,
  PmMode,
  Project,
  ProjectFolder,
  ProjectStatus,
} from "../../shared/domain.ts";

export interface PmDbRow {
  id: number;
  name: string;
  avatar_file: string | null;
  mode: string;
  default_model: string | null;
  persona_file: string | null;
  /** 性格设定正文，以它为准；M1 升上来的是 NULL。 */
  persona: string | null;
  /** 上次成功写入性格设定文件的内容哈希。只有账本用，不进 Pm。 */
  persona_file_hash: string | null;
  created_at: number;
}

export interface ProjectDbRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  pm_id: number;
  conversation_id: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectFolderDbRow {
  id: number;
  project_id: number;
  path: string;
  is_main: number;
  added_at: number;
  removed_at: number | null;
}

export interface PersonaChangeDbRow {
  id: number;
  pm_id: number;
  actor: string;
  session_id: number | null;
  text_before: string;
  text_after: string;
  mode_before: string;
  mode_after: string;
  reason: string | null;
  revert_of: number | null;
  created_at: number;
}

export interface HandoffDbRow {
  id: number;
  project_id: number;
  from_session_id: number;
  to_session_id: number;
  from_pm_id: number;
  to_pm_id: number;
  file: string;
  reason: string;
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
    mode: row.mode as PmMode,
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

export function toProject(row: ProjectDbRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    pmId: row.pm_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toProjectFolder(row: ProjectFolderDbRow): ProjectFolder {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    isMain: row.is_main === 1,
    addedAt: row.added_at,
    removedAt: row.removed_at,
  };
}

export function toPersonaChange(row: PersonaChangeDbRow): PersonaChange {
  return {
    id: row.id,
    pmId: row.pm_id,
    actor: row.actor as PersonaActor,
    sessionId: row.session_id,
    textBefore: row.text_before,
    textAfter: row.text_after,
    modeBefore: row.mode_before as PmMode,
    modeAfter: row.mode_after as PmMode,
    reason: row.reason,
    revertOf: row.revert_of,
    createdAt: row.created_at,
  };
}

export function toHandoff(row: HandoffDbRow): Handoff {
  return {
    id: row.id,
    projectId: row.project_id,
    fromSessionId: row.from_session_id,
    toSessionId: row.to_session_id,
    fromPmId: row.from_pm_id,
    toPmId: row.to_pm_id,
    file: row.file,
    reason: row.reason as HandoffReason,
    createdAt: row.created_at,
  };
}
