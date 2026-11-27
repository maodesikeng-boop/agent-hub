import type { AgendaFooter } from "./pm-agenda.ts";
import type { ComposerCommand } from "./api.ts";
import type { ChecklistUpdate } from "./checklist.ts";
import type { AgentSessionRow, AgentStep, ApiRetryInfo, MessageId, RateLimitInfo, SessionId, Unsubscribe } from "./domain.ts";
import type { SessionCapabilities } from "./pm-capabilities.ts";
import type { ReadonlyPolicy } from "./readonly-policy.ts";
import type { WorkerOuterSandboxMode } from "./sandbox-approval.ts";
import type { AppApprovalGate } from "./app-approval.ts";
import type { SessionStore } from "./store.ts";
import type { WriteScope } from "./write-scope.ts";
import { HUB_COMMAND } from "./names.ts";
import { VENDOR_NOT_FOUND_CODES } from "./vendors.ts";

export type { AgentStep } from "./domain.ts";

export type MessageSource = "user" | "system";

export interface DriverSendInput {
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  prefixes?: string[];
  resend?: boolean;
  recovery?: boolean;
  /**
   * A rider never starts a turn on its own: the driver writes it into the running turn when it can steer now,
   * otherwise keeps it queued until the next batch the session sends, which then carries it ahead of its own text.
   */
  rider?: true;
}

export type DriverSendResult = { kind: "written"; midTurn?: true } | { kind: "queued" } | { kind: "cancelled" } | { kind: "rejected" };

export const RESTART_RECOVERY_NOTE = "【系统】守护进程重启，你上一轮被打断了。请先看一下工作区现在的状态，再接着做。";
export const RESEND_NOTE = "【系统】下面这条消息之前可能已经发给过你。如果你已经处理过这条，忽略它。";
// Never point at the system prompt: claude --resume keeps the original one, which may list stale projects.
export const RELAUNCH_NOTE = `【系统】你的设置（文件夹、管着的项目、模型或思考程度）刚更新过，已经按新设置重新启动。系统提示词里的项目和文件夹可能是旧的，最新的以 \`${HUB_COMMAND} status\`、\`${HUB_COMMAND} persona show\` 为准。`;
export const CAPABILITY_RELAUNCH_NOTE = "【系统】可用的 Skill 或 MCP 有更新，会话已按最新能力设置续接。";
const KILLED_NOTE_MAX_TASKS = 5;
const KILLED_NOTE_MAX_DESC_CHARS = 80;
export function backgroundTasksKilledNote(reason: "relaunch" | "hold_max" | "stopped", descriptions: string[]): string {
  const shown = descriptions
    .slice(0, KILLED_NOTE_MAX_TASKS)
    .map((d) => (d.length > KILLED_NOTE_MAX_DESC_CHARS ? `${d.slice(0, KILLED_NOTE_MAX_DESC_CHARS)}…` : d) || "（没有描述）");
  const more = descriptions.length - shown.length;
  const list = `${shown.join("；")}${more > 0 ? `；等共 ${descriptions.length} 个` : ""}`;
  const why = reason === "relaunch" ? "为了让新设置生效重启了" : reason === "stopped" ? "用户点了停止" : "后台任务太久没结束，进程被关闭了";
  return `【系统】${why}，正在跑的 ${descriptions.length} 个后台任务（${list}）被结束了，需要的话重新启动。`;
}
export const CRASH_RECOVERY_NOTE = "【系统】你的进程上一轮意外退出了，那一轮可能没做完。请先看一下工作区现在的状态，再接着做。";

interface DriverEventBase {
  uuid?: string;
  at: number;
}

interface CommandsChangedEvent extends DriverEventBase {
  type: "commands.changed";
  commands: ComposerCommand[];
}

export interface BackgroundTaskInfo {
  id: string;
  label: string;
  startedAt: number;
}

export interface BackgroundChangedEvent extends DriverEventBase {
  type: "background.changed";
  count: number;
  tasks?: readonly BackgroundTaskInfo[];
}

interface ContextCompactedEvent extends DriverEventBase {
  type: "context.compacted";
  uuid: string;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
}

export interface SessionStartedEvent extends DriverEventBase {
  type: "session.started";
  resumed: boolean;
  model: string | null;
  tools: string[];
}

export type WrittenAgendaFooter = Extract<AgendaFooter, { kind: "snapshot" | "delta" }>;

export interface DeliverySuffix {
  text: string;
  agenda?: WrittenAgendaFooter;
}

interface MessageDeliveredEvent extends DriverEventBase {
  type: "message.delivered";
  messageIds: MessageId[];
  agenda?: { messageId: MessageId; footer: WrittenAgendaFooter };
  midTurn?: true;
}

interface MessageProcessingEvent extends DriverEventBase {
  type: "message.processing";
  messageIds: MessageId[];
  midTurn?: true;
  preamble?: true;
}

interface MessageCancelledEvent extends DriverEventBase {
  type: "message.cancelled";
  messageIds: MessageId[];
  reason: "stop";
}

interface MessageRequeuedEvent extends DriverEventBase {
  type: "message.requeued";
  messageIds: MessageId[];
}

interface TurnStartedEvent extends DriverEventBase {
  type: "turn.started";
}

interface SubtaskField {
  parentToolUseId?: string;
}

export interface AgentTextEvent extends DriverEventBase, SubtaskField {
  type: "agent.text";
  uuid: string;
  text: string;
}

export interface AgentTextDeltaEvent extends DriverEventBase, SubtaskField {
  type: "agent.text_delta";
  delta: string;
  reset?: boolean;
  startedAt?: number;
}

export interface AgentThinkingEvent extends DriverEventBase, SubtaskField {
  type: "agent.thinking";
  uuid: string;
}

export interface AgentToolResultEvent extends DriverEventBase, SubtaskField {
  type: "agent.tool_result";
  toolUseIds: string[];
  outputs?: Readonly<Record<string, string>>;
}

export interface AgentToolEvent extends DriverEventBase, SubtaskField {
  type: "agent.tool";
  uuid: string;
  /** Invocation ID, unique within the session and shared by start and result events. */
  toolUseId: string;
  name: string;
  input: unknown;
  /** Set when the vendor reports the call only as proposed; agent.tool_running later marks when it starts executing. */
  pending?: true;
  /** Vendor-reported start time in epoch ms; absent means the call started when the event was received (`at`). */
  startedAt?: number;
}

export interface AgentToolRunningEvent extends DriverEventBase, SubtaskField {
  type: "agent.tool_running";
  toolUseId: string;
  startedAt?: number;
}

/** Carries the vendor's own checklist change; the ledger applies it to the session's last stored snapshot. */
export interface AgentChecklistEvent extends DriverEventBase, SubtaskField {
  type: "agent.checklist";
  uuid: string;
  update: ChecklistUpdate;
}

export interface AgentToolPreviewEvent extends DriverEventBase, SubtaskField {
  type: "agent.tool_preview";
  toolUseId?: string;
  name: string;
  input?: unknown;
}

interface TurnEndedEvent extends DriverEventBase {
  type: "turn.ended";
  ok: boolean;
  interrupted: boolean;
  shutdown?: true;
  messageIds: MessageId[];
  durationMs: number | null;
  error?: { subtype: string; message: string };
}

interface RateLimitEvent extends DriverEventBase {
  type: "rate_limit";
  info: RateLimitInfo;
}

interface ApiRetryEvent extends DriverEventBase {
  type: "api_retry";
  info: ApiRetryInfo;
}

export function turnFailureReason(error: { subtype: string; message: string }): string {
  return error.subtype === "success" ? error.message : `${error.subtype}: ${error.message}`;
}

const SESSION_EXIT_REASONS = ["idle", "interrupt", "shutdown", "crash", "startup_failed"] as const;
export type SessionExitReason = (typeof SESSION_EXIT_REASONS)[number];

export interface SessionExitedEvent extends DriverEventBase {
  type: "session.exited";
  reason: SessionExitReason;
  exitCode: number | null;
  signal: string | null;
  hadResult: boolean;
  messageIds: MessageId[];
}

export const DRIVER_ERROR_CODES = [
  "start_timeout",
  ...VENDOR_NOT_FOUND_CODES,
  "spawn_failed",
  "invalid_input",
  "bad_output_line",
  "start_args_conflict",
  "internal_error",
  "session_ended",
] as const;
export type DriverErrorCode = (typeof DRIVER_ERROR_CODES)[number];

export const RETRYABLE_DRIVER_ERRORS: readonly DriverErrorCode[] = [
  "start_timeout",
  ...VENDOR_NOT_FOUND_CODES,
  "spawn_failed",
  "start_args_conflict",
];

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly retryable: boolean;
  constructor(code: DriverErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DriverError";
    this.code = code;
    this.retryable = RETRYABLE_DRIVER_ERRORS.includes(code);
  }
}

export class DriverSessionError extends DriverError {
  readonly reason: string;
  readonly sessionId: SessionId;
  constructor(reason: string, sessionId: SessionId) {
    super("internal_error", `${reason}: session ${sessionId}`);
    this.name = "DriverSessionError";
    this.reason = reason;
    this.sessionId = sessionId;
  }
}

interface DriverErrorEvent extends DriverEventBase {
  type: "driver.error";
  code: DriverErrorCode;
  message: string;
  messageIds?: MessageId[];
}

export type DriverEvent =
  | (DriverEventBase & { type: "driver.warning"; uuid: string; message: string })
  | SessionStartedEvent
  | MessageDeliveredEvent
  | MessageProcessingEvent
  | MessageCancelledEvent
  | MessageRequeuedEvent
  | TurnStartedEvent
  | AgentTextEvent
  | AgentTextDeltaEvent
  | AgentThinkingEvent
  | AgentToolEvent
  | AgentToolRunningEvent
  | AgentChecklistEvent
  | AgentToolPreviewEvent
  | AgentToolResultEvent
  | TurnEndedEvent
  | RateLimitEvent
  | ApiRetryEvent
  | SessionExitedEvent
  | DriverErrorEvent
  | CommandsChangedEvent
  | BackgroundChangedEvent
  | ContextCompactedEvent;

export type DriverEventListener = (sessionId: SessionId, event: DriverEvent) => void;

export interface Driver {
  start(sessionId: SessionId): Promise<void>;
  send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult>;
  interrupt(sessionId: SessionId): Promise<void>;
  // end() marks the session ending synchronously before its first await, so later start/send throw session_ended.
  end(sessionId: SessionId): Promise<void>;
  shutdown(): Promise<void>;
  cleanupStale(): Promise<void>;
  queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null>;
  isRunning?(sessionId: SessionId): boolean;
  /** True while the driver has an active turn or an in-progress startup or delivery for the session. */
  isBusy?(sessionId: SessionId): boolean;
  /** Synchronously marks the session ending so queued follow-up batches are dropped before session.end runs. */
  markEnding?(sessionId: SessionId): void;
  onEvent(listener: DriverEventListener): Unsubscribe;
}

interface LaunchFilesBase {
  promptFile: string;
  settingsFile?: string;
  skillsDir?: string;
  env: Record<string, string>;
  /** If capabilityCheck is set, this fingerprint excludes capability-dependent options. */
  fingerprint: string;
  backgroundHoldMaxMs?: number;
  writeScope?: WriteScope;
  outerSandbox?: WorkerOuterSandboxMode;
  capabilities?: SessionCapabilities;
  capabilityCheck?: LaunchCapabilityCheck;
  personaRevision?: number;
  ownerTag?: string;
}

export interface LaunchCapabilityCheck {
  fingerprint: string | undefined;
  currentFingerprint: () => Promise<string | undefined>;
}

// Read-only sandboxes deny every write outside the session temp dir, so a read-only launch cannot exist without one.
export type LaunchFiles = LaunchFilesBase &
  ({ readonly?: undefined; tmpDir?: string } | { readonly: ReadonlyPolicy; tmpDir: string });

export interface PersonaNote {
  revision: number;
  note: string | null;
}

export interface SessionPreambleOptions {
  /** UTF-8 bytes already committed to the turn outside the preamble (triggering message, system prompt, other prefixes, delivery suffix). */
  readonly reservedBytes?: number;
}

export interface DriverOptions {
  executablePath: string | (() => string);
  store: SessionStore;
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  personaNote?: (sessionId: SessionId, sinceRevision: number) => PersonaNote | null;
  sessionPreamble?: (sessionId: SessionId, options?: SessionPreambleOptions) => string | null;
  /** `preamble` is the opening brief carried by the same input, if any. */
  deliverySuffix?: (sessionId: SessionId, messageIds: readonly MessageId[], preamble?: string) => DeliverySuffix;
  canDeliverSystemMessage?: (sessionId: SessionId, messageId: MessageId) => boolean;
  /** Called when a session finishes an in-progress startup, delivery, or turn and becomes idle in the driver. */
  onSessionQuiescent?: (sessionId: SessionId) => void;
  /** Receives vendor app-permission requests from processes launched with outerSandbox "vendor_only"; absent means decline. */
  appApprovals?: AppApprovalGate;
  env?: Record<string, string> | (() => Record<string, string>);
  pmMemoryDir?: string;
  log?: (line: string) => void;
  idleCloseMs?: number;
  backgroundHoldMaxMs?: number;
  interruptGraceMs?: number;
  commandsTimeoutMs?: number;
  startTimeoutMs?: number;
  shutdownGraceMs?: number;
}
