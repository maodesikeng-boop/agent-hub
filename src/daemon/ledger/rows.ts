// 数据库行 ↔ src/shared 的形状（驼峰 ↔ 下划线、JSON、布尔）。
import { isJellyColorId, isPmFruit } from "../../shared/slimes.ts";
import type {
  Conversation,
  ConversationKind,
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
  WorkerRecord,
  WorkerStatus,
  WorkerWorkspace,
} from "../../shared/domain.ts";
import { parseReviewTarget } from "../../shared/review.ts";
import type { ScheduleKind, ScheduleRecord, ScheduleStatus } from "../../shared/schedule.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

/**
 * 读项目经理一律用它（再接 WHERE、ORDER BY）：带上归档时间和换过的形象（pm_looks，没换过是 NULL）。
 * pms.avatar_file 从 0001 就有，一直没人写，不读。
 */
export const PM_SELECT =
  "SELECT p.*, a.archived_at, l.fruit AS look_fruit, l.color AS look_color FROM pms p LEFT JOIN pm_archives a ON a.pm_id = p.id LEFT JOIN pm_looks l ON l.pm_id = p.id";

export interface PmDbRow {
  id: number;
  name: string;
  mode: string;
  default_model: string | null;
  persona_file: string | null;
  vendor: string;
  effort: string | null;
  /** 性格设定正文，以它为准；M1 升上来的是 NULL。 */
  persona: string | null;
  /** 上次成功写入性格设定文件的内容哈希。只有账本用，不进 Pm。 */
  persona_file_hash: string | null;
  created_at: number;
  archived_at?: number | null;
  /** pm_looks 的造型、颜色（PM_SELECT 带出来）；没换过、或不是用 PM_SELECT 读的是 NULL / 没有。 */
  look_fruit?: string | null;
  look_color?: string | null;
}

export interface ProjectDbRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  pm_id: number;
  conversation_id: number;
  /** worktree 准备命令（0005）；NULL = 没配。 */
  setup_command: string | null;
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
  vendor_before: string;
  vendor_after: string;
  model_before: string | null;
  model_after: string | null;
  effort_before: string | null;
  effort_after: string | null;
  reason: string | null;
  revert_of: number | null;
  created_at: number;
}

export interface ConversationDbRow {
  id: number;
  kind: string;
  pm_id: number | null;
  project_id: number | null;
  title: string;
  created_at: number;
  /** 只有快照的查询 LEFT JOIN conversation_purges 带上这一列（没清过是 null）。 */
  purged_at?: number | null;
}

export interface MessageDbRow {
  id: number;
  conversation_id: number;
  session_id: number | null;
  worker_id: number | null;
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

export interface WorkerDbRow {
  id: number;
  project_id: number;
  pm_id: number;
  pm_conversation_id: number;
  worker_conversation_id: number;
  title: string;
  task: string;
  model: string | null;
  effort: string | null;
  readonly: number;
  workspace: string;
  branch: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  review_json: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ScheduleDbRow {
  id: number;
  pm_id: number;
  name: string;
  kind: string;
  at_time: string | null;
  every_minutes: number | null;
  prompt: string;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_message_id: number | null;
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
    // 别的版本写进来的、名录里没有的值当默认（shared/slimes.ts 的 resolvePmLook 也会兜底）
    avatarFruit: isPmFruit(row.look_fruit) ? row.look_fruit : null,
    avatarColor: isJellyColorId(row.look_color) ? row.look_color : null,
    mode: row.mode as PmMode,
    vendor: row.vendor as AgentVendor,
    defaultModel: row.default_model,
    effort: row.effort,
    personaFile: row.persona_file,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
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
    // 只有被保留期清理过的 Worker 对话才带这一项（没清过不带，省得改老数据和测试里的对话对象）
    ...(row.purged_at != null ? { purgedAt: row.purged_at } : {}),
  };
}

/**
 * 给网页的消息列（快照、往上翻页）：工具调用的 meta.input 在 SQLite 里就去掉，不把可能几百 KB 的文件内容读进 JS 再解析、丢掉。
 * parseMessageMeta 照样兜底去 input。text 换成 '' 时只给算窗口用（ledger/snapshot.ts），不能发出去。
 */
const messageColumns = (text: "text" | "''") =>
  `id, conversation_id, session_id, worker_id, sender, kind, ${text} AS text,
   CASE WHEN kind = 'tool' THEN json_remove(meta, '$.input') ELSE meta END AS meta,
   collapsed, dedupe_key, status, failure_reason, created_at, updated_at`;
export const WEB_MESSAGE_COLUMNS = messageColumns("text");
export const MESSAGE_SHAPE_COLUMNS = messageColumns("''");

export function parseMessageMeta(kind: string, raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // 工具调用的摘要已在 text 里（summarizeToolCall），网页端不读 meta.input（Write/Edit 等可能带整份文件内容），对外消息去掉 input 免得撑爆快照。
  if (kind === "tool" && "input" in parsed) {
    const { input: _input, ...rest } = parsed;
    return rest;
  }
  return parsed;
}

export function toMessage(row: MessageDbRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    sender: row.sender as MessageSender,
    kind: row.kind as MessageKind,
    text: row.text,
    meta: parseMessageMeta(row.kind, row.meta),
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
    vendorBefore: row.vendor_before as AgentVendor,
    vendorAfter: row.vendor_after as AgentVendor,
    modelBefore: row.model_before,
    modelAfter: row.model_after,
    effortBefore: row.effort_before,
    effortAfter: row.effort_after,
    reason: row.reason,
    revertOf: row.revert_of,
    createdAt: row.created_at,
  };
}

export function toWorkerRecord(row: WorkerDbRow): WorkerRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    pmId: row.pm_id,
    pmConversationId: row.pm_conversation_id,
    workerConversationId: row.worker_conversation_id,
    title: row.title,
    task: row.task,
    model: row.model,
    effort: row.effort,
    readonly: row.readonly === 1,
    workspace: row.workspace as WorkerWorkspace,
    branch: row.branch,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    ...(row.review_json === null ? {} : { review: parseReviewTarget(row.review_json)! }),
    status: row.status as WorkerStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSchedule(row: ScheduleDbRow): ScheduleRecord {
  return {
    id: row.id,
    pmId: row.pm_id,
    name: row.name,
    kind: row.kind as ScheduleKind,
    atTime: row.at_time,
    everyMinutes: row.every_minutes,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as ScheduleStatus | null,
    lastError: row.last_error,
    lastMessageId: row.last_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
