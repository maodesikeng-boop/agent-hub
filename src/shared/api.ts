import type {
  Conversation,
  ConversationId,
  HealthEntry,
  Message,
  MessageId,
  PersonaChangeId,
  Pm,
  PmId,
  PmMemoryFileDetail,
  PmMemoryFilesList,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  RateLimitWindow,
  RouterCommandId,
  RouterItemId,
  SessionState,
  TaskGraph,
  TaskGraphId,
  TaskNodeKey,
  WorkerId,
} from "./domain.ts";
import type {
  DeviceRouterDigest,
  PostRouterCommandTarget,
  RouterCommandRecord,
  RouterItem,
  RouterSettings,
  RouterSlice,
} from "./router.ts";
import type { LedgerErrorCode, PersonaView } from "./ledger.ts";
import type { PmCapabilitiesStart } from "./pm-capabilities.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import type { PmLookSetting } from "./slimes.ts";
import type { WorkerLineSummary } from "./snapshot.ts";
import type { UserBlocker, UserBlockerId } from "./user-blockers.ts";
import type { AgentVendor, ModelCatalog, QuotaWindowKey } from "./vendors.ts";
import type { FileAction } from "./preview.ts";
import type { ServerInfo } from "./server-info.ts";
import type { DeviceFingerprint, MeshLinkKind } from "./mesh.ts";
import type { WorkerPick } from "./worker.ts";

export const API_PATHS = {
  auth: "/auth",
  state: "/api/state",
  messages: (conversationId: ConversationId) => `/api/conversations/${conversationId}/messages`,
  conversationsLookup: (q: { ids?: readonly ConversationId[]; workerIds?: readonly WorkerId[] }) =>
    `/api/conversations/lookup?ids=${(q.ids ?? []).join(",")}&workerIds=${(q.workerIds ?? []).join(",")}`,
  stop: (conversationId: ConversationId) => `/api/conversations/${conversationId}/stop`,
  rewind: (conversationId: ConversationId) => `/api/conversations/${conversationId}/rewind`,
  pms: "/api/pms",
  endedWorkers: (pmId: PmId, before: ConversationId | null) =>
    `/api/pms/${pmId}/ended-workers${before === null ? "" : `?before=${before}`}`,
  persona: (pmId: PmId) => `/api/pms/${pmId}/persona`,
  pmLook: (pmId: PmId) => `/api/pms/${pmId}/look`,
  pmCapabilities: (pmId: PmId) => `/api/pms/${pmId}/capabilities`,
  routerCapabilities: "/api/router/capabilities",
  projectSetupCommand: (projectId: ProjectId) => `/api/projects/${projectId}/setup-command`,
  pmMemoryFiles: (pmId: PmId) => `/api/pms/${pmId}/memory-files`,
  pmMemoryFile: (pmId: PmId, name: string) => `/api/pms/${pmId}/memory-files/${encodeURIComponent(name)}`,
  revertPersonaChange: (changeId: PersonaChangeId) => `/api/persona-changes/${changeId}/revert`,
  renewSession: (pmId: PmId) => `/api/pms/${pmId}/renew-session`,
  archivePm: (id: PmId) => `/api/pms/${id}/archive`,
  unarchivePm: (id: PmId) => `/api/pms/${id}/unarchive`,
  retryMessage: (messageId: MessageId) => `/api/messages/${messageId}/retry`,
  messageTurnReply: (messageId: MessageId) => `/api/messages/${messageId}/turn-reply`,
  recheckUserBlocker: (id: UserBlockerId) => `/api/user-blockers/${id}/recheck`,
  uploads: "/api/uploads",
  upload: (id: string, name: string) => `/api/uploads/${id}/${encodeURIComponent(name)}`,
  sentFile: (id: string, name: string) => `/api/sent-files/${id}/${encodeURIComponent(name)}`,
  models: "/api/models",
  quota: "/api/quota",
  pickFolder: "/api/pick-folder",
  sentFileAction: (messageId: MessageId, index: number, action: FileAction) => `/api/messages/${messageId}/files/${index}/${action}`,
  attachmentAction: (id: string, action: FileAction) => `/api/attachments/${id}/${action}`,
  pmSchedules: (pmId: PmId) => `/api/pms/${pmId}/schedules`,
  schedule: (scheduleId: ScheduleId) => `/api/schedules/${scheduleId}`,
  commands: (conversationId: ConversationId) => `/api/conversations/${conversationId}/commands`,
  files: (conversationId: ConversationId, q: string) => `/api/conversations/${conversationId}/files?q=${encodeURIComponent(q)}`,
  ws: "/api/ws",
  selfReload: "/api/self-reload",

  routerDigest: "/api/router/digest",
  routerItems: "/api/router/items",
  askAnswer: (messageId: MessageId) => `/api/asks/${messageId}/answer`,
  routerItemResolve: (id: RouterItemId) => `/api/router/items/${id}/resolve`,
  routerItemDecide: (id: RouterItemId) => `/api/router/items/${id}/decide`,
  routerItemArchive: (id: RouterItemId) => `/api/router/items/${id}/archive`,
  routerReportsArchiveAll: "/api/router/reports/archive-all",
  routerSettings: "/api/router/settings",
  routerCommands: "/api/router/commands",
  routerCommandRetry: (id: RouterCommandId) => `/api/router/commands/${id}/retry`,
  routerTargetOps: "/api/router/target-ops",
  projectTaskGraphs: (projectId: ProjectId) => `/api/projects/${projectId}/task-graphs`,
  taskGraphDecide: (graphId: TaskGraphId, nodeKey: TaskNodeKey) =>
    `/api/task-graphs/${graphId}/nodes/${encodeURIComponent(nodeKey)}/decide`,
  taskGraphSkip: (graphId: TaskGraphId, nodeKey: TaskNodeKey) =>
    `/api/task-graphs/${graphId}/nodes/${encodeURIComponent(nodeKey)}/skip`,
  taskGraphCancel: (graphId: TaskGraphId) => `/api/task-graphs/${graphId}/cancel`,

  devices: "/api/devices",
  device: (id: DeviceId) => `/api/devices/${id}`,

  peerName: "/api/peer/name",
  peerRenamed: "/api/peer/renamed",
  peerTrust: "/api/peer/trust",
  peerLease: "/api/peer/lease",
  peerFeishuInbound: "/api/peer/feishu/inbound",
  peerFeishuChats: "/api/peer/feishu/chats",
  peerFeishuApp: "/api/peer/feishu/app",

  account: "/api/account",
  accountLogin: "/api/account/login",
  accountLogout: "/api/account/logout",
  accountApprovalBegin: (requestId: string) => `/api/account/approvals/${encodeURIComponent(requestId)}/begin`,
  accountApprovalAnswer: (requestId: string) => `/api/account/approvals/${encodeURIComponent(requestId)}/answer`,
  accountPriority: "/api/account/priority",

  pushKey: "/api/push/key",
  pushSubscriptions: "/api/push/subscriptions",
  pushUnsubscribe: "/api/push/unsubscribe",

  feishu: "/api/feishu",
  feishuRegistration: "/api/feishu/registration",
  feishuCredentials: "/api/feishu/credentials",
  feishuBindCode: "/api/feishu/bind-code",
  feishuChatPolicy: (pmId: PmId) => `/api/feishu/chats/${pmId}/policy`,
  feishuResync: "/api/feishu/resync",
  feishuDisconnect: "/api/feishu/disconnect",

  authStatus: "/api/auth/status",
  health: "/api/health",
  browserSessions: "/api/sessions",
  browserSession: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  logoutAll: "/api/sessions/logout-all",
  loginLinks: "/api/login-links",

  vendorSyncPreview: "/api/vendor-sync/preview",
  vendorSyncApply: "/api/vendor-sync/apply",

  providers: "/api/providers",
  providerInstall: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/install`,
  providerUpdate: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/update`,
  providerJobCancel: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/job/cancel`,
  providerGitInstall: "/api/providers/environment/git/install",
  providerAuthStart: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/auth/start`,
  providerAuthSubmit: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/auth/submit`,
  providerAuthCancel: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/auth/cancel`,
  providerAuthApiKey: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/auth/api-key`,
  providerAuthLogout: (vendor: string) => `/api/providers/${encodeURIComponent(vendor)}/auth/logout`,
} as const;

export interface ConversationSnapshot {
  conversation: Conversation;
  messages: Message[];
  hasMore: boolean;
  workerLine?: WorkerLineSummary;
}

export interface StateSnapshot {
  seq: number;
  pms: Pm[];
  projects: Project[];
  folders: ProjectFolder[];
  conversations: ConversationSnapshot[];
  sessions: SessionState[];
  health: HealthEntry[];
  schedules: ScheduleRecord[];
  router: RouterSlice;
  activeTaskGraphs: TaskGraph[];
  olderEndedWorkers?: Record<PmId, ConversationId>;
  server: ServerInfo;
  bootId?: string;
}

export type LedgerSnapshot = Omit<StateSnapshot, "server" | "bootId">;

export interface ConversationsLookup {
  conversations: ConversationSnapshot[];
  sessions: SessionState[];
}

export interface EndedWorkersPage extends ConversationsLookup {
  nextBefore: ConversationId | null;
}

export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

export interface PostMessageRequest {
  clientId: string;
  text: string;
  attachmentIds?: string[];
  workerPick?: WorkerPick;
}

export interface PostMessageResponse {
  messageId: MessageId;
}

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}

export type ApiErrorCode = LedgerErrorCode | "device_offline" | "device_not_found";

export interface CreatePmRequest {
  name: string;
  mode: PmMode;
  vendor?: AgentVendor;
  defaultModel?: string | null;
  effort?: string | null;
  persona: string;
  folder?: string;
  capabilities?: PmCapabilitiesStart;
}

export interface CreatePmResponse {
  pmId: PmId;
  conversationId: ConversationId;
}

export type PersonaResponse = PersonaView;

export interface EditPersonaRequest {
  text?: string;
  mode?: PmMode;
  vendor?: AgentVendor;
  model?: string | null;
  effort?: string | null;
  reason?: string;
}

export type PmLookRequest = PmLookSetting;

export interface PmLookResponse {
  pm: Pm;
}

export interface EditPersonaResponse {
  changed: boolean;
  persona: PersonaView;
}

export type PmMemoryFilesResponse = PmMemoryFilesList;

export type PmMemoryFileResponse = PmMemoryFileDetail;

export interface PutPmMemoryFileRequest {
  content: string;
}

export interface PutPmMemoryFileResponse {
  file: PmMemoryFileDetail;
  totalBytes: number;
}

export interface AddScheduleRequest {
  name: string;
  prompt: string;
  daily?: string;
  everyMinutes?: number;
}

export interface SetScheduleEnabledRequest {
  enabled: boolean;
}

export const REFRESH_UNUSABLE = "unusable";

export interface ModelsResponse {
  catalogs: ModelCatalog[];
}

export interface QuotaResponse {
  groups: Array<{ vendor?: AgentVendor; id: string; windows: Partial<Record<QuotaWindowKey, RateLimitWindow>> }>;
}

export interface ComposerCommand {
  name: string;
  description: string;
  argumentHint?: string;
  builtin?: true;
}

export const HUB_COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { name: "hub:worker", description: "Pick provider, model and effort for Workers" },
];

export interface CommandsResponse {
  commands: ComposerCommand[];
}

export interface FileEntry {
  path: string;
  root: string;
  insert: string;
}

export interface FilesResponse {
  entries: FileEntry[];
  truncated: boolean;
}

export interface RenewSessionResponse {
  handoverId: number;
}

export interface ArchivePmResponse {
  pm: Pm;
}

export interface RetryMessageResponse {
  messageId: MessageId;
}

export interface RewindMessageResponse {
  message: Message | null;
}

export interface PickFolderRequest {
  startDir?: string;
}

export interface PutProjectSetupCommandRequest {
  command: string | null;
}

export interface PutProjectSetupCommandResponse {
  project: Project;
}

export interface PickFolderResponse {
  path: string | null;
}

export const CHANGE_TYPES = [
  "message.created",
  "message.updated",
  "session.status",
  "health.updated",
  "pm.created",
  "pm.updated",
  "pm.removed",
  "project.created",
  "project.updated",
  "folders.updated",
  "conversation.created",
  "conversation.purged",
  "session.created",
  "schedule.updated",
  "schedule.removed",
  "router.settings.updated",
  "router.item.created",
  "router.item.updated",
  "router.reports.archived_all",
  "router.command.created",
  "router.command.updated",
  "task_graph.created",
  "task_graph.updated",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeDataMap {
  "message.created": { message: Message };
  "message.updated": { message: Message };
  "session.status": { session: SessionState };
  "health.updated": { health: HealthEntry };
  "pm.created": { pm: Pm };
  "pm.updated": { pm: Pm };
  "pm.removed": { pmId: PmId };
  "project.created": { project: Project };
  "project.updated": { project: Project };
  "folders.updated": { projectId: ProjectId; folders: ProjectFolder[] };
  "conversation.created": { conversation: Conversation };
  "conversation.purged": { conversationId: ConversationId; purgedAt: number };
  "session.created": { session: SessionState };
  "schedule.updated": { schedule: ScheduleRecord };
  "schedule.removed": { scheduleId: ScheduleId };
  "router.settings.updated": { settings: RouterSettings };
  "router.item.created": { item: RouterItem };
  "router.item.updated": { item: RouterItem };
  "router.reports.archived_all": { archivedIds: RouterItemId[]; updatedAt: number };
  "router.command.created": { command: RouterCommandRecord };
  "router.command.updated": { command: RouterCommandRecord };
  "task_graph.created": { graph: TaskGraph };
  "task_graph.updated": { graph: TaskGraph };
}

export type Change = {
  [T in ChangeType]: { seq: number; type: T; data: ChangeDataMap[T] };
}[ChangeType];

interface ResyncMessage {
  type: "resync";
}

export interface AccountUpdatedMessage {
  type: "account.updated";
}

export type WsServerMessage = Change | ResyncMessage | AccountUpdatedMessage;

export interface HeartbeatMessage {
  type: "heartbeat";
}

export const WS_HEARTBEAT_TEXT = JSON.stringify({ type: "heartbeat" } satisfies HeartbeatMessage);

export interface PresenceMessage {
  type: "presence";
  visible: boolean;
  deviceId: DeviceId | null;
  conversationId: ConversationId | null;
}

export type WsClientMessage = PresenceMessage;

export type DeviceId = string;

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDeviceId(value: string): value is DeviceId {
  return DEVICE_ID_PATTERN.test(value);
}

export const DEVICE_PROXY_PREFIX = "/d";

export function devicePath(device: DeviceId | null, path: string): string {
  return device === null ? path : `${DEVICE_PROXY_PREFIX}/${device}${path}`;
}

export const PEER_CLIENT_SCOPE_HEADER = "x-agent-hub-client-scope";

export const ENTRY_ONLY_API_PREFIXES: readonly string[] = ["/api/devices", "/api/account", "/api/sessions", "/api/login-links", "/api/push/", "/api/auth/", "/api/health", "/api/self-reload"];

export const DEVICE_OFFLINE_WS_CLOSE_CODE = 4502;
export const DEVICE_OFFLINE_REASON = "device_offline";

export interface DeviceInfo {
  id: DeviceId;
  name: string;
  platform: string;
  self: boolean;
  online: boolean;
  link: MeshLinkKind | null;
  fingerprint: DeviceFingerprint | null;
}

export interface DevicesResponse {
  devices: DeviceInfo[];
}

export interface RenameDeviceRequest {
  name: string;
}

export interface StartLoginRequest {
  relayUrl?: string;
  githubClientId?: string;
}

export interface AnswerApprovalRequest {
  match: boolean;
}

export interface SetCenterPriorityRequest {
  priority: DeviceId[];
}

export interface PushKeyResponse {
  publicKey: string;
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

export interface PushPayload {
  title: string;
  url: string;
  tag: string;
}

export interface AuthStatusResponse {
  status: "active" | "unauthenticated";
}

export interface BrowserSessionInfo {
  id: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface BrowserSessionsResponse {
  sessions: BrowserSessionInfo[];
}

export interface LoginLinkResponse {
  url: string;
  expiresAt: number;
}

export interface RouterItemsPage {
  items: RouterItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RouterCommandsPage {
  commands: RouterCommandRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type { PostRouterCommandTarget } from "./router.ts";

export interface RouterItemsQuery {
  cursor?: string;
  limit?: number;
  kind?: RouterItemsKind;
}
export type RouterItemsKind = "report";

export interface DecideRouterItemRequest {
  clientId: string;
  optionIndex?: number | null;
  choice?: string | null;
  note?: string;
}

export type ResolveRouterItemRequest =
  | {
      clientId: string;
      optionIndex?: number | null;
      choice?: string | null;
      note?: string;
    }
  | {
      action: "archive";
    };

export interface ResolveRouterItemResponse {
  item: RouterItem;
  messageId?: MessageId;
}

export interface RecheckUserBlockerResponse {
  blocker: UserBlocker;
  resolved: boolean;
}

export interface ArchiveAllReportsResponse {
  archivedIds: RouterItemId[];
  updatedAt: number;
}

export interface UpdateRouterSettingsRequest {
  vendor: AgentVendor | null;
  model: string | null;
  effort: string | null;
}

export interface UpdateRouterSettingsResponse {
  settings: RouterSettings;
}

export interface PostRouterCommandRequest {
  clientId: string;
  text: string;
  attachmentIds?: string[];
  target?: PostRouterCommandTarget;
}

export interface PostRouterCommandResponse {
  command: RouterCommandRecord;
}

export interface TaskGraphsPage {
  graphs: TaskGraph[];
  hasMore: boolean;
}

export interface DecideTaskNodeRequest {
  clientId: string;
  choice?: string | null;
  note?: string | null;
}

export interface DecideTaskNodeResponse {
  graph: TaskGraph;
  messageId: MessageId | null;
}

export interface SkipTaskNodeRequest {
  reason?: string;
}

export interface SkipTaskNodeResponse {
  graph: TaskGraph;
  messageId: MessageId | null;
}

export interface CancelTaskGraphRequest {
  reason?: string;
}

export interface CancelTaskGraphResponse {
  graph: TaskGraph;
  messageId: MessageId | null;
}

export type SelfReloadState = "idle" | "building" | "draining" | "restarting";

export interface SelfReloadStatus {
  state: SelfReloadState;
  build: boolean;
  requestedAt: number | null;
  deadlineAt: number | null;
  overdue: boolean;
  busy: string[];
  unresumable: string[];
  lastFailure: string | null;
}

export interface SelfReloadRequestBody {
  build?: boolean;
}

export interface SelfReloadResponse {
  text: string;
  status: SelfReloadStatus;
}
