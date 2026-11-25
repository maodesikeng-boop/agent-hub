import type { DecideSandboxApprovalRequest, DecideSandboxApprovalResponse, SandboxApprovalId } from "../shared/index.ts";
import {
  API_PATHS,
  API_REQUEST_TIMEOUT_MS,
  SLOW_API_REQUEST_TIMEOUT_MS,
  UPLOAD_TOO_LARGE_MESSAGE,
  devicePath,
  type AgentVendor,
  type ArchiveAllReportsResponse,
  type ArchivePmResponse,
  type Attachment,
  type BrowserSessionsResponse,
  type CapabilitiesPatch,
  type CapabilitiesView,
  type CapabilityScope,
  type CustomizedCapabilitiesResponse,
  type DecideTaskNodeRequest,
  type DecideTaskNodeResponse,
  type DeviceRouterDigest,
  type CancelTaskGraphRequest,
  type CancelTaskGraphResponse,
  type LoginLinkResponse,
  type ConversationId,
  type CreatePmRequest,
  type CreatePmResponse,
  type DeviceId,
  type DeviceInfo,
  type DevicesResponse,
  type AccountStatusView,
  type AnswerApprovalRequest,
  type SetCenterPriorityRequest,
  type StartLoginRequest,
  type RenameDeviceRequest,
  type AddScheduleRequest,
  type EditPersonaRequest,
  type ScheduleId,
  type ScheduleRecord,
  type SetScheduleEnabledRequest,
  type EditPersonaResponse,
  type PmLookRequest,
  type PmLookResponse,
  type PmPinRequest,
  type PmPinResponse,
  type FileAction,
  type FileActionResponse,
  type MessageId,
  type ConversationsLookup,
  type EndedWorkersPage,
  type MessagesPage,
  type WorkerId,
  type ModelsResponse,
  type REFRESH_UNUSABLE,
  type PickFolderRequest,
  type PickFolderResponse,
  type PostMessageRequest,
  type PostRouterCommandRequest,
  type PostRouterCommandResponse,
  type PersonaChangeId,
  type PersonaResponse,
  type PmId,
  type PmMemoryFileResponse,
  type PmMemoryFilesResponse,
  type PostMessageResponse,
  type ProjectId,
  type ProviderCancelAuthRequest,
  type ProviderCancelJobRequest,
  type ProviderLogoutRequest,
  type ProviderSaveApiKeyRequest,
  type ProviderStartAuthRequest,
  type ProviderStatusItem,
  type ProviderSubmitAuthRequest,
  type ProvidersStatusResponse,
  type PutPmMemoryFileRequest,
  type PutPmMemoryFileResponse,
  type PutProjectSetupCommandRequest,
  type PutProjectSetupCommandResponse,
  type QuotaResponse,
  type RenewSessionResponse,
  type ResourceCleanupResponse,
  type ResourceDecisionRequest,
  type ResourceDecisionResponse,
  type ResourcesSnapshot,
  type ResolveRouterItemRequest,
  type ResolveRouterItemResponse,
  type RecheckUserBlockerResponse,
  type RetryMessageResponse,
  type RewindMessageResponse,
  type RouterCommandId,
  type RouterCommandsPage,
  type RouterItemId,
  type RouterItemsKind,
  type RouterItemsPage,
  type SkipTaskNodeRequest,
  type SkipTaskNodeResponse,
  type StateSnapshot,
  type TaskGraphId,
  type TaskGraphsPage,
  type TaskNodeKey,
  type UpdateRouterSettingsRequest,
  type UpdateRouterSettingsResponse,
  type UpdateStatus,
  type UserBlockerId,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncPreviewResponse,
} from "../shared/index.ts";
import { encodeChangeStreamQuery, type ChangeCursor } from "../shared/change-stream.ts";
import { GENERIC_ERROR_TEXT, LOCAL_ERRORS, humanize, type ErrorCode, type HumanError } from "../shared/errors.ts";
import type { TurnReplyView } from "../shared/turn-reply.ts";
import { checkConnections } from "./connection.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | null;
  readonly hint: string | undefined;
  readonly raw: string;
  constructor(status: number, human: HumanError) {
    super(human.text);
    this.name = "ApiError";
    this.status = status;
    this.code = human.code;
    this.hint = human.hint;
    this.raw = human.raw;
  }
}

const TOO_LARGE_MESSAGE = "Too large to send (max 1 MB)";

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function networkError(err: unknown): ApiError {
  const raw = err instanceof Error ? err.message : "";
  return new ApiError(0, { code: "network", ...LOCAL_ERRORS.network, raw });
}

function transportError(err: unknown): ApiError {
  if (!(err instanceof DOMException && err.name === "TimeoutError")) return networkError(err);
  checkConnections();
  return new ApiError(0, { code: "timeout", ...LOCAL_ERRORS.timeout, raw: err.message });
}

async function failure(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
  }
  let human = humanize(body, res.status);
  if (res.status === 413 && human.code === null && human.text.startsWith(GENERIC_ERROR_TEXT)) human = { ...human, code: "too_large", text: TOO_LARGE_MESSAGE };
  const err = new ApiError(res.status, human);
  if (res.status === 401 && err.code !== "peer_unauthorized") for (const listener of unauthorizedListeners) listener();
  return err;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs: number | null = API_REQUEST_TIMEOUT_MS): Promise<T> {
  const timeout = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
  const signal = init?.signal && timeout ? AbortSignal.any([init.signal, timeout]) : timeout ?? init?.signal;
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init, ...(signal !== undefined && { signal }) });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await failure(res);
  try {
    text = await res.text();
  } catch (err) {
    throw transportError(err);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

function postJson<T>(path: string, body?: unknown, timeoutMs: number | null = API_REQUEST_TIMEOUT_MS): Promise<T> {
  if (body === undefined) return request<T>(path, { method: "POST" }, timeoutMs);
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

function sendJson<T>(method: "PUT" | "PATCH", path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const putJson = <T>(path: string, body: unknown): Promise<T> => sendJson<T>("PUT", path, body);

function capabilitiesPath(scope: CapabilityScope): string {
  if (scope.kind === "pm") return API_PATHS.pmCapabilities(scope.pmId);
  return scope.kind === "router" ? API_PATHS.routerCapabilities : API_PATHS.defaultCapabilities;
}

function capabilityRoutes(at: (path: string) => string) {
  return {
    fetchCapabilities: (scope: CapabilityScope, options: { refresh?: boolean } = {}) =>
      request<CapabilitiesView>(at(`${capabilitiesPath(scope)}${options.refresh ? "?refresh=1" : ""}`), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    patchCapabilities: (scope: CapabilityScope, body: CapabilitiesPatch) => sendJson<CapabilitiesView>("PATCH", at(capabilitiesPath(scope)), body),
    resetPmCapabilities: (pmId: PmId) => request<CapabilitiesView>(at(API_PATHS.pmCapabilities(pmId)), { method: "DELETE" }, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchCustomizedCapabilities: () => request<CustomizedCapabilitiesResponse>(at(API_PATHS.customizedCapabilities)),
    putProjectSetupCommand: (projectId: ProjectId, command: string | null) =>
      putJson<PutProjectSetupCommandResponse>(at(API_PATHS.projectSetupCommand(projectId)), { command } satisfies PutProjectSetupCommandRequest),
  };
}

function providerRoutes(at: (path: string) => string) {
  return {
    fetchProviders: (options: { refresh?: boolean } = {}) =>
      request<ProvidersStatusResponse>(
        at(options.refresh ? `${API_PATHS.providers}?refresh=1` : API_PATHS.providers),
        undefined,
        options.refresh ? SLOW_API_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS,
      ),
    postProviderInstall: (vendor: AgentVendor) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerInstall(vendor)), {}),
    postProviderUpdate: (vendor: AgentVendor) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerUpdate(vendor)), {}),
    postProviderJobCancel: (vendor: AgentVendor, body: ProviderCancelJobRequest) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerJobCancel(vendor)), body),
    postProviderGitInstall: () =>
      postJson<ProvidersStatusResponse>(at(API_PATHS.providerGitInstall), {}),
    postProviderAuthStart: (vendor: AgentVendor, body: ProviderStartAuthRequest) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerAuthStart(vendor)), body),
    postProviderAuthSubmit: (vendor: AgentVendor, body: ProviderSubmitAuthRequest) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerAuthSubmit(vendor)), body),
    postProviderAuthCancel: (vendor: AgentVendor, body: ProviderCancelAuthRequest) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerAuthCancel(vendor)), body),
    postProviderAuthApiKey: (vendor: AgentVendor, body: ProviderSaveApiKeyRequest) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerAuthApiKey(vendor)), body, SLOW_API_REQUEST_TIMEOUT_MS),
    postProviderAuthLogout: (vendor: AgentVendor, body: ProviderLogoutRequest = {}) =>
      postJson<ProviderStatusItem>(at(API_PATHS.providerAuthLogout(vendor)), body, SLOW_API_REQUEST_TIMEOUT_MS),
  };
}

export function createClient(device: DeviceId | null) {
  const at = (path: string) => devicePath(device, path);
  return {
    device,
    url: at,
    fetchState: (signal?: AbortSignal) => request<StateSnapshot>(at(API_PATHS.state), signal ? { signal } : undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchOlderMessages: (conversationId: ConversationId, before: MessageId) =>
      request<MessagesPage>(`${at(API_PATHS.messages(conversationId))}?before=${before}`),
    fetchConversationsLookup: (query: { ids?: readonly ConversationId[]; workerIds?: readonly WorkerId[] }) =>
      request<ConversationsLookup>(at(API_PATHS.conversationsLookup(query))),
    fetchEndedWorkers: (pmId: PmId, before: ConversationId | null) => request<EndedWorkersPage>(at(API_PATHS.endedWorkers(pmId, before))),
    fetchTurnReply: (messageId: MessageId) => request<TurnReplyView>(at(API_PATHS.messageTurnReply(messageId))),
    postMessage: (conversationId: ConversationId, body: PostMessageRequest) => postJson<PostMessageResponse>(at(API_PATHS.messages(conversationId)), body),
    postUpload: async (file: Blob, name: string): Promise<Attachment> => {
      try {
        return await request<Attachment>(
          `${at(API_PATHS.uploads)}?name=${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          },
          null,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 413) throw new ApiError(413, { code: "too_large", text: UPLOAD_TOO_LARGE_MESSAGE, raw: err.raw });
        throw err;
      }
    },
    postStop: (conversationId: ConversationId) => postJson<void>(at(API_PATHS.stop(conversationId))),
    postRewind: (conversationId: ConversationId) => postJson<RewindMessageResponse>(at(API_PATHS.rewind(conversationId))),
    postCreatePm: (body: CreatePmRequest) => postJson<CreatePmResponse>(at(API_PATHS.pms), body),
    postPickFolder: (body: PickFolderRequest) => postJson<PickFolderResponse>(at(API_PATHS.pickFolder), body, null),
    fetchPersona: (pmId: PmId) => request<PersonaResponse>(at(API_PATHS.persona(pmId))),
    putPersona: (pmId: PmId, body: EditPersonaRequest) => putJson<EditPersonaResponse>(at(API_PATHS.persona(pmId)), body),
    putPmLook: (pmId: PmId, body: PmLookRequest) => putJson<PmLookResponse>(at(API_PATHS.pmLook(pmId)), body),
    putPmPin: (pmId: PmId, body: PmPinRequest) => putJson<PmPinResponse>(at(API_PATHS.pmPin(pmId)), body),
    postRevertPersonaChange: (changeId: PersonaChangeId) => postJson<EditPersonaResponse>(at(API_PATHS.revertPersonaChange(changeId))),
    fetchPmMemoryFiles: (pmId: PmId) => request<PmMemoryFilesResponse>(at(API_PATHS.pmMemoryFiles(pmId))),
    fetchPmMemoryFile: (pmId: PmId, name: string) => request<PmMemoryFileResponse>(at(API_PATHS.pmMemoryFile(pmId, name))),
    putPmMemoryFile: (pmId: PmId, name: string, body: PutPmMemoryFileRequest) =>
      putJson<PutPmMemoryFileResponse>(at(API_PATHS.pmMemoryFile(pmId, name)), body),
    deletePmMemoryFile: (pmId: PmId, name: string) =>
      request<void>(at(API_PATHS.pmMemoryFile(pmId, name)), { method: "DELETE" }),
    postAddSchedule: (pmId: PmId, body: AddScheduleRequest) => postJson<ScheduleRecord>(at(API_PATHS.pmSchedules(pmId)), body),
    putScheduleEnabled: (scheduleId: ScheduleId, enabled: boolean) =>
      putJson<ScheduleRecord>(at(API_PATHS.schedule(scheduleId)), { enabled } satisfies SetScheduleEnabledRequest),
    deleteSchedule: (scheduleId: ScheduleId) => request<void>(at(API_PATHS.schedule(scheduleId)), { method: "DELETE" }),
    fetchModels: (options: { refresh?: typeof REFRESH_UNUSABLE } = {}) =>
      request<ModelsResponse>(at(options.refresh ? `${API_PATHS.models}?refresh=${options.refresh}` : API_PATHS.models), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchQuota: (signal?: AbortSignal) => request<QuotaResponse>(at(API_PATHS.quota), signal ? { signal } : undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchResources: (options: { refresh?: boolean } = {}) =>
      request<ResourcesSnapshot>(
        at(options.refresh ? `${API_PATHS.resources}?refresh=1` : API_PATHS.resources),
        undefined,
        SLOW_API_REQUEST_TIMEOUT_MS,
      ),
    postResourceDecision: (body: ResourceDecisionRequest) =>
      postJson<ResourceDecisionResponse>(at(API_PATHS.resourceDecision), body, SLOW_API_REQUEST_TIMEOUT_MS),
    postResourceCleanup: () => postJson<ResourceCleanupResponse>(at(API_PATHS.resourceCleanup), {}, SLOW_API_REQUEST_TIMEOUT_MS),
    fetchVendorSyncPreview: () => request<VendorSyncPreviewResponse>(at(API_PATHS.vendorSyncPreview), undefined, SLOW_API_REQUEST_TIMEOUT_MS),
    postVendorSyncApply: (body: VendorSyncApplyRequest) => postJson<VendorSyncApplyResponse>(at(API_PATHS.vendorSyncApply), body, SLOW_API_REQUEST_TIMEOUT_MS),
    ...providerRoutes(at),
    ...capabilityRoutes(at),
    postRenewSession: (pmId: PmId) => postJson<RenewSessionResponse>(at(API_PATHS.renewSession(pmId))),
    postArchivePm: (pmId: PmId) => postJson<ArchivePmResponse>(at(API_PATHS.archivePm(pmId))),
    postUnarchivePm: (pmId: PmId) => postJson<ArchivePmResponse>(at(API_PATHS.unarchivePm(pmId))),
    postRetryMessage: (messageId: MessageId) => postJson<RetryMessageResponse>(at(API_PATHS.retryMessage(messageId))),
    postDecideSandboxApproval: (id: SandboxApprovalId, body: DecideSandboxApprovalRequest) =>
      postJson<DecideSandboxApprovalResponse>(at(API_PATHS.decideSandboxApproval(id)), body),
    postRecheckUserBlocker: (id: UserBlockerId) => postJson<RecheckUserBlockerResponse>(at(API_PATHS.recheckUserBlocker(id))),
    postFileAction: (target: FileActionTarget, action: FileAction) => {
      const path = target.kind === "sent" ? API_PATHS.sentFileAction(target.messageId, target.index, action) : API_PATHS.attachmentAction(target.id, action);
      return postJson<FileActionResponse>(at(path));
    },
    fetchRouterDigest: () => request<DeviceRouterDigest>(at(API_PATHS.routerDigest)),
    fetchRouterItems: (options: { cursor?: string | null; limit?: number; kind?: RouterItemsKind } = {}) => {
      // Build query keys from an object so "cursor" is not flagged by vendor-guard as a vendor name.
      const query: Record<string, string> = {};
      if (options.cursor) query.cursor = options.cursor;
      if (options.limit !== undefined) query.limit = String(options.limit);
      if (options.kind) query.kind = options.kind;
      const qs = new URLSearchParams(query).toString();
      return request<RouterItemsPage>(at(qs ? `${API_PATHS.routerItems}?${qs}` : API_PATHS.routerItems));
    },
    fetchRouterCommands: (options: { cursor?: string | null; limit?: number } = {}) => {
      const query: Record<string, string> = {};
      if (options.cursor) query.cursor = options.cursor;
      if (options.limit !== undefined) query.limit = String(options.limit);
      const qs = new URLSearchParams(query).toString();
      return request<RouterCommandsPage>(at(qs ? `${API_PATHS.routerCommands}?${qs}` : API_PATHS.routerCommands));
    },
    postAnswerAsk: (messageId: MessageId, body: ResolveRouterItemRequest) =>
      postJson<ResolveRouterItemResponse>(at(API_PATHS.askAnswer(messageId)), body),
    postResolveRouterItem: (id: RouterItemId, body: ResolveRouterItemRequest) =>
      postJson<ResolveRouterItemResponse>(at(API_PATHS.routerItemResolve(id)), body),
    postArchiveAllRouterReports: () => postJson<ArchiveAllReportsResponse>(at(API_PATHS.routerReportsArchiveAll), {}),
    putRouterSettings: (body: UpdateRouterSettingsRequest) =>
      putJson<UpdateRouterSettingsResponse>(at(API_PATHS.routerSettings), body),
    postRouterCommand: (body: PostRouterCommandRequest) =>
      postJson<PostRouterCommandResponse>(at(API_PATHS.routerCommands), body),
    postRetryRouterCommand: (id: RouterCommandId) =>
      postJson<PostRouterCommandResponse>(at(API_PATHS.routerCommandRetry(id)), {}),
    fetchProjectTaskGraphs: (projectId: ProjectId, options: { before?: TaskGraphId; limit?: number } = {}) => {
      const params = new URLSearchParams({ status: "history" });
      if (options.before !== undefined) params.set("before", String(options.before));
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      return request<TaskGraphsPage>(`${at(API_PATHS.projectTaskGraphs(projectId))}?${params.toString()}`);
    },
    postTaskGraphDecide: (graphId: TaskGraphId, nodeKey: TaskNodeKey, body: DecideTaskNodeRequest) =>
      postJson<DecideTaskNodeResponse>(at(API_PATHS.taskGraphDecide(graphId, nodeKey)), body),
    postTaskGraphSkip: (graphId: TaskGraphId, nodeKey: TaskNodeKey, body: SkipTaskNodeRequest = {}) =>
      postJson<SkipTaskNodeResponse>(at(API_PATHS.taskGraphSkip(graphId, nodeKey)), body),
    postTaskGraphCancel: (graphId: TaskGraphId, body: CancelTaskGraphRequest = {}) =>
      postJson<CancelTaskGraphResponse>(at(API_PATHS.taskGraphCancel(graphId)), body),
    changeStreamUrl: (cursor: ChangeCursor) => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      return `${scheme}://${location.host}${at(API_PATHS.ws)}${encodeChangeStreamQuery(cursor)}`;
    },
  };
}

export type HubClient = ReturnType<typeof createClient>;

export const localClient: HubClient = createClient(null);

export const { fetchState, postMessage, postUpload, fetchVendorSyncPreview, postVendorSyncApply } = localClient;

export const fetchDevices = (signal?: AbortSignal) => request<DevicesResponse>(API_PATHS.devices, signal ? { signal } : undefined);
export const patchDevice = (id: DeviceId, body: RenameDeviceRequest) => sendJson<DeviceInfo>("PATCH", API_PATHS.device(id), body);
export const deleteDevice = (id: DeviceId) => request<void>(API_PATHS.device(id), { method: "DELETE" });

export const fetchAccount = (signal?: AbortSignal) => request<AccountStatusView>(API_PATHS.account, signal ? { signal } : undefined);
export const postAccountLogin = (body: StartLoginRequest = {}) => postJson<AccountStatusView>(API_PATHS.accountLogin, body);
export const cancelAccountLogin = () => request<AccountStatusView>(API_PATHS.accountLogin, { method: "DELETE" });
export const postAccountLogout = () => postJson<AccountStatusView>(API_PATHS.accountLogout, {});
export const postApprovalBegin = (requestId: string) => postJson<AccountStatusView>(API_PATHS.accountApprovalBegin(requestId), {});
export const postApprovalAnswer = (requestId: string, match: boolean) =>
  postJson<AccountStatusView>(API_PATHS.accountApprovalAnswer(requestId), { match } satisfies AnswerApprovalRequest);
export const putCenterPriority = (priority: DeviceId[]) => putJson<AccountStatusView>(API_PATHS.accountPriority, { priority } satisfies SetCenterPriorityRequest);

export function fetchBrowserSessions(): Promise<BrowserSessionsResponse> {
  return request<BrowserSessionsResponse>(API_PATHS.browserSessions);
}

export function deleteBrowserSession(id: string): Promise<void> {
  return request<void>(API_PATHS.browserSession(id), { method: "DELETE" });
}

export function postLogoutAll(): Promise<void> {
  return postJson<void>(API_PATHS.logoutAll);
}

export function postLoginLink(): Promise<LoginLinkResponse> {
  return postJson<LoginLinkResponse>(API_PATHS.loginLinks);
}

export const fetchUpdate = () => request<UpdateStatus>(API_PATHS.update);
export const postUpdateCheck = () => postJson<UpdateStatus>(API_PATHS.updateCheck);

export type FileActionTarget = { kind: "sent"; messageId: MessageId; index: number } | { kind: "upload"; id: string };

export async function fetchFileBytes(url: string, maxBytes: number | null): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...(maxBytes === null ? {} : { headers: { range: `bytes=0-${maxBytes - 1}` } }) });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw await failure(res);
  const bytes = await res.arrayBuffer();
  return maxBytes === null || bytes.byteLength <= maxBytes ? bytes : bytes.slice(0, maxBytes);
}
