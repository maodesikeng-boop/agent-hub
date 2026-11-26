import {
  ASK_MAX_OPTION_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MIN_OPTIONS,
  MAX_NAME_CHARS,
  MAX_PM_MEMORY_FILE_NAME_CHARS,
  MAX_WORKER_TITLE_CHARS,
  PM_MEMORY_INDEX_FILE,
} from "./limits.ts";
import { deliverablesOf, type Deliverable } from "./deliverables.ts";
import type { ReviewTarget, StoredReviewVerdict } from "./review.ts";
import type { SandboxApprovalId, SandboxApprovalRef } from "./sandbox-approval.ts";
import { APP_APPROVAL_RISK_LEVELS, type AppApprovalRef } from "./app-approval.ts";
import type { ScheduleId } from "./schedule.ts";
import type { UserBlocker, UserBlockerId } from "./user-blockers.ts";
import type { PmFruit } from "./fruits.ts";
import type { JellyColorId } from "./slimes.ts";
import type { AgentVendor } from "./vendors.ts";
import type { WorkerReportStatus } from "./worker.ts";

export type PmId = number;
export type ConversationId = number;
export type MessageId = number;
export type SessionId = number;
export type ActionId = number;
export type ProjectId = number;
type ProjectFolderId = number;
export type PersonaChangeId = number;
export type WorkerId = number;
export type RouterItemId = number;
export type RouterCommandId = number;
export type TaskGraphId = number;
export type TaskNodeKey = string;

export type Unsubscribe = () => void;

export function isOneOf<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

export const CONVERSATION_KINDS = ["assistant", "pm", "project_group", "worker"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const MESSAGE_STATUSES = ["queued", "delivered", "processing", "replied", "stopped", "failed", "cancelled"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const MESSAGE_STATUS_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ["delivered", "failed", "stopped", "cancelled"],
  delivered: ["processing", "stopped", "failed", "cancelled", "queued"],
  processing: ["replied", "stopped", "failed"],
  replied: [],
  stopped: [],
  failed: ["queued", "delivered"],
  cancelled: [],
};

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return MESSAGE_STATUS_TRANSITIONS[from].includes(to);
}

export const MESSAGE_SENDERS = ["user", "agent", "system", "pm"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

export const MESSAGE_KINDS = ["text", "tool", "worker", "checklist"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const WORKER_MESSAGE_KIND = "worker" satisfies MessageKind;

const AGENT_ROLES = ["assistant", "pm", "worker"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type SessionRole = Extract<AgentRole, "pm" | "worker">;

const SESSION_STATUSES = ["idle", "running", "ended", "broken"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PM_MODES = ["manage_only", "hands_on"] as const;
export type PmMode = (typeof PM_MODES)[number];
export const DEFAULT_PM_MODE: PmMode = "manage_only";

export const PM_MODE_LABELS: Readonly<Record<PmMode, string>> = {
  manage_only: "只管理",
  hands_on: "自己也干活",
};

export interface Pm {
  id: PmId;
  name: string;
  avatarFruit?: PmFruit | null;
  avatarColor?: JellyColorId | null;
  mode: PmMode;
  vendor: AgentVendor;
  defaultModel: string | null;
  effort: string | null;
  personaFile: string | null;
  createdAt: number;
  archivedAt?: number | null;
  /** When the PM was pinned on its computer; null or missing means not pinned. Older daemons omit it. */
  pinnedAt?: number | null;
}

export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  pmId: PmId | null;
  projectId: ProjectId | null;
  title: string;
  createdAt: number;
  purgedAt?: number;
}

export const PROJECT_STATUSES = ["active", "archived", "deleted"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: ProjectId;
  name: string;
  description: string | null;
  status: ProjectStatus;
  pmId: PmId;
  conversationId: ConversationId;
  setupCommand: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectFolder {
  id: ProjectFolderId;
  projectId: ProjectId;
  path: string;
  isMain: boolean;
  addedAt: number;
  removedAt: number | null;
}

export const WORKER_STATUSES = ["open", "ended"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const WORKER_WORKSPACES = ["worktree", "main"] as const;
export type WorkerWorkspace = (typeof WORKER_WORKSPACES)[number];

export interface WorkerRecord {
  id: WorkerId;
  projectId: ProjectId;
  pmId: PmId;
  pmConversationId: ConversationId;
  workerConversationId: ConversationId;
  title: string;
  task: string;
  model: string | null;
  effort: string | null;
  readonly: boolean;
  workspace: WorkerWorkspace;
  branch: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  takeoverOf?: WorkerId;
  review?: ReviewTarget;
  status: WorkerStatus;
  createdAt: number;
  updatedAt: number;
}

export const PERSONA_ACTORS = ["user", "pm", "file"] as const;
export type PersonaActor = (typeof PERSONA_ACTORS)[number];

export interface PersonaChange {
  id: PersonaChangeId;
  pmId: PmId;
  actor: PersonaActor;
  sessionId: SessionId | null;
  textBefore: string;
  textAfter: string;
  modeBefore: PmMode;
  modeAfter: PmMode;
  vendorBefore: AgentVendor;
  vendorAfter: AgentVendor;
  modelBefore: string | null;
  modelAfter: string | null;
  effortBefore: string | null;
  effortAfter: string | null;
  reason: string | null;
  revertOf: PersonaChangeId | null;
  createdAt: number;
}

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  sessionId: SessionId | null;
  workerId: WorkerId | null;
  sender: MessageSender;
  kind: MessageKind;
  text: string;
  meta: Record<string, unknown> | null;
  collapsed: boolean;
  dedupeKey: string;
  status: MessageStatus | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export function userMessageDedupeKey(conversationId: ConversationId, clientId: string): string {
  return `client:${conversationId}:${clientId}`;
}

export function agentMessageDedupeKey(sessionId: SessionId, uuid: string, toolUseId?: string): string {
  return toolUseId === undefined ? `session:${sessionId}:${uuid}` : `session:${sessionId}:${uuid}:${toolUseId}`;
}

export function systemMessageDedupeKey(conversationId: ConversationId, meta: SystemMessageMeta): string {
  const ref = ((): number | string => {
    switch (meta.event) {
      case "project.created":
        return meta.projectId;
      case "folder.attached":
      case "folder.detached":
        return meta.folderId;
      case "persona.changed":
        return meta.personaChangeId;
      case "handover.requested":
      case "session.renewed":
        return meta.sessionId;
      case "handover.failed":
        return meta.handoverId !== undefined ? `h${meta.handoverId}` : `${meta.messageId}.${meta.attempt}`;
      case "schedule.created":
      case "schedule.removed":
        return meta.scheduleId;
      case "schedule.run":
        return `${meta.scheduleId}:${meta.scheduledAt}`;
      case "schedule.failed":
        return meta.messageId;
      case "driver.warning":
      case "context.compacted":
        return `${meta.sessionId}:${meta.uuid}`;
      case "worker.max_time_exceeded":
        return `${meta.workerId}:${meta.maxTimeMs}`;
      case "task_graph.ready_to_finish":
        return `${meta.graphId}:${meta.seq}`;
      case "pm.wakeup":
        return meta.ref;
    }
  })();
  return `system:${conversationId}:${meta.event}:${ref}`;
}

export const SYSTEM_EVENTS = [
  "project.created",
  "folder.attached",
  "folder.detached",
  "persona.changed",
  "schedule.created",
  "schedule.removed",
  "schedule.run",
  "schedule.failed",
  "handover.requested",
  "session.renewed",
  "handover.failed",
  "context.compacted",
  "driver.warning",
  "worker.max_time_exceeded",
  "task_graph.ready_to_finish",
  "pm.wakeup",
] as const;

export type SystemMessageMeta =
  | { event: "driver.warning"; sessionId: SessionId; uuid: string }
  | { event: "project.created"; projectId: ProjectId }
  | { event: "folder.attached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "folder.detached"; projectId: ProjectId; folderId: ProjectFolderId; path: string }
  | { event: "persona.changed"; pmId: PmId; personaChangeId: PersonaChangeId; revertOf: PersonaChangeId | null }
  | { event: "handover.requested"; sessionId: SessionId; auto?: boolean }
  | { event: "session.renewed"; sessionId: SessionId; fromSessionId: SessionId; turnStartId?: MessageId; auto?: boolean; handoverId?: number }
  | { event: "handover.failed"; messageId?: MessageId; handoverId?: number; attempt: number; rawReason?: string }
  | { event: "schedule.created"; scheduleId: ScheduleId; name: string }
  | { event: "schedule.removed"; scheduleId: ScheduleId; name: string }
  | { event: "schedule.run"; scheduleId: ScheduleId; name: string; scheduledAt: number; catchUp: boolean }
  | { event: "schedule.failed"; scheduleId: ScheduleId; name: string; messageId: MessageId; rawReason?: string }
  | { event: "context.compacted"; sessionId: SessionId; uuid: string; trigger: string | null }
  | { event: "worker.max_time_exceeded"; workerId: WorkerId; workerConversationId: ConversationId; maxTimeMs: number; deadlineAt?: number }
  | { event: "task_graph.ready_to_finish"; graphId: TaskGraphId; seq: number; diffProbed?: boolean }
  | { event: "pm.wakeup"; source: PmWakeupSource; ref: string };

export const PM_WAKEUP_SOURCES = ["task_graph", "router", "app_approval"] as const;
export type PmWakeupSource = (typeof PM_WAKEUP_SOURCES)[number];

export interface GateRef {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  checkpoint?: true;
}

export const CONFIRM_PASS_OPTION = "通过";
export const CONFIRM_REJECT_OPTION = "打回";
export const CONFIRM_CHECKPOINT_OPTIONS = [CONFIRM_PASS_OPTION, CONFIRM_REJECT_OPTION] as const;

export type AskMeta = {
  needsUser: true;
  answered?: true;
  options?: string[];
  recommended?: string;
  gateRef?: GateRef;
  blockerRef?: BlockerRef;
  sandboxApprovalRef?: SandboxApprovalRef;
  appApprovalRef?: AppApprovalRef;
  chosenOption?: string;
  answerNote?: string;
  closed?: true;
  deliverables?: Deliverable[];
};

export interface BlockerRef {
  blockerId: UserBlockerId;
}

export function askOf(message: Pick<Message, "sender" | "meta">): AskMeta | null {
  if (message.sender !== "agent" || message.meta?.needsUser !== true) return null;
  const rawOptions = message.meta.options;
  const options =
    Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((o): o is string => typeof o === "string")
      ? rawOptions
      : undefined;
  const recommended =
    typeof message.meta.recommended === "string" && message.meta.recommended.trim() !== ""
      ? message.meta.recommended.trim()
      : undefined;
  const answered = message.meta.answered === true || message.meta.dismissed === true;
  const rawGateRef = message.meta.gateRef as Record<string, unknown> | null | undefined;
  const gateRef =
    rawGateRef !== null &&
    typeof rawGateRef === "object" &&
    typeof rawGateRef.graphId === "number" &&
    typeof rawGateRef.nodeKey === "string"
      ? {
          graphId: rawGateRef.graphId,
          nodeKey: rawGateRef.nodeKey,
          ...(rawGateRef.checkpoint === true ? { checkpoint: true as const } : {}),
        }
      : undefined;
  const rawBlockerRef = message.meta.blockerRef as Record<string, unknown> | null | undefined;
  const blockerRef =
    rawBlockerRef !== null && typeof rawBlockerRef === "object" && typeof rawBlockerRef.blockerId === "number"
      ? { blockerId: rawBlockerRef.blockerId }
      : undefined;
  const sandbox = message.meta.sandboxApprovalRef;
  const sandboxApprovalRef = sandbox !== null && typeof sandbox === "object" &&
    "approvalId" in sandbox && typeof sandbox.approvalId === "number" && "workerId" in sandbox && typeof sandbox.workerId === "number"
    ? { approvalId: sandbox.approvalId, workerId: sandbox.workerId }
    : undefined;
  const rawApp = message.meta.appApprovalRef;
  const appApprovalRef: AppApprovalRef | undefined =
    rawApp !== null && typeof rawApp === "object" &&
    "approvalId" in rawApp && typeof rawApp.approvalId === "number" &&
    "workerId" in rawApp && typeof rawApp.workerId === "number" &&
    "appId" in rawApp && typeof rawApp.appId === "string" &&
    "appName" in rawApp && typeof rawApp.appName === "string"
      ? {
          approvalId: rawApp.approvalId, workerId: rawApp.workerId, appId: rawApp.appId, appName: rawApp.appName,
          riskLevel: APP_APPROVAL_RISK_LEVELS.find((risk) => "riskLevel" in rawApp && risk === rawApp.riskLevel) ?? null,
          ...("workerTitle" in rawApp && typeof rawApp.workerTitle === "string" ? { workerTitle: rawApp.workerTitle } : {}),
          ...("warning" in rawApp && typeof rawApp.warning === "string" ? { warning: rawApp.warning } : {}),
          ...("expiresAt" in rawApp && typeof rawApp.expiresAt === "number" ? { expiresAt: rawApp.expiresAt } : {}),
        }
      : undefined;
  const chosenOption = typeof message.meta.chosenOption === "string" ? message.meta.chosenOption : undefined;
  const answerNote = typeof message.meta.answerNote === "string" && message.meta.answerNote !== "" ? message.meta.answerNote : undefined;
  const deliverables = deliverablesOf(message.meta.deliverables);
  return {
    needsUser: true,
    ...(answered ? { answered: true } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(recommended !== undefined ? { recommended } : {}),
    ...(gateRef !== undefined ? { gateRef } : {}),
    ...(blockerRef !== undefined ? { blockerRef } : {}),
    ...(sandboxApprovalRef !== undefined ? { sandboxApprovalRef } : {}),
    ...(appApprovalRef !== undefined ? { appApprovalRef } : {}),
    ...(chosenOption !== undefined ? { chosenOption } : {}),
    ...(answerNote !== undefined ? { answerNote } : {}),
    ...(message.meta.closed === true ? { closed: true } : {}),
    ...(deliverables.length > 0 ? { deliverables } : {}),
  };
}

export type AskOptionsValidation = { ok: true; options: string[] } | { ok: false; error: string };

export function validateAskOptions(raw: readonly string[]): AskOptionsValidation {
  if (raw.length < ASK_MIN_OPTIONS) {
    return { ok: false, error: `选项至少要给 ${ASK_MIN_OPTIONS} 个` };
  }
  if (raw.length > ASK_MAX_OPTIONS) {
    return { ok: false, error: `选项最多 ${ASK_MAX_OPTIONS} 个` };
  }
  const options: string[] = [];
  for (const item of raw) {
    const normalized = normalizeName(item, ASK_MAX_OPTION_CHARS);
    if (normalized === null) {
      return {
        ok: false,
        error: `选项不能为空、不能含换行或控制字符，且不超过 ${ASK_MAX_OPTION_CHARS} 个字符`,
      };
    }
    options.push(normalized);
  }
  return { ok: true, options };
}

const ASK_LIST_ITEM_RE = /^(?:(?:[-*]|\d+\.)\s+)?([A-Z](?:\.\s+|：|:\s).*)$/;

function stripSequentialLetterPrefixes(items: readonly string[]): string[] | null {
  const stripped: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const letter = String.fromCharCode(65 + i);
    const match = new RegExp(`^${letter}(?:\\.\\s+|：\\s*|: \\s*)(.+)$`).exec(items[i]!);
    const rest = match?.[1]?.trim();
    if (!rest) return null;
    stripped.push(rest);
  }
  return stripped;
}

function letteredOptionsOf(text: string): { question: string; options: string[] } | null {
  const lines = text.split(/\r?\n/);
  const firstListIdx = lines.findIndex((line) => ASK_LIST_ITEM_RE.test(line.trim()));
  if (firstListIdx <= 0) return null;

  let qEnd = firstListIdx;
  while (qEnd > 0 && lines[qEnd - 1]!.trim() === "") {
    qEnd--;
  }
  if (qEnd === 0) return null;
  const questionLines = lines.slice(0, qEnd);
  if (questionLines.some((line) => line.trim() === "")) return null;
  const question = questionLines.join("\n").trim();
  if (question === "") return null;

  const listLines = lines.slice(firstListIdx);
  if (listLines.length < ASK_MIN_OPTIONS || listLines.length > ASK_MAX_OPTIONS) return null;
  const rawItems: string[] = [];
  for (const line of listLines) {
    const match = ASK_LIST_ITEM_RE.exec(line.trim());
    const item = match?.[1]?.trim();
    if (!item || [...item].length > ASK_MAX_OPTION_CHARS) return null;
    rawItems.push(item);
  }
  const options = stripSequentialLetterPrefixes(rawItems);
  return options === null ? null : { question, options };
}

export interface ExtractedAskCard {
  question: string;
  options: string[];
  answered: boolean;
  recommended?: string;
  chosenOption?: string;
  answerNote?: string;
  closed?: true;
  gateRef?: GateRef;
}

export function extractAskCard(
  message: Pick<Message, "sender" | "meta" | "text">,
): ExtractedAskCard | null {
  const ask = askOf(message);
  if (ask === null || ask.blockerRef !== undefined || ask.sandboxApprovalRef !== undefined || ask.appApprovalRef !== undefined) return null;
  const answered = ask.answered === true;
  const extras = {
    ...(ask.recommended !== undefined ? { recommended: ask.recommended } : {}),
    ...(ask.chosenOption !== undefined ? { chosenOption: ask.chosenOption } : {}),
    ...(ask.answerNote !== undefined ? { answerNote: ask.answerNote } : {}),
    ...(ask.closed === true ? { closed: true as const } : {}),
    ...(ask.gateRef !== undefined ? { gateRef: ask.gateRef } : {}),
  };
  const trimmed = message.text.trim();
  if (ask.options !== undefined && ask.options.length >= ASK_MIN_OPTIONS) {
    return { question: trimmed, options: ask.options, answered, ...extras };
  }
  const lettered = letteredOptionsOf(trimmed) ?? { question: trimmed, options: [] };
  return { ...lettered, answered, ...extras };
}

export const SYSTEM_MESSAGE_PREFIX = "【系统】";

export function systemEventOf(message: Pick<Message, "sender" | "meta">): SystemMessageMeta | null {
  if (message.sender !== "system" || message.meta === null) return null;
  return isOneOf(SYSTEM_EVENTS, message.meta.event) ? (message.meta as SystemMessageMeta) : null;
}

export const SESSION_RENEWED_NOTICE = "Handed off to a new session";

export function systemNoticeText(message: Pick<Message, "sender" | "meta" | "text">): string {
  switch (systemEventOf(message)?.event) {
    case "handover.requested":
    case "session.renewed":
      return SESSION_RENEWED_NOTICE;
    default:
      return stripSystemPrefix(message.text);
  }
}

export function isHandoverTraffic(message: Pick<Message, "sender" | "meta">): boolean {
  if (message.sender === "agent") return message.meta?.handover === true;
  return systemEventOf(message)?.event === "handover.requested";
}

export function isSilentTriggerMessage(message: Pick<Message, "sender" | "meta">): boolean {
  const ev = systemEventOf(message)?.event;
  return ev === "worker.max_time_exceeded" || ev === "task_graph.ready_to_finish";
}

export function stripSystemPrefix(text: string): string {
  return text.startsWith(SYSTEM_MESSAGE_PREFIX) ? text.slice(SYSTEM_MESSAGE_PREFIX.length) : text;
}

export const WORKER_EVENTS = ["started", "report", "turn_failed", "worktree_failed", "ended", "user_message"] as const;
export type WorkerEvent = (typeof WORKER_EVENTS)[number];

export type WorkerLineStatus = WorkerReportStatus | "unformatted";

export type WorkerMessageMeta = {
  completedStep?: true;
  workerId: WorkerId;
  workerConversationId: ConversationId;
  title: string;
  readonly: boolean;
  event: WorkerEvent;
  status: WorkerLineStatus | null;
  summary: string | null;
  directChatSummary?: string;
  /** The PR field of a report line, when the report named one. */
  prUrl?: string;
  /** The Worker's git branch when running in a worktree. */
  branch?: string;
};

export function workerEventOf(message: Pick<Message, "kind" | "meta">): WorkerMessageMeta | null {
  if (message.kind !== WORKER_MESSAGE_KIND || message.meta === null) return null;
  return isOneOf(WORKER_EVENTS, message.meta.event) ? (message.meta as WorkerMessageMeta) : null;
}

export function workerMessageDedupeKey(workerId: WorkerId, event: Exclude<WorkerEvent, "user_message">, turnMessageId: MessageId | null): string {
  if (event === "report" || event === "turn_failed") {
    if (turnMessageId === null) throw new Error(`workerMessageDedupeKey: ${event} needs the turn's message id`);
    return `worker:${workerId}:${event}:${turnMessageId}`;
  }
  return `worker:${workerId}:${event}`;
}

export function normalizeName(raw: string, maxChars: number = MAX_NAME_CHARS): string | null {
  const name = raw.trim();
  if (name === "" || [...name].length > maxChars || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return null;
  return name;
}

export function normalizeWorkerTitle(raw: string): string | null {
  const title = raw.trim();
  if (title === "") return null;
  return normalizeName(truncateChars(title, MAX_WORKER_TITLE_CHARS), MAX_WORKER_TITLE_CHARS);
}

export function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
  status: string;
}

export interface RateLimitInfo {
  status: string;
  resetsAt: number | null;
  windows: Record<string, RateLimitWindow>;
}

export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  retryAt: number | null;
  errorStatus: number | null;
  error: string;
}

export type AgentStep =
  | { type: "thinking" }
  | { type: "text" }
  | { type: "tool_use"; name: string; input: AgentStepInput };

export interface AgentStepInput {
  skill?: string;
  server?: string;
  ServerName?: string;
  tool?: string;
  ToolName?: string;
  file_path?: string;
  notebook_path?: string;
  AbsolutePath?: string;
  TargetFile?: string;
  Path?: string;
  path?: string;
  CommandLine?: string;
  command?: string;
  query?: string;
  SearchPath?: string;
}

const RATE_LIMIT_REJECTED = "rejected";

export function isQuotaExhausted(info: RateLimitInfo | null | undefined, nowMs?: number): boolean {
  if (info?.status !== RATE_LIMIT_REJECTED) return false;
  return nowMs === undefined || info.resetsAt === null || info.resetsAt * 1000 > nowMs;
}

export function clearRateLimitRejection(info: RateLimitInfo): RateLimitInfo | null {
  const windows: Record<string, RateLimitWindow> = {};
  for (const [k, w] of Object.entries(info.windows)) {
    if (w) windows[k] = w.status === RATE_LIMIT_REJECTED ? { ...w, status: "allowed" } : w;
  }
  if (Object.keys(windows).length === 0) return null;
  return { ...info, status: "allowed", windows };
}

export function exhaustRateLimitInfo(info: RateLimitInfo | null | undefined): RateLimitInfo {
  if (!info) return { status: RATE_LIMIT_REJECTED, resetsAt: null, windows: {} };
  const windows: Record<string, RateLimitWindow> = {};
  for (const [k, w] of Object.entries(info.windows)) {
    if (w && Number.isFinite(w.utilization)) windows[k] = { ...w };
  }
  const entries = Object.entries(windows);
  if (entries.length === 0) {
    return { status: RATE_LIMIT_REJECTED, resetsAt: info.resetsAt, windows: {} };
  }
  const alreadyExhausted = entries.filter(([, w]) => w.status === RATE_LIMIT_REJECTED || w.utilization >= 1);
  if (alreadyExhausted.length > 0) {
    for (const [k, w] of alreadyExhausted) {
      windows[k] = { ...w, utilization: Math.max(1, w.utilization), status: RATE_LIMIT_REJECTED };
    }
  } else {
    let bestKey = entries[0]![0];
    let bestWin = entries[0]![1];
    for (const [k, w] of entries.slice(1)) {
      if (w.utilization > bestWin.utilization || (w.utilization === bestWin.utilization && w.resetsAt < bestWin.resetsAt)) {
        bestKey = k;
        bestWin = w;
      }
    }
    windows[bestKey] = { ...bestWin, utilization: 1, status: RATE_LIMIT_REJECTED };
  }
  const rejected = Object.values(windows).filter((w) => w.status === RATE_LIMIT_REJECTED);
  return {
    status: RATE_LIMIT_REJECTED,
    resetsAt: rejected.length > 0 ? Math.max(...rejected.map((w) => w.resetsAt)) : info.resetsAt,
    windows,
  };
}

export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  context: number;
}

export const EMPTY_TOKEN_USAGE: Readonly<TokenUsage> = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 };

export interface AgentSessionRow {
  id: SessionId;
  role: AgentRole;
  conversationId: ConversationId | null;
  pmId: PmId | null;
  workerId: WorkerId | null;
  vendor: string;
  vendorSessionId: string;
  cwd: string;
  addDirs: string[];
  generation: number;
  model: string | null;
  effort: string | null;
  pid: number | null;
  status: SessionStatus;
  hasCompletedTurn: boolean;
  lastEventAt: number | null;
  rateLimit: RateLimitInfo | null;
  usage: TokenUsage;
  personaRevision?: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionActivity = "idle" | "working" | "stopping" | "preparing" | "background";

export interface SessionState {
  sessionId: SessionId;
  conversationId: ConversationId | null;
  pmId: PmId | null;
  generation: number;
  status: SessionStatus;
  activity: SessionActivity;
  currentTool: string | null;
  rateLimit: RateLimitInfo | null;
  apiRetry?: ApiRetryInfo | null;
  usage?: TokenUsage;
  vendor?: string;
  model?: string | null;
  effort?: string | null;
  step?: AgentStep | null;
  /** Epoch ms when the shown step started; null while the shown tool is only proposed. Never derived from lastEventAt. */
  stepStartedAt?: number | null;
  streamingText?: string | null;
  lastEventAt: number | null;
}

export const HEALTH_MODULES = ["store", "actions", "driver", "ui-server", "agent-api"] as const;
export type HealthModule = (typeof HEALTH_MODULES)[number];

export interface HealthEntry {
  module: HealthModule;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: number;
}

export const TASK_GRAPH_STATUSES = ["active", "completed", "cancelled"] as const;
export type TaskGraphStatus = (typeof TASK_GRAPH_STATUSES)[number];

export const TASK_NODE_STATUSES = ["pending", "running", "waiting", "done", "cancelled"] as const;
export type TaskNodeStatus = (typeof TASK_NODE_STATUSES)[number];

export const TASK_NODE_WAITING_FOR = ["user", "pm"] as const;
export type TaskNodeWaitingFor = (typeof TASK_NODE_WAITING_FOR)[number];

export interface TaskNodeState {
  status: TaskNodeStatus;
  waitingFor: TaskNodeWaitingFor | null;
  skipped: boolean;
}

export function taskNodeStateFromLegacy(status: string): TaskNodeState {
  switch (status) {
    case "pending":
      return { status: "pending", waitingFor: null, skipped: false };
    case "running":
      return { status: "running", waitingFor: null, skipped: false };
    case "done":
      return { status: "done", waitingFor: null, skipped: false };
    case "skipped":
      return { status: "done", waitingFor: null, skipped: true };
    case "waiting_user":
      return { status: "waiting", waitingFor: "user", skipped: false };
    default:
      return { status: "waiting", waitingFor: "pm", skipped: false };
  }
}

export function taskNodeStatusText(
  node: Pick<TaskNode, "status" | "waitingFor" | "skipped" | "userBlocker" | "sandboxApproval">,
  viewer: "pm" | "user",
): string {
  switch (node.status) {
    case "pending":
      return "没轮到";
    case "running":
      return "在干";
    case "waiting":
      if (node.sandboxApproval != null) return viewer === "user" ? "等你确认 Worker 沙箱" : "等用户确认 Worker 沙箱";
      if (isTaskNodeUserBlocked(node)) return viewer === "user" ? "等你动手" : "等用户动手";
      if (node.waitingFor === "user") return viewer === "user" ? "等你拍板" : "等用户拍板";
      return viewer === "user" ? "等项目经理" : "等你处理";
    case "done":
      return node.skipped ? "跳过" : "完了";
    case "cancelled":
      return "已取消";
  }
}

export function isTaskNodeWaitingUser(node: Pick<TaskNode, "status" | "waitingFor">): boolean {
  return node.status === "waiting" && node.waitingFor === "user";
}

export function isTaskNodeUserBlocked(node: Pick<TaskNode, "status" | "waitingFor" | "userBlocker">): boolean {
  return isTaskNodeWaitingUser(node) && node.userBlocker != null;
}

export function isTaskNodeWaitingDecision(node: Pick<TaskNode, "status" | "waitingFor" | "userBlocker" | "gateAskPending" | "sandboxApproval">): boolean {
  return node.sandboxApproval == null && (node.gateAskPending ?? (isTaskNodeWaitingUser(node) && node.userBlocker == null));
}

export function isTaskNodeAwaitingUserAction(node: Parameters<typeof isTaskNodeWaitingDecision>[0]): boolean {
  return node.sandboxApproval !== undefined || isTaskNodeWaitingDecision(node) || isTaskNodeUserBlocked(node);
}

export function isTaskNodeWaitingPm(node: Pick<TaskNode, "status" | "waitingFor">): boolean {
  return node.status === "waiting" && node.waitingFor === "pm";
}

export interface TaskArtifact {
  prUrl?: string;
  commit?: string;
  branch?: string;
  summary?: string;
  deliverables?: Deliverable[];
  reviewVerdict?: StoredReviewVerdict;
  verifiedCommit?: string;
}

export interface TaskDecision {
  choice: string | null;
  note: string | null;
  decidedBy: "user" | "pm";
  decidedAt: number;
  clientId?: string;
}

export interface TaskEdge {
  fromKey: TaskNodeKey;
  toKey: TaskNodeKey;
}

export interface TaskNode {
  key: TaskNodeKey;
  title: string;
  brief?: string | null;
  vendor?: string | null;
  model?: string | null;
  effort?: string | null;
  readonly?: boolean;
  maxTimeMs?: number | null;
  confirm?: boolean;
  review?: boolean;
  base?: string | null;
  /** Name of the resource on this computer the step queues for; null or absent when it needs none. */
  slot?: string | null;
  /** Present while the step waits for its slot: first-in, first-out position and the current holder. */
  slotQueue?: { position: number; holder: { graphId: TaskGraphId; nodeKey: TaskNodeKey; workerId: WorkerId | null } };
  status: TaskNodeStatus;
  waitingFor: TaskNodeWaitingFor | null;
  skipped: boolean;
  sortOrder: number;
  activeWorkerId: WorkerId | null;
  workerIds: WorkerId[];
  artifact: TaskArtifact | null;
  gateQuestion: string | null;
  gateOptions: string[];
  gateSummaryMd: string | null;
  gateRecommended: string | null;
  gateAskMessageId: MessageId | null;
  gateAskPending?: boolean;
  gateCheckpoint?: boolean;
  userBlocker?: UserBlocker | null;
  sandboxApproval?: { id: SandboxApprovalId; text: string };
  decision: TaskDecision | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskGraph {
  id: TaskGraphId;
  projectId: ProjectId;
  pmId: PmId;
  conversationId: ConversationId;
  title: string;
  goal?: string | null;
  status: TaskGraphStatus;
  originMsgId: MessageId | null;
  nodes: TaskNode[];
  edges: TaskEdge[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export function isTaskGraphReadyToFinish(graph: Pick<TaskGraph, "status" | "nodes">): boolean {
  return graph.status === "active" && graph.nodes.length > 0 && graph.nodes.every((n) => n.status === "done");
}

export interface PmMemoryFileSummary {
  name: string;
  bytes: number;
  updatedAt: number;
}

export interface PmMemoryFileDetail extends PmMemoryFileSummary {
  content: string;
}

export interface PmMemoryFilesList {
  files: PmMemoryFileSummary[];
  totalBytes: number;
}

export function pmMemoryLineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function checkPmMemoryFileName(raw: string): string | null {
  if (raw.trim() === "") return "Enter a file name ending in .md";
  if (raw !== raw.trim()) return "File name can't start or end with spaces";
  if ([...raw].length > MAX_PM_MEMORY_FILE_NAME_CHARS) {
    return `File name must be ${MAX_PM_MEMORY_FILE_NAME_CHARS} characters or fewer`;
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\:]/.test(raw)) {
    return "Use a flat file name without slashes or control characters";
  }
  if (raw.includes("..")) return "File name can't contain ..";
  if (raw.startsWith(".")) return "File name can't start with a dot";
  if (!raw.endsWith(".md") || raw.length <= 3) return "File name must end in .md";
  if (raw.toLowerCase() === PM_MEMORY_INDEX_FILE.toLowerCase()) {
    return `${PM_MEMORY_INDEX_FILE} is managed in Persona above`;
  }
  return null;
}
