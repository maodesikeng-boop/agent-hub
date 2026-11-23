import type {
  ArchiveAllReportsResponse,
  RecheckUserBlockerResponse,
  CancelTaskGraphRequest,
  CancelTaskGraphResponse,
  Change,
  ConversationsLookup,
  DecideTaskNodeRequest,
  DecideTaskNodeResponse,
  EndedWorkersPage,
  LedgerSnapshot,
  MessagesPage,
  ResolveRouterItemRequest,
  ResolveRouterItemResponse,
  RouterItemsPage,
  SkipTaskNodeRequest,
  SkipTaskNodeResponse,
  TaskGraphsPage,
  UpdateRouterSettingsRequest,
} from "./api.ts";
import type { Attachment } from "./attachments.ts";
import type { FeishuMessageOrigin } from "./feishu.ts";
import type { DriverEvent } from "./driver.ts";
import type { AnyActionRow, ReviewVerifyParams } from "./actions.ts";
import type {
  AgentRole,
  Conversation,
  ConversationId,
  HealthModule,
  Message,
  MessageId,
  PersonaChange,
  PersonaChangeId,
  Pm,
  PmId,
  PmMemoryFileDetail,
  PmMemoryFilesList,
  PmMode,
  Project,
  ProjectId,
  RouterItemId,
  SessionId,
  TaskGraphId,
  TaskNodeKey,
  WorkerRecord,
  WorkerId,
  WorkerStatus,
  Unsubscribe,
} from "./domain.ts";
import type { DeviceRouterDigest, RouterSettings } from "./router.ts";
import type { HandoverId, LedgerHandoverWork } from "./handover.ts";
import type { HubArgs, HubCommand, HubResult, ProjectCard, WorkerPr, WorkerPrProbeResult } from "./hub.ts";
import type { CapabilitiesPatch, CapabilityPolicy, CapabilityScope, PmCapabilitiesStart, ScopeCapabilities, WorkerCapabilities } from "./pm-capabilities.ts";
import type { PmLookSetting, SlimeLook } from "./slimes.ts";
import type { ReviewSnapshot, ReviewVerifyResult } from "./review.ts";
import type { SelfReloadStatus } from "./api.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import { API_ERRORS } from "./errors.ts";
import type { AgentVendor, ModelCatalog } from "./vendors.ts";
import type { UserBlockerId } from "./user-blockers.ts";
import type { WorkerPick } from "./worker.ts";
import type { TurnReplyView } from "./turn-reply.ts";
import type { HubFileArg } from "./deliverables.ts";
import type { SentFile } from "./sent-files.ts";

export const LEDGER_ERROR_CODES = ["invalid", "not_found", "forbidden", "conflict", "git_failed"] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

export const LEDGER_ERROR_HTTP_STATUS: Readonly<Record<LedgerErrorCode, number>> = {
  invalid: API_ERRORS.invalid.status,
  not_found: API_ERRORS.not_found.status,
  forbidden: API_ERRORS.forbidden.status,
  conflict: API_ERRORS.conflict.status,
  git_failed: API_ERRORS.git_failed.status,
};

export class LedgerRequestError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerRequestError";
    this.code = code;
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found";
  readonly conversationId: ConversationId;
  constructor(conversationId: ConversationId) {
    super(`conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

export interface ComposerTarget {
  sessionId: SessionId;
  vendor: string;
  cwd: string;
  addDirs: string[];
  fileRoots: string[];
}

export interface PostUserMessageInput {
  conversationId: ConversationId;
  clientId: string;
  text: string;
  attachments?: Attachment[];
  workerPick?: WorkerPick;
  origin?: FeishuMessageOrigin;
}

export interface PostUserMessageResult {
  messageId: MessageId;
}

export type ChangesSince = { kind: "ok"; changes: Change[] } | { kind: "resync" };

export type LedgerActor = { kind: "user" } | { kind: "session"; sessionId: SessionId };

export interface CreatePmInput {
  name: string;
  mode: PmMode;
  vendor?: AgentVendor;
  defaultModel?: string | null;
  effort?: string | null;
  persona: string;
  folder?: string;
  capabilities?: PmCapabilitiesStart;
  look?: SlimeLook;
}

export interface CreatePmResult {
  pm: Pm;
  conversation: Conversation;
  sessionId: SessionId;
  project: Project | null;
}

export type ResolveFolder = (path: string) => string;

export interface PersonaView {
  pmId: PmId;
  text: string;
  mode: PmMode;
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
  switchingToVendor?: AgentVendor | null;
  changes: PersonaChange[];
  revertableChangeId: PersonaChangeId | null;
}

export interface EditPersonaInput {
  text?: string;
  mode?: PmMode;
  vendor?: AgentVendor;
  model?: string | null;
  effort?: string | null;
  reason?: string;
}

export interface EditPersonaResult {
  change: PersonaChange | null;
  persona: PersonaView;
}

export interface SyncPersonaFilesResult {
  recordedPmIds: PmId[];
  rewrittenPmIds: PmId[];
}

export interface LaunchContext {
  sessionId: SessionId;
  role: AgentRole;
  conversationId: ConversationId;
  pm: { id: PmId; name: string; mode: PmMode; vendor?: AgentVendor; persona: string; personaRevision?: number };
  project: ProjectCard | null;
  worker: WorkerRecord | null;
  workerCapabilities?: WorkerCapabilities;
  vendor?: AgentVendor;
}

export interface PersonaUpdate {
  revision: number;
  vendor: AgentVendor;
  persona: { text: string; bySelf: boolean } | null;
  mode: { mode: PmMode; bySelf: boolean } | null;
}

export interface WorktreeTask {
  workerId: WorkerId;
  sessionId: SessionId;
  repo: string;
  worktreePath: string;
  checkout: { kind: "branch"; branch: string; base?: string } | { kind: "review"; branch: string };
  status: WorkerStatus;
  setupCommand: string | null;
}

export interface SetupOutcome {
  kind: "ok" | "failed" | "timeout" | "stopped";
  command: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  timeoutMs: number;
  durationMs: number;
  tail: string;
  logPath: string;
  logError: string | null;
}

export type WorkspaceProbe =
  | { kind: "ok"; isRepoWithCommit: boolean; hasUncommittedChanges: boolean }
  | { kind: "failed"; error: string };

export interface HubCallContext {
  workspace?: WorkspaceProbe;
  pr?: WorkerPrProbeResult;
  prError?: string | null;
  transcript?: string | null;
  modelCatalogs?: readonly ModelCatalog[];
  graphPrs?: Readonly<Record<string, WorkerPr>>;
  selfReload?: SelfReloadStatus;
  sharedFiles?: readonly SentFile[];
}

export type GraphPrTarget = { cwd: string; branch: string } | { cwd: string; prUrl: string };

export interface Ledger extends LedgerHandoverWork {
  postUserMessage(input: PostUserMessageInput): PostUserMessageResult;
  composerTarget(conversationId: ConversationId): ComposerTarget;
  requestStop(conversationId: ConversationId): void;
  rewindLastUserMessage(conversationId: ConversationId): Message | null;
  snapshot(): LedgerSnapshot;
  messagesAfter(conversationId: ConversationId, after: MessageId, limit: number): Message[];
  messagesBefore(conversationId: ConversationId, before: MessageId): MessagesPage;
  lookupConversations(query: { ids: readonly ConversationId[]; workerIds: readonly WorkerId[] }): ConversationsLookup;
  endedWorkersPage(pmId: PmId, before: ConversationId | null): EndedWorkersPage;
  changesSince(seq: number): ChangesSince;
  onChange(listener: (change: Change) => void): Unsubscribe;

  getPersona(pmId: PmId): PersonaView;
  listPmMemoryFiles(pmId: PmId): PmMemoryFilesList;
  getPmMemoryFile(pmId: PmId, name: string): PmMemoryFileDetail;
  putPmMemoryFile(pmId: PmId, name: string, content: string): { file: PmMemoryFileDetail; totalBytes: number };
  deletePmMemoryFile(pmId: PmId, name: string): void;
  getPmCapabilityPolicy(pmId: PmId): CapabilityPolicy;
  getRouterCapabilityPolicy(): CapabilityPolicy;
  getCapabilities(scope: CapabilityScope): ScopeCapabilities;
  patchCapabilities(scope: CapabilityScope, patch: CapabilitiesPatch): ScopeCapabilities;
  resetPmCapabilities(pmId: PmId): ScopeCapabilities;
  customizedCapabilityPms(): PmId[];
  setProjectSetupCommand(projectId: ProjectId, command: string | null): Project;
  setPmLook(pmId: PmId, look: PmLookSetting): Pm;
  pmProjectMainFolder(pmId: PmId): string | null;
  editPersona(pmId: PmId, input: EditPersonaInput, actor: LedgerActor): EditPersonaResult;
  revertPersonaChange(changeId: PersonaChangeId): EditPersonaResult;
  retryMessage(messageId: MessageId): { messageId: MessageId };
  renewSession(pmId: PmId): { handoverId: HandoverId };
  runAutoRenew(): void;
  sessionPreamble(sessionId: SessionId): string | null;
  waitsForHandover(messageId: MessageId): boolean;

  hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>, context?: HubCallContext): HubResult<C>;
  sessionRole(sessionId: SessionId): AgentRole | null;
  workerStartFolder(sessionId: SessionId): string | null;
  workerPrTarget(sessionId: SessionId, workerId: WorkerId): { cwd: string; branch: string } | null;
  workerTranscriptTarget(sessionId: SessionId, workerId: WorkerId): { vendor: string; vendorSessionId: string; cwd: string } | null;
  graphPrTargets?(sessionId: SessionId, graphId?: TaskGraphId): GraphPrTarget[];
  graphAutoDispatchVendors?(sessionId: SessionId, command: HubCommand, body: Record<string, unknown>): AgentVendor[];
  graphDeliveryProbeTarget?(messageId: MessageId): {
    graphId: TaskGraphId;
    repoFolder: string | null;
    branches: Array<{ branch: string; cwd: string; baseCommit: string | null }>;
  } | null;
  enrichDeliveryNoteMessage?(
    messageId: MessageId,
    input: {
      files?: ReadonlyArray<{ file: string; added: number | null; deleted: number | null }>;
      prs?: Readonly<Record<string, WorkerPr>>;
    },
  ): void;
  getLaunchContext(sessionId: SessionId): LaunchContext;
  personaUpdate(sessionId: SessionId, sinceRevision: number): PersonaUpdate | null;

  getWorktreeTask(workerId: WorkerId): WorktreeTask | null;
  onSetupStarted(workerId: WorkerId): boolean;
  waitsForTurnCompletion(sessionId: SessionId): boolean;
  waitsForFirstTurn(sessionId: SessionId, messageId: MessageId): boolean;
  onWorktreeCreated(workerId: WorkerId, baseCommit: string, setup?: SetupOutcome): void;
  recordReviewSnapshot(workerId: WorkerId, snapshot: ReviewSnapshot): void;

  getReviewVerifyTask(workerId: WorkerId): { repo: string; branch: string; snapshot: ReviewSnapshot } | null;
  onReviewVerified(params: ReviewVerifyParams, result: ReviewVerifyResult): void;

  syncPersonaFiles(): SyncPersonaFilesResult;
  onStopRequested(listener: (event: { conversationId: ConversationId; sessionId: SessionId }) => void): Unsubscribe;
  onActionEnqueued(listener: (action: AnyActionRow) => void): Unsubscribe;
  applyDriverEvent(sessionId: SessionId, event: DriverEvent): void;
  settleDriverEvents(): Promise<void>;
  refreshSessionState(sessionId: SessionId): void;
  turnsLostOnShutdown(): Array<{ sessionId: SessionId; role: AgentRole }>;
  recoverAfterRestart(): { resentMessageIds: MessageId[]; requeuedMessageIds: MessageId[]; recoveredSessionIds: SessionId[] };
  createPm(input: CreatePmInput): CreatePmResult;
  archivePm(pmId: PmId): Pm;
  unarchivePm(pmId: PmId): Pm;
  purgeExpiredArchivedPms(nowMs?: number): PmId[];
  runDueSchedules(nowMs: number): void;
  addSchedule(pmId: PmId, args: HubArgs<"schedule.add">): ScheduleRecord;
  setScheduleEnabled(scheduleId: ScheduleId, enabled: boolean): ScheduleRecord;
  removeSchedule(scheduleId: ScheduleId): void;
  getMessage(id: MessageId): Message | null;
  turnReplyOf(messageId: MessageId): TurnReplyView | null;
  sentFileAllows(sessionId: SessionId, realPath: string): boolean;
  shareHubFiles(sessionId: SessionId, args: readonly HubFileArg[], signal?: AbortSignal): Promise<SentFile[]>;
  onActionFailed(action: AnyActionRow, error: string): void;
  stopMessage(messageId: MessageId): void;
  reportHealth(module: HealthModule, error: string | null): void;
  getRouterDigest(): DeviceRouterDigest;
  listRouterItems(beforeCursor?: string, limit?: number, kind?: import("./api.ts").RouterItemsKind): RouterItemsPage;
  resolveRouterItem(itemId: RouterItemId, input: ResolveRouterItemRequest): ResolveRouterItemResponse;
  answerAsk(askMessageId: MessageId, input: ResolveRouterItemRequest): ResolveRouterItemResponse;
  recheckUserBlocker(id: UserBlockerId): RecheckUserBlockerResponse;
  userBlockerVendor(id: UserBlockerId): AgentVendor | null;
  deliveryOf(message: Pick<Message, "conversationId" | "workerId" | "sender" | "text" | "meta">): { prefixes: string[]; text: string };
  archiveAllRouterReports(): ArchiveAllReportsResponse;
  updateRouterSettings(input: UpdateRouterSettingsRequest): RouterSettings;
  listRouterCommands?(beforeCursor?: string, limit?: number): import("./api.ts").RouterCommandsPage;
  getRouterCommand?(id: import("./domain.ts").RouterCommandId): import("./router.ts").RouterCommandRecord | null;
  listProjectTaskGraphs(projectId: ProjectId, beforeId?: TaskGraphId, limit?: number): TaskGraphsPage;
  decideTaskNode(graphId: TaskGraphId, nodeKey: TaskNodeKey, input: DecideTaskNodeRequest): DecideTaskNodeResponse;
  skipTaskNode(graphId: TaskGraphId, nodeKey: TaskNodeKey, input: SkipTaskNodeRequest): SkipTaskNodeResponse;
  cancelTaskGraph(graphId: TaskGraphId, input: CancelTaskGraphRequest): CancelTaskGraphResponse;
  close?(): void;
}
