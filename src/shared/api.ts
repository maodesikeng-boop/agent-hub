// 网页 ↔ 界面服务（设计第 3 章、m1-plan 第 3 节第 1 条）。
import type {
  Conversation,
  ConversationId,
  HealthEntry,
  Message,
  MessageId,
  PersonaChangeId,
  Pm,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  RateLimitWindow,
  SessionState,
} from "./domain.ts";
import type { LedgerErrorCode, PersonaView } from "./ledger.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import type { AgentVendor, ModelCatalog, QuotaWindowKey } from "./vendors.ts";
import type { FileAction } from "./preview.ts";
import type { ServerInfo } from "./server-info.ts";

export const API_PATHS = {
  /**
   * GET ?token=<界面用户令牌>：设 cookie，跳到 /。令牌存在 state/ui-token，守护进程重启后不变，旧 cookie 仍然有效。
   * 联机 P6 起：令牌只当主钥匙，登录后发随机的会话 cookie（每个浏览器一条，见 browserSessions）；老 cookie 失效一次，重点一次登录链接。
   */
  auth: "/auth",
  state: "/api/state",
  messages: (conversationId: ConversationId) => `/api/conversations/${conversationId}/messages`,
  stop: (conversationId: ConversationId) => `/api/conversations/${conversationId}/stop`,
  /** POST：新建项目经理（CreatePmRequest → 201 CreatePmResponse）。没有单独建项目的入口：建项目经理时选主文件夹，或者在会话里说。 */
  pms: "/api/pms",
  /** GET → PersonaView；PUT（EditPersonaRequest）→ EditPersonaResponse。 */
  persona: (pmId: PmId) => `/api/pms/${pmId}/persona`,
  /** POST，没有请求体 → EditPersonaResponse。 */
  revertPersonaChange: (changeId: PersonaChangeId) => `/api/persona-changes/${changeId}/revert`,
  /** POST，没有请求体 → 202 RenewSessionResponse：开新会话（后台写交接，写好后换代，见 ledger/handover.ts）。 */
  renewSession: (pmId: PmId) => `/api/pms/${pmId}/renew-session`,
  /** POST，没有请求体 → 202 RetryMessageResponse。 */
  retryMessage: (messageId: MessageId) => `/api/messages/${messageId}/retry`,
  /**
   * POST ?name=<文件名>：请求体就是文件原样的字节（不是 JSON，不绑定接收方），最多 MAX_UPLOAD_BYTES，不动别的接口 1 MB 的上限。
   * 200 → Attachment；空文件、太大（413）、文件名不合法 → 中文原因。之后发消息时在 PostMessageRequest.attachmentIds 里带上它的 id。
   */
  uploads: "/api/uploads",
  /** GET：按上传编号取文件。图片内联显示（缩略图），别的当下载。 */
  upload: (id: string, name: string) => `/api/uploads/${id}/${encodeURIComponent(name)}`,
  /** GET：按副本编号取 agent 发出的文件（shared/sent-files.ts）。图片（含 svg）内联，别的当下载；支持 Range。 */
  sentFile: (id: string, name: string) => `/api/sent-files/${id}/${encodeURIComponent(name)}`,
  /** GET → ModelsResponse；?refresh=1 先重新问一次厂商再回；?refresh=unusable 只重问这台设备上不能用的那几家。 */
  models: "/api/models",
  /** GET → QuotaResponse：事件流里没有额度的厂商（agy）的额度；服务端缓存 FETCHED_QUOTA_FRESH_MS，没装、查失败的没有那一块。 */
  quota: "/api/quota",
  /**
   * POST（PickFolderRequest → PickFolderResponse）：守护进程在这台 Mac 上弹原生的“选择文件夹”，等用户选完才回。
   * 取消、超时回 path null（不是错误）；同时已经有一个对话框 409；起不来 osascript 回中文原因。
   * 不是 macOS（StateSnapshot.server.folderPicker 为 false）回 501，网页不显示这个按钮。
   */
  pickFolder: "/api/pick-folder",
  /**
   * POST，没有请求体 → FileActionResponse：用 macOS 的 open 在 Finder 中显示（reveal）/ 用默认程序打开（open）agent 发来的文件。
   * 按消息编号 + meta.files 的下标找文件（不收路径）；原文件还在、还在这个会话允许的文件夹里用原文件，否则用副本。
   * 带可执行权限的、扩展名不在白名单（OPEN_ALLOWED_EXTENSIONS，文档、图片、音视频、纯文本）里的 open 回 403，reveal 照常。
   * 不是 macOS（StateSnapshot.server.fileActions 为 false）回 501，网页不显示这两个按钮。
   */
  sentFileAction: (messageId: MessageId, index: number, action: FileAction) => `/api/messages/${messageId}/files/${index}/${action}`,
  /** POST，同上，对象是聊天框上传的附件（按上传编号，只有数据目录里的那一份）。 */
  attachmentAction: (id: string, action: FileAction) => `/api/attachments/${id}/${action}`,
  /** POST（AddScheduleRequest → 201 ScheduleRecord）：用户给这个项目经理建定时任务，校验同 hub schedule add，失败回中文原因。 */
  pmSchedules: (pmId: PmId) => `/api/pms/${pmId}/schedules`,
  /** PUT（SetScheduleEnabledRequest → ScheduleRecord）暂停 / 恢复；DELETE → 204。 */
  schedule: (scheduleId: ScheduleId) => `/api/schedules/${scheduleId}`,
  /**
   * GET → CommandsResponse：输入框“/”列表。后台按对话找到它的会话和厂商去问，已经去掉隐藏的命令；问不到给空列表，不报错。
   * 对话不存在 → 404。用户手打了隐藏的命令（/clear、/model……），发消息时 400（code invalid），error 是拦下的原因。
   */
  commands: (conversationId: ConversationId) => `/api/conversations/${conversationId}/commands`,
  /** GET ?q=<搜索词> → FilesResponse：输入框“@”列表，只在这个对话的工作文件夹里搜文件（不含文件夹）。对话不存在 → 404。 */
  files: (conversationId: ConversationId, q: string) => `/api/conversations/${conversationId}/files?q=${encodeURIComponent(q)}`,
  /** WebSocket，?since=<seq>。服务端 → 网页是 WsServerMessage；网页 → 服务端是 WsClientMessage（联机 P4 起）。 */
  ws: "/api/ws",

  // ---- 联机（docs/multi-device-design.md）：浏览器 → 入口 ----
  // 别的设备的接口都是 devicePath(id, 上面的路径)，入口原样转发（HTTP 和 WebSocket）；对方连不上 → 502 code device_offline，
  // 设备编号不认识 → 404 code not_found。下面这些是入口自己的，不转发。

  /** GET → DevicesResponse（含本机，本机排第一）；POST（AddDeviceRequest：对方网址 + 对方给的邀请码）→ 201 DeviceInfo，配对失败回中文原因。 */
  devices: "/api/devices",
  /** PATCH（RenameDeviceRequest）→ DeviceInfo；DELETE → 204：删本机记录并通知对方删（对方离线只删本机）。不能删本机（400）。 */
  device: (id: DeviceId) => `/api/devices/${id}`,
  /** POST，没有请求体 → 201 DeviceInviteResponse：邀请别的设备加入本机（邀请码 128 位随机、10 分钟、只能用一次）。 */
  deviceInvites: "/api/devices/invites",

  // ---- 联机：设备 → 设备（带 Authorization: Bearer <设备令牌>、PEER_DEVICE_HEADER；只经 tailscale serve 进来，还要过身份头） ----

  /** POST（PeerPairRequest，不带 Bearer，凭邀请码）→ PeerPairResponse。主人登录名和本机不一致、邀请码不对 / 过期 / 用过 → 403；错 5 次锁定。 */
  peerPair: "/api/peer/pair",
  /** PUT（PeerDeviceListRequest）→ 204：已配对的设备互相同步设备清单（只有谁是谁、网址，不带令牌）。 */
  peerDevices: "/api/peer/devices",
  /** POST，没有请求体 → 204：对方把本机移除了，本机也删掉它的记录。 */
  peerUnpair: "/api/peer/unpair",
  /**
   * POST（PeerInviteRequest）→ 201 DeviceInviteResponse：已配对的设备替第三台要一个邀请码（介绍用，见 peerIntroductions）。
   * 邀请码只给 deviceId 那台用；它是本机移除过的设备、或邀请码被锁住时 → 403。
   */
  peerInvites: "/api/peer/invites",
  /**
   * POST（PeerIntroductionRequest）→ PeerIntroductionResponse：请本机把它介绍给本机已配对的另一台。本机去那台要一个邀请码交回来，
   * 请求方再拿它去那台 peerPair。“第三台配一次就全通”靠它；谁去配对按设备编号定（小的那台），不会两边同时配。
   */
  peerIntroductions: "/api/peer/introductions",
  /** PUT（RenameDeviceRequest）→ 204：入口上给这台改名，名字归这台自己管，改完它再同步给所有已配对的设备。 */
  peerName: "/api/peer/name",

  // ---- 联机：推送（只在“提醒设备”上用，手机 PWA 装在哪个来源就是哪台） ----

  /** GET → PushKeyResponse：VAPID 公钥，网页订阅时用。 */
  pushKey: "/api/push/key",
  /** POST（PushSubscribeRequest，就是浏览器 PushSubscription.toJSON() 的样子）→ 204。同一个 endpoint 重复订阅是覆盖。 */
  pushSubscriptions: "/api/push/subscriptions",
  /** POST（PushUnsubscribeRequest）→ 204。没有这条订阅也是 204。 */
  pushUnsubscribe: "/api/push/unsubscribe",

  // ---- 联机：浏览器登录（每个浏览器一条，能单独退出；只在入口上，浏览器从不拿别的设备的令牌） ----

  /** GET → BrowserSessionsResponse。 */
  browserSessions: "/api/sessions",
  /** DELETE → 204：退出这一个浏览器（可以是自己）。 */
  browserSession: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  /** POST，没有请求体 → 204：全部退出 = 换主钥匙（state/ui-token）+ 清所有会话，包括自己。 */
  logoutAll: "/api/sessions/logout-all",
  /** POST，没有请求体 → 201 LoginLinkResponse：给手机扫的一次性登录链接（5 分钟、用一次就失效）。 */
  loginLinks: "/api/login-links",
} as const;

export interface ConversationSnapshot {
  conversation: Conversation;
  /** 最近 100 条，按编号从小到大。 */
  messages: Message[];
  /** 比 messages 里最早一条更早的还有没有。 */
  hasMore: boolean;
}

/**
 * GET /api/state。seq 是拍照那一刻的事件序号，WebSocket 从它之后接着推。
 * 不含老的项目群和归档的项目（11-03 拿掉了项目群，见 CONVERSATION_KINDS）。
 * M3：conversations、sessions 里含 Worker 的（kind worker），左栏不显示；“N 个 Worker 在跑”按 Conversation.pmId 是这个项目经理、
 * kind worker 的对话里最新一代会话 activity 不是 idle 的数。项目经理对话里那一行汇报是 kind worker 的消息（WorkerMessageMeta）。
 */
export interface StateSnapshot {
  seq: number;
  pms: Pm[];
  /** 进行中的项目（每个项目经理最多一个，Project.conversationId 是它的对话），按编号从小到大。 */
  projects: Project[];
  /** 这些项目没移除的文件夹，按编号从小到大。 */
  folders: ProjectFolder[];
  conversations: ConversationSnapshot[];
  sessions: SessionState[];
  health: HealthEntry[];
  /** 所有项目经理的定时任务（M6），按编号从小到大；ScheduleRecord.pmId 认是谁的。 */
  schedules: ScheduleRecord[];
  /** 守护进程所在的机器能做什么（界面服务补上的，不是账本的数据）：网页按它显示“选择…”和“在 Finder 中显示”等控件。 */
  server: ServerInfo;
}

/** 账本给出的快照：界面服务在 /api/state 里再补上 server。 */
export type LedgerSnapshot = Omit<StateSnapshot, "server">;

/** GET /api/conversations/:id/messages?before=<消息编号>：更早的 100 条，从小到大。 */
export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
}

/**
 * POST /api/conversations/:id/messages。clientId 由网页生成，重发用同一个。
 * attachmentIds：先用 API_PATHS.uploads 上传拿到的上传编号；有附件时 text 可以是空的（只发文件）。服务端按编号找到磁盘上的文件，
 * 找不到（没传过、被清理了）→ 400；消息里存的附件信息和正文里的路径都是服务端从文件算出来的。
 */
export interface PostMessageRequest {
  clientId: string;
  text: string;
  attachmentIds?: string[];
}

export interface PostMessageResponse {
  messageId: MessageId;
}

/**
 * 4xx / 5xx 的响应体。对话不存在（账本抛 ConversationNotFoundError）→ 404。
 * 账本抛 LedgerRequestError 时按 LEDGER_ERROR_HTTP_STATUS 映射，error 是它的 message（原样显示给用户），code 是它的 code。
 * 请求体校验没过（界面服务自己查的）→ 400，code 是 "invalid"。
 */
export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}

/** 账本的错误码，加上联机的：device_offline = 入口转发时连不上那台设备（502），网页据此显示离线，不弹错。 */
export type ApiErrorCode = LedgerErrorCode | "device_offline";

// ---- M2：项目经理、性格设定、重试 ----
// 请求体由界面服务按 JSON Schema 校验（多余字段拒绝），长度上限见 limits.ts；业务校验在账本。

/**
 * POST /api/pms。name 按 normalizeName；persona 不超过 MAX_PERSONA_BYTES；defaultModel 空串或不给 = 用 claude 自己的默认。
 * vendor、defaultModel、effort 的取值见厂商清单 vendors.ts，不对 → 400 带原因。
 * folder：主文件夹（用户填的路径，可以带 ~，服务端解析成真实路径），可选；给了就同时建好项目，不存在等不对 → 400 带原因。
 */
export interface CreatePmRequest {
  name: string;
  mode: PmMode;
  vendor?: AgentVendor;
  defaultModel?: string | null;
  effort?: string | null;
  persona: string;
  folder?: string;
}

export interface CreatePmResponse {
  pmId: PmId;
  /** 它的对话，网页建好后跳过去。 */
  conversationId: ConversationId;
}

/** GET /api/pms/:id/persona 的响应就是账本的 PersonaView。 */
export type PersonaResponse = PersonaView;

/** PUT /api/pms/:id/persona。至少给一个字段（reason 不算）；model、effort 给 null 是改回默认。 */
export interface EditPersonaRequest {
  text?: string;
  mode?: PmMode;
  vendor?: AgentVendor;
  model?: string | null;
  effort?: string | null;
  reason?: string;
}

/** PUT persona、POST revert 的响应：改完之后的样子（没改动时 changed 为 false）。 */
export interface EditPersonaResponse {
  changed: boolean;
  persona: PersonaView;
}

/** POST /api/pms/:id/schedules：daily（"HH:MM"）和 everyMinutes 二选一。 */
export interface AddScheduleRequest {
  name: string;
  prompt: string;
  daily?: string;
  everyMinutes?: number;
}

/** PUT /api/schedules/:id。 */
export interface SetScheduleEnabledRequest {
  enabled: boolean;
}

/** GET /api/models?refresh=unusable：只重问这台设备上现在不能用（没登录、没装）的厂商。 */
export const REFRESH_UNUSABLE = "unusable";

/** GET /api/models：每家厂商一份模型名单（按 AGENT_VENDORS 的顺序）。问不到厂商时是打包的名单，不报错。 */
export interface ModelsResponse {
  catalogs: ModelCatalog[];
}

/** GET /api/quota：一组一块（厂商分组），窗口的值同事件里的 RateLimitWindow（utilization 0 到 1，resetsAt Unix 秒）。 */
export interface QuotaResponse {
  groups: Array<{ id: string; name: string; windows: Partial<Record<QuotaWindowKey, RateLimitWindow>> }>;
}

/** 输入框“/”列表里的一项。name 不带开头的 /；argumentHint 没有就不给；builtin：厂商自带的命令（用户自己的命令、skill 不带这个字段）。 */
export interface ComposerCommand {
  name: string;
  description: string;
  argumentHint?: string;
  builtin?: true;
}

/** GET /api/conversations/:id/commands。 */
export interface CommandsResponse {
  commands: ComposerCommand[];
}

/**
 * 输入框“@”列表里的一项：
 * - path：在 root 下的相对路径（显示用：文件名 + 父目录）；
 * - root：它在哪个工作文件夹（绝对路径）；
 * - insert：选中后插进输入框的文字（不含末尾空格），由厂商实现生成（claude 是 `@path`，带空格的 `@"a b.md"`），网页原样插入。
 *   主文件夹（agent 的工作目录）里的用相对路径，别的文件夹里的用绝对路径。
 */
export interface FileEntry {
  path: string;
  root: string;
  insert: string;
}

/** GET /api/conversations/:id/files?q=。最多 MAX_FILE_RESULTS 条，按匹配程度排好；truncated：有文件夹文件太多，没列全。 */
export interface FilesResponse {
  entries: FileEntry[];
  truncated: boolean;
}

/** POST /api/pms/:id/renew-session → 202：这次交接的编号（handovers 那一行，连点返回同一个）。换代后照常从 WebSocket 推分隔线。 */
export interface RenewSessionResponse {
  handoverId: number;
}

/** POST /api/messages/:id/retry → 202。之后状态变化照常从 WebSocket 推（message.updated）。 */
export interface RetryMessageResponse {
  messageId: MessageId;
}

/** POST /api/pick-folder 的请求体：对话框从哪个文件夹开始（输入框里已有的路径）；没给、不存在或不是文件夹就从家目录开始。 */
export interface PickFolderRequest {
  startDir?: string;
}

/** POST /api/pick-folder 的响应：选中的文件夹的绝对路径；用户点了取消（或超时）是 null。 */
export interface PickFolderResponse {
  path: string | null;
}

// ---- WebSocket：服务端 → 网页 ----

/**
 * 同一个事务里推出的几条变化按这个顺序：pm.* → project.* → conversation.created → session.created → folders.updated →
 * message.* → session.status → health.updated → schedule.*。所以网页收到某个对话的 message.created 时，那个对话一定已经有了。
 */
export const CHANGE_TYPES = [
  "message.created",
  "message.updated",
  "session.status",
  "health.updated",
  "pm.created",
  "pm.updated",
  "project.created",
  "folders.updated",
  "conversation.created",
  "session.created",
  "schedule.updated",
  "schedule.removed",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeDataMap {
  "message.created": { message: Message };
  "message.updated": { message: Message };
  "session.status": { session: SessionState };
  /** 某个模块的健康状态变了（比如“找不到 claude”），界面实时显示。 */
  "health.updated": { health: HealthEntry };
  "pm.created": { pm: Pm };
  /** 模式、名字等变了（改性格设定只改了正文也推，资料页据此重新拉 persona）。 */
  "pm.updated": { pm: Pm };
  "project.created": { project: Project };
  /** 某个项目没移除的文件夹整个换成这一份（挂、移除、建项目时）。 */
  "folders.updated": { projectId: ProjectId; folders: ProjectFolder[] };
  /** 新对话（新项目经理的那个对话；M3 起还有派活时 Worker 的对话），消息是空的。 */
  "conversation.created": { conversation: Conversation };
  /** 新会话（建项目经理时；M3 起还有派活时 Worker 的会话）。 */
  "session.created": { session: SessionState };
  /** 定时任务建了、暂停、恢复、跑过一次（M6），整行换成这一份。 */
  "schedule.updated": { schedule: ScheduleRecord };
  "schedule.removed": { scheduleId: ScheduleId };
}

/** 服务端推的一条变化：{ seq, type, data }。 */
export type Change = {
  [T in ChangeType]: { seq: number; type: T; data: ChangeDataMap[T] };
}[ChangeType];

/** since 太旧补不齐（或比当前还大，比如守护进程重启过）时推它，网页重新拉 /api/state。 */
export interface ResyncMessage {
  type: "resync";
}

export type WsServerMessage = Change | ResyncMessage;

// ---- WebSocket：网页 → 服务端（联机 P4） ----

/**
 * 网页每 30 秒（和切前台 / 后台时）报一次：在不在前台、正在看哪台设备的哪个对话。提醒设备据此跳过“正在看着”的推送。
 * 发给入口自己的那条 WebSocket（本机的），不发给转发的。deviceId 是 null = 入口本机。
 */
export interface PresenceMessage {
  type: "presence";
  visible: boolean;
  deviceId: DeviceId | null;
  conversationId: ConversationId | null;
}

export type WsClientMessage = PresenceMessage;

// ---- 联机：设备（docs/multi-device-design.md 第 3.2、4.1 节） ----

/**
 * 设备编号：每台第一次启动时生成的随机 UUID（小写，存 state/device.json），不会变。
 * 别的编号（对话、项目经理、seq）都是各台本机自增的，多设备时会撞号：网页里的键都要带设备编号。
 */
export type DeviceId = string;

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 是不是合法的设备编号。入口转发前先查，挡住 /d/../ 之类的路径。 */
export function isDeviceId(value: string): value is DeviceId {
  return DEVICE_ID_PATTERN.test(value);
}

/** 转发前缀：浏览器访问别的设备的接口用 /d/<设备编号>/api/...。 */
export const DEVICE_PROXY_PREFIX = "/d";

/** 某台设备上的接口路径。device 是 null（入口本机）就是原路径。path 是 API_PATHS 里的路径，以 / 开头。 */
export function devicePath(device: DeviceId | null, path: string): string {
  return device === null ? path : `${DEVICE_PROXY_PREFIX}/${device}${path}`;
}

/** tailscale serve 放进请求头的请求者登录名（serve 会删掉客户端自己带的同名头）。只有经 serve 进来的请求才有。 */
export const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";

/** 设备 → 设备的请求带上自己的设备编号（和 Bearer 设备令牌一起查）。 */
export const PEER_DEVICE_HEADER = "x-agent-hub-device";

/**
 * 只给浏览器用、设备令牌不能访问的接口（入口自己的：设备管理、浏览器登录、推送订阅）。新加这类接口要加进来。
 * 设备令牌也不能访问 /d/（不能借别的设备的转发去第三台）和 /auth。
 */
export const ENTRY_ONLY_API_PREFIXES: readonly string[] = ["/api/devices", "/api/sessions", "/api/login-links", "/api/push/"];

/** 入口转发的 WebSocket 因为对方连不上（握手失败、心跳没回）被关时的状态码和原因。网页按断线重连处理。 */
export const DEVICE_OFFLINE_WS_CLOSE_CODE = 4502;
export const DEVICE_OFFLINE_REASON = "device_offline";

/** GET /api/devices 里的一台。 */
export interface DeviceInfo {
  id: DeviceId;
  /** 默认是主机名，能改。 */
  name: string;
  /** 那台的 process.platform（darwin、linux……）。能做什么看那台 /api/state 的 server，不看这个。 */
  platform: string;
  /** 是不是入口本机。 */
  self: boolean;
  /** 那台的 tailnet 网址（https://<机器>.<tailnet>.ts.net），没有 Tailscale 的本机是 null。 */
  url: string | null;
}

/** GET /api/devices。在线状态不在这里：由网页到这台设备的 WebSocket 状态得出。 */
export interface DevicesResponse {
  devices: DeviceInfo[];
}

/** POST /api/devices：在已有设备上添加新设备。url 是新设备的 tailnet 网址，code 是新设备给的邀请码。 */
export interface AddDeviceRequest {
  url: string;
  code: string;
}

/** PATCH /api/devices/:id。name 按 normalizeName。 */
export interface RenameDeviceRequest {
  name: string;
}

/** POST /api/devices/invites → 201。url 是本机的 tailnet 网址（没有 Tailscale 时 null，网页提示先装）；expiresAt 是毫秒时间戳。 */
export interface DeviceInviteResponse {
  code: string;
  url: string | null;
  expiresAt: number;
}

/** 设备之间互相告知的“谁是谁”（不带令牌）。 */
export interface PeerDevice {
  id: DeviceId;
  name: string;
  platform: string;
  url: string;
}

/** POST /api/peer/pair：已有设备带着自己的身份、邀请码，和发给新设备用的设备令牌（32 字节随机，base64url）。 */
export interface PeerPairRequest {
  inviteCode: string;
  device: PeerDevice;
  token: string;
}

/** 新设备回自己的身份和发给对方用的设备令牌。双方都只存对方令牌的 sha256。 */
export interface PeerPairResponse {
  device: PeerDevice;
  token: string;
}

/** PUT /api/peer/devices：发送方已配对的全部设备（含它自己）。 */
export interface PeerDeviceListRequest {
  devices: PeerDevice[];
}

/** POST /api/peer/invites：邀请码给哪台用。 */
export interface PeerInviteRequest {
  deviceId: DeviceId;
}

/** POST /api/peer/introductions：请对方把本机介绍给它已配对的 deviceId。 */
export interface PeerIntroductionRequest {
  deviceId: DeviceId;
}

/** 那台是谁（对方记的）和它给的邀请码（10 分钟、一次性），请求方拿去那台 POST /api/peer/pair。 */
export interface PeerIntroductionResponse {
  device: PeerDevice;
  code: string;
}

// ---- 联机：推送（第 6.2 节） ----

/** GET /api/push/key。 */
export interface PushKeyResponse {
  publicKey: string;
}

/** POST /api/push/subscriptions。 */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** POST /api/push/unsubscribe。 */
export interface PushUnsubscribeRequest {
  endpoint: string;
}

/**
 * Service Worker 收到的推送内容。只带标题不带正文（用户拍板）：标题如“东京 · 项目 A：等你确定”。
 * url：点通知打开的网址（#/d/<设备>/c/<对话>）；tag：同一个对话只留最新一条。
 */
export interface PushPayload {
  title: string;
  url: string;
  tag: string;
}

// ---- 联机：浏览器登录（第 3.4 节） ----

/** 一个已登录的浏览器。时间是毫秒时间戳。 */
export interface BrowserSessionInfo {
  id: string;
  /** 登录时的 User-Agent，列表里显示成“iPhone Safari”之类。 */
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  /** 是不是发这个请求的浏览器自己。 */
  current: boolean;
}

/** GET /api/sessions，按最后活动从新到旧。 */
export interface BrowserSessionsResponse {
  sessions: BrowserSessionInfo[];
}

/** POST /api/login-links → 201。url 是入口上的完整登录链接（二维码内容），expiresAt 是毫秒时间戳。 */
export interface LoginLinkResponse {
  url: string;
  expiresAt: number;
}
