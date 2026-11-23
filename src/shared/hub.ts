import type {
  AgentRole,
  ConversationId,
  MessageId,
  PersonaChange,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  RouterItemId,
  SessionId,
  TaskGraph,
  TaskGraphId,
  TaskGraphStatus,
  TaskNodeKey,
  WorkerRecord,
  WorkerId,
} from "./domain.ts";
import type { HubFileArg } from "./deliverables.ts";
import type { WorkerCapabilityMode } from "./pm-capabilities.ts";
import type { RouterItem, RouterReportLink } from "./router.ts";
import type { SelfReloadStatus } from "./api.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import { AGENT_VENDORS, DEFAULT_AGENT_VENDOR, type AgentVendor, type VendorAvailability } from "./vendors.ts";
import { API_ERRORS } from "./errors.ts";
import { LEDGER_ERROR_HTTP_STATUS } from "./ledger.ts";
import { HUB_COMMAND } from "./names.ts";
import type { LedgerErrorCode } from "./ledger.ts";

// Agent shells reject commands containing env vars, so hub reads the token itself.
export const ENV_HUB_TOKEN = "HUB_TOKEN";
export const ENV_HUB_SOCK = "HUB_SOCK";

// Windows PowerShell 5.1 pipes text to native programs as ASCII unless $OutputEncoding says otherwise, so CJK arrives as "?".
export const POWERSHELL_UTF8_PIPE = "$OutputEncoding = [Text.UTF8Encoding]::new($false)";

export const STDIN_SHELL_NOTE = `bash、zsh 用 \`--stdin <<'EOF'\`（引号不能省）；PowerShell 用单引号 here-string 管道传入：第一行写 \`${POWERSHELL_UTF8_PIPE}; @'\`（不设编码的话，Windows PowerShell 5.1 会把中文等非 ASCII 字符变成问号），正文另起行，最后一行顶格写 \`'@ | ${HUB_COMMAND} … --stdin\`。`;

export const HUB_COMMANDS = [
  "status",
  "project.create",
  "project.attach",
  "project.detach",
  "project.setup",
  "persona.show",
  "persona.edit",
  "worker.start",
  "worker.send",
  "worker.max-time",
  "worker.end",
  "worker.list",
  "worker.show",
  "worker.log",
  "worker.search",
  "models",
  "ask",
  "ask.close",
  "schedule.add",
  "schedule.list",
  "schedule.pause",
  "schedule.resume",
  "schedule.remove",
  "router.report",
  "graph.create",
  "graph.show",
  "graph.list",
  "graph.patch",
  "graph.done",
  "graph.decide",
  "graph.skip",
  "graph.cancel",
  "graph.finish",
] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

export const HUB_COMMAND_ROLES: Readonly<Record<HubCommand, readonly AgentRole[]>> = {
  status: ["pm", "worker"],
  "project.create": ["pm"],
  "project.attach": ["pm"],
  "project.detach": ["pm"],
  "project.setup": ["pm"],
  "persona.show": ["pm"],
  "persona.edit": ["pm"],
  "worker.start": ["pm"],
  "worker.send": ["pm"],
  "worker.max-time": ["pm"],
  "worker.end": ["pm"],
  "worker.list": ["pm"],
  "worker.show": ["pm"],
  "worker.log": ["pm"],
  "worker.search": ["pm"],
  models: ["pm"],
  ask: ["pm"],
  "ask.close": ["pm"],
  "schedule.add": ["pm"],
  "schedule.list": ["pm"],
  "schedule.pause": ["pm"],
  "schedule.resume": ["pm"],
  "schedule.remove": ["pm"],
  "router.report": ["pm"],
  "graph.create": ["pm"],
  "graph.show": ["pm"],
  "graph.list": ["pm"],
  "graph.patch": ["pm"],
  "graph.done": ["pm"],
  "graph.decide": ["pm"],
  "graph.skip": ["pm"],
  "graph.cancel": ["pm"],
  "graph.finish": ["pm"],
};

export function hubCommandAllowed(role: AgentRole, command: HubCommand): boolean {
  return HUB_COMMAND_ROLES[command].includes(role);
}

export const SELF_RELOAD_AGENT_PATH = "/v1/self.reload";
export const SELF_RELOAD_UNSUPPORTED_MESSAGE = "这台守护进程不是由 Bellwood 应用或 systemd 拉起的，退出后没人自动重启，不能热重启；请手动重启";

export function hubPath(command: HubCommand): string {
  return `/v1/${command}`;
}

export interface HubArgsMap {
  status: Record<string, never>;
  "project.create": { folder: string; name?: string; description?: string };
  "project.attach": { folder: string };
  "project.detach": { folder: string };
  "project.setup": { command: string | null };
  "persona.show": Record<string, never>;
  "persona.edit": { text?: string; mode?: PmMode; reason?: string };
  "worker.start": {
    title?: string;
    task?: string;
    vendor?: AgentVendor;
    model?: string;
    effort?: string;
    maxTimeMs?: number;
    readonly?: boolean;
    caps?: WorkerCapabilityMode;
    allow?: string[];
    noWorktree?: boolean;
    node?: TaskNodeKey;
    graphId?: TaskGraphId;
  };
  "worker.send": { workerId: WorkerId; text: string; maxTimeMs?: number };
  "worker.max-time": { workerId: WorkerId; maxTimeMs: number };
  "worker.end": { workerId: WorkerId };
  "worker.list": Record<string, never>;
  "worker.show": { workerId: WorkerId; task?: boolean; report?: number | "latest" };
  "worker.search": { keywords: string[]; limit?: number };
  "worker.log": { workerId: WorkerId; last?: number; stats?: boolean };
  models: { vendor?: AgentVendor; refresh?: boolean };
  ask: {
    text: string;
    options?: string[];
    recommended?: string;
    node?: TaskNodeKey;
    graphId?: TaskGraphId;
    replaceItemId?: RouterItemId;
    files?: HubFileArg[];
  };
  "ask.close": { itemId: RouterItemId };
  "schedule.add": { name: string; prompt: string; daily?: string; everyMinutes?: number };
  "schedule.list": Record<string, never>;
  "schedule.pause": { scheduleId: ScheduleId };
  "schedule.resume": { scheduleId: ScheduleId };
  "schedule.remove": { scheduleId: ScheduleId };
  "router.report": {
    summary: string;
    links?: RouterReportLink[];
    files?: HubFileArg[];
  };
  "graph.create": {
    title?: string;
    specJson: string;
  };
  "graph.show": {
    graphId?: TaskGraphId;
  };
  "graph.list": {
    all?: boolean;
    status?: TaskGraphStatus;
  };
  "graph.patch": {
    graphId?: TaskGraphId;
    specJson: string;
  };
  "graph.done": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    prUrl?: string;
    commit?: string;
    branch?: string;
    summary?: string;
    note?: string;
  };
  "graph.decide": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    choice: string;
    note?: string;
  };
  "graph.skip": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    reason?: string;
  };
  "graph.cancel": {
    graphId?: TaskGraphId;
    reason?: string;
  };
  "graph.finish": {
    graphId?: TaskGraphId;
    unmergedOk?: boolean;
    summary: string;
  };
}

export interface CreateTaskGraphNodeInput {
  key: TaskNodeKey;
  title: string;
  brief?: string;
  vendor?: AgentVendor;
  model?: string;
  effort?: string;
  maxTime?: string | number;
  readonly?: boolean;
  caps?: WorkerCapabilityMode;
  allow?: string[];
  confirm?: boolean;
  review?: boolean;
  base?: string;
  deps?: TaskNodeKey[];
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}

export type CreateTaskGraphStepInput = CreateTaskGraphNodeInput;

export interface CreateTaskGraphEdgeInput {
  from: TaskNodeKey;
  to: TaskNodeKey;
}

export interface CreateTaskGraphSpecInput {
  title?: string;
  goal?: string;
  originMsgId?: MessageId;
  steps?: CreateTaskGraphStepInput[];
  nodes?: CreateTaskGraphNodeInput[];
  edges?: CreateTaskGraphEdgeInput[];
}

export interface PatchTaskGraphNodeInput {
  key: TaskNodeKey;
  title?: string;
  brief?: string | null;
  vendor?: AgentVendor | null;
  model?: string | null;
  effort?: string | null;
  maxTime?: string | number | null;
  readonly?: boolean;
  caps?: WorkerCapabilityMode | null;
  allow?: string[];
  confirm?: boolean;
  review?: boolean;
  base?: string | null;
  deps?: TaskNodeKey[];
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}

export type PatchTaskGraphStepInput = PatchTaskGraphNodeInput;

export interface PatchTaskGraphSpecInput {
  title?: string;
  goal?: string | null;
  addSteps?: CreateTaskGraphStepInput[];
  updateSteps?: PatchTaskGraphStepInput[];
  removeSteps?: TaskNodeKey[];
  skipSteps?: TaskNodeKey[];
  addNodes?: CreateTaskGraphNodeInput[];
  updateNodes?: PatchTaskGraphNodeInput[];
  removeNodes?: TaskNodeKey[];
  skipNodes?: TaskNodeKey[];
  addEdges?: CreateTaskGraphEdgeInput[];
  removeEdges?: CreateTaskGraphEdgeInput[];
}

export const ASK_CARD_WHERE = "卡片显示在对话里，用户直接在卡上点选；没回答时右栏和总助也会列出，回答后自动移走";
export const ASK_CARD_TELL_USER = "跟用户说“卡在上面，直接点选”，别让用户去右栏找";

const EXAMPLE_REVIEW_VENDOR = AGENT_VENDORS.find((vendor) => vendor !== DEFAULT_AGENT_VENDOR) ?? DEFAULT_AGENT_VENDOR;
export const TASK_GRAPH_CREATE_JSON_HINT =
  `{"title":"…","goal":"…","steps":[{"key":"impl","title":"…","brief":"…"},{"key":"review","title":"…","brief":"…","review":true,"vendor":"${EXAMPLE_REVIEW_VENDOR}"}]}`;

export const TASK_GRAPH_PATCH_JSON_HINT =
  '{"goal":"…","addSteps":[{"key":"qa","title":"…","brief":"…","deps":["review"]}],"updateSteps":[{"key":"review","brief":"…"}],"removeSteps":["old"],"skipSteps":["polish"]}';

export type HubArgs<C extends HubCommand> = HubArgsMap[C];

export interface ProjectCard {
  id: ProjectId;
  name: string;
  description: string | null;
  mainFolder: string;
  otherFolders: string[];
}

export interface PmActiveGraphSummary {
  id: TaskGraphId;
  title: string;
  totalNodes: number;
  doneCount: number;
  runningCount: number;
  waitingPmCount: number;
  waitingUserCount: number;
  readyToFinish: boolean;
}

interface PmHubStatus {
  role: "pm";
  pm: { id: PmId; name: string; mode: PmMode };
  sessionId: SessionId;
  conversationId: ConversationId;
  project: ProjectCard | null;
  setupCommand: string | null;
  activeTaskGraphs?: PmActiveGraphSummary[];
  selfReload?: SelfReloadStatus;
}

export interface WorkerHubStatusUpstream {
  key: TaskNodeKey;
  title: string;
  skipped: boolean;
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  reportFile: string | null;
}

export interface WorkerHubStatus {
  role: "worker";
  pm: { id: PmId; name: string };
  sessionId: SessionId;
  conversationId: ConversationId;
  worker: WorkerRecord;
  project: ProjectCard;
  taskGraph?: {
    id: TaskGraphId;
    title: string;
    goal: string | null;
    stepKey: TaskNodeKey;
    stepTitle: string;
    stepIndex: number;
    totalSteps: number;
    brief: string | null;
    upstream: WorkerHubStatusUpstream[];
  };
}

export interface WorkerSearchHit {
  workerId: WorkerId;
  title: string;
  status: string;
  where: "title" | "task" | "report";
  report?: number;
  snippet: string;
}

export interface WorkerLogStep {
  at: number;
  kind: "tool" | "thinking" | "text" | "turn_ended";
  text: string;
}

export interface WorkerPr {
  number: number;
  state: string;
  url: string;
}

export type WorkerPrProbeResult = WorkerPr | { unavailable: string } | null;

interface HubModelEntry {
  id: string;
  label: string;
  efforts: string[];
}

export interface HubVendorModels {
  vendor: AgentVendor;
  label: string;
  source: "vendor" | "bundled";
  availability: VendorAvailability;
  defaultModel: string | null;
  defaultModelId: string | null;
  defaultEffort: string | null;
  defaultEfforts: string[];
  efforts: string[];
  effortLabels?: Record<string, string>;
  models: HubModelEntry[];
}

interface HubDataMap {
  status: PmHubStatus | WorkerHubStatus;
  "project.create": { project: Project; mainFolder: ProjectFolder };
  "project.attach": { project: Project; folder: ProjectFolder };
  "project.detach": { project: Project; folder: ProjectFolder };
  "project.setup": { project: Project; setupCommand: string | null };
  "persona.show": { text: string; mode: PmMode };
  "persona.edit": { change: PersonaChange | null };
  "worker.start": { worker: WorkerRecord };
  "worker.send": { worker: WorkerRecord; messageId: MessageId };
  "worker.max-time": { worker: WorkerRecord; maxTimeMs: number };
  "worker.end": { worker: WorkerRecord };
  "worker.list": { workers: WorkerRecord[] };
  "worker.show": { worker: WorkerRecord };
  "worker.log": { worker: WorkerRecord; steps: WorkerLogStep[] };
  "worker.search": { hits: WorkerSearchHit[] };
  models: { vendors: HubVendorModels[] };
  ask: { messageId: MessageId; graph?: TaskGraph; item?: RouterItem };
  "ask.close": { item: RouterItem };
  "schedule.add": { schedule: ScheduleRecord };
  "schedule.list": { schedules: ScheduleRecord[] };
  "schedule.pause": { schedule: ScheduleRecord };
  "schedule.resume": { schedule: ScheduleRecord };
  "schedule.remove": { schedule: ScheduleRecord };
  "router.report": { item: RouterItem };
  "graph.create": { graph: TaskGraph };
  "graph.show": { graph: TaskGraph };
  "graph.list": { graphs: TaskGraph[] };
  "graph.patch": { graph: TaskGraph };
  "graph.done": { graph: TaskGraph };
  "graph.decide": { graph: TaskGraph };
  "graph.skip": { graph: TaskGraph };
  "graph.cancel": { graph: TaskGraph };
  "graph.finish": { graph: TaskGraph; reportItem: RouterItem };
}

export type HubData<C extends HubCommand> = HubDataMap[C];

export interface HubResult<C extends HubCommand> {
  text: string;
  data: HubData<C>;
}

export type HubErrorCode = LedgerErrorCode | "unauthorized" | "internal" | "shutting_down";

export const HUB_ERROR_HTTP_STATUS: Readonly<Record<HubErrorCode, number>> = {
  ...LEDGER_ERROR_HTTP_STATUS,
  unauthorized: API_ERRORS.unauthorized.status,
  internal: API_ERRORS.internal.status,
  shutting_down: API_ERRORS.shutting_down.status,
};

export type HubResponse<C extends HubCommand = HubCommand> =
  | { ok: true; text: string; data: HubData<C> }
  | { ok: false; code: HubErrorCode; message: string };

export const HUB_EXIT = { ok: 0, rejected: 1, usage: 2, unreachable: 3, internal: 4 } as const;

export const HUB_TOKEN_BYTES = 32;

// issue() must return the existing token: prepareLaunch runs repeatedly and a fresh token would invalidate the live process.
export interface SessionTokens {
  issue(sessionId: SessionId): string;
  resolve(token: string): SessionId | null;
  revoke(sessionId: SessionId): void;
}

export class SessionTokenRevokedError extends Error {
  constructor(sessionId: SessionId) {
    super(`session ${sessionId} token was revoked; no new token is issued`);
    this.name = "SessionTokenRevokedError";
  }
}
