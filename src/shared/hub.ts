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
  TaskNode,
  TaskNodeKey,
  WorkerRecord,
  WorkerId,
} from "./domain.ts";
import type { HubFileArg } from "./deliverables.ts";
import type { HubCapsArgs, HubCapsData } from "./hub-caps.ts";
import type { HubChecklistRequest } from "./hub-checklist.ts";
import type { WorkerCapabilityMode } from "./pm-capabilities.ts";
import type { RouterItem, RouterReportLink } from "./router.ts";
import { hubLimitMaximum } from "./hub-limits.ts";
import type { SelfReloadStatus } from "./api.ts";
import type { AskDetail, PendingAsk } from "./pending-asks.ts";
import type { PmWatchId, PmWatchRecord } from "./pm-watch.ts";
import type { ScheduleId, ScheduleRecord, ScheduleRunSummary } from "./schedule.ts";
import type { AgentVendor, VendorAvailability } from "./vendors.ts";
import { API_ERRORS } from "./errors.ts";
import { LEDGER_ERROR_HTTP_STATUS } from "./ledger.ts";
import { HUB_COMMAND } from "./names.ts";
import type { LedgerErrorCode } from "./ledger.ts";

export { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "./hub-env.ts";

// Windows PowerShell 5.1 pipes text to native programs as ASCII unless $OutputEncoding says otherwise, so CJK arrives as "?".
export const POWERSHELL_UTF8_PIPE = "$OutputEncoding = [Text.UTF8Encoding]::new($false)";

export const STDIN_SHELL_NOTE = `bash、zsh 用 \`--stdin <<'EOF'\`（引号不能省）；PowerShell 用单引号 here-string 管道传入：第一行写 \`${POWERSHELL_UTF8_PIPE}; @'\`（不设编码的话，Windows PowerShell 5.1 会把中文等非 ASCII 字符变成问号），正文另起行，最后一行顶格写 \`'@ | ${HUB_COMMAND} … --stdin\`。`;

export const HUB_COMMANDS = [
  "status",
  "checklist",
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
  "caps",
  "ask",
  "ask.close",
  "ask.list",
  "ask.show",
  "schedule.add",
  "schedule.list",
  "schedule.show",
  "schedule.edit",
  "schedule.pause",
  "schedule.resume",
  "schedule.remove",
  "watch.add",
  "watch.list",
  "watch.close",
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
  checklist: ["pm", "worker"],
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
  caps: ["pm"],
  ask: ["pm"],
  "ask.close": ["pm"],
  "ask.list": ["pm"],
  "ask.show": ["pm"],
  "schedule.add": ["pm"],
  "schedule.list": ["pm"],
  "schedule.show": ["pm"],
  "schedule.edit": ["pm"],
  "schedule.pause": ["pm"],
  "schedule.resume": ["pm"],
  "schedule.remove": ["pm"],
  "watch.add": ["pm"],
  "watch.list": ["pm"],
  "watch.close": ["pm"],
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

/**
 * Commands documented in `hub help` but not in the system prompt, so adding them never changes a live session's cached prefix.
 * Each value is the hint printed in the output where the PM needs that command; the producer of that output must print it verbatim.
 */
export const HUB_HELP_ONLY_COMMANDS = {
  caps: `查看可用外接能力：${HUB_COMMAND} caps`,
  "ask.list": `看全部在等用户的卡：${HUB_COMMAND} ask list`,
  "ask.show": `看全文：${HUB_COMMAND} ask show <编号>`,
  "schedule.show": `看全文和最近几次结果：${HUB_COMMAND} schedule show <编号>`,
  "schedule.edit": `原地修改：${HUB_COMMAND} schedule edit <编号> [--name <名>] [--daily HH:MM | --every 30m|2h] [--stdin]`,
  "watch.add": `要等外部条件（比如检查通过）再动手，用 ${HUB_COMMAND} watch add 让后台盯着，结果出来叫醒你（用法见 ${HUB_COMMAND} help）。`,
  "watch.list": `看在盯的条件：${HUB_COMMAND} watch list`,
  "watch.close": `不用再盯了：${HUB_COMMAND} watch close <编号>`,
} as const satisfies Partial<Record<HubCommand, string>>;

export type HubHelpOnlyCommand = keyof typeof HUB_HELP_ONLY_COMMANDS;

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
  checklist: HubChecklistRequest;
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
    effort?: string | null;
    maxTimeMs?: number;
    readonly?: boolean;
    caps?: WorkerCapabilityMode;
    allow?: string[];
    noWorktree?: boolean;
    noOuterSandbox?: boolean;
    node?: TaskNodeKey;
    graphId?: TaskGraphId;
  };
  "worker.send": { workerId: WorkerId; text: string; maxTimeMs?: number };
  "worker.max-time": { workerId: WorkerId; maxTimeMs: number };
  "worker.end": { workerId: WorkerId };
  "worker.list": { vendor?: AgentVendor };
  "worker.show": { workerId: WorkerId; task?: boolean; report?: number | "latest" };
  "worker.search": { keywords: string[]; limit?: number };
  "worker.log": { workerId: WorkerId; last?: number; stats?: boolean };
  models: { vendor?: AgentVendor; refresh?: boolean };
  caps: HubCapsArgs;
  ask: {
    text: string;
    options?: string[];
    recommended?: string;
    node?: TaskNodeKey;
    graphId?: TaskGraphId;
    replaceItemId?: RouterItemId;
    files?: HubFileArg[];
  };
  "ask.close": { itemId: RouterItemId } | { messageId: MessageId };
  "ask.list": Record<string, never>;
  "ask.show": { itemId: RouterItemId } | { messageId: MessageId };
  "schedule.add": { name: string; prompt: string; daily?: string; everyMinutes?: number };
  "schedule.list": Record<string, never>;
  "schedule.show": { scheduleId: ScheduleId };
  "schedule.edit": { scheduleId: ScheduleId; name?: string; prompt?: string; daily?: string; everyMinutes?: number };
  "schedule.pause": { scheduleId: ScheduleId };
  "schedule.resume": { scheduleId: ScheduleId };
  "schedule.remove": { scheduleId: ScheduleId };
  "watch.add": {
    until?: string;
    everyMs?: number;
    afterMs?: number;
    maxMs?: number;
    graphId?: TaskGraphId;
    workerId?: WorkerId;
    body: string;
  };
  "watch.list": Record<string, never>;
  "watch.close": { watchId: PmWatchId };
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
  noOuterSandbox?: boolean;
  caps?: WorkerCapabilityMode;
  allow?: string[];
  confirm?: boolean;
  review?: boolean;
  base?: string;
  slot?: string;
  deps?: TaskNodeKey[];
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
  noOuterSandbox?: boolean;
  caps?: WorkerCapabilityMode | null;
  allow?: string[];
  confirm?: boolean;
  review?: boolean;
  base?: string | null;
  slot?: string | null;
  deps?: TaskNodeKey[];
}

export type PatchTaskGraphStepInput = PatchTaskGraphNodeInput;

export interface PatchTaskGraphSpecInput {
  title?: string;
  goal?: string | null;
  addSteps?: CreateTaskGraphStepInput[];
  updateSteps?: PatchTaskGraphStepInput[];
  removeSteps?: TaskNodeKey[];
  skipSteps?: TaskNodeKey[];
  doneSteps?: TaskNodeKey[];
  addNodes?: CreateTaskGraphNodeInput[];
  updateNodes?: PatchTaskGraphNodeInput[];
  removeNodes?: TaskNodeKey[];
  skipNodes?: TaskNodeKey[];
  addEdges?: CreateTaskGraphEdgeInput[];
  removeEdges?: CreateTaskGraphEdgeInput[];
}

export const ASK_CARD_WHERE = "卡片显示在对话里，用户直接在卡上点选；没回答时右栏和总助也会列出，回答后自动移走";
export const ASK_CARD_TELL_USER = "跟用户说“卡在上面，直接点选”，别让用户去右栏找";

const EXAMPLE_BRIEF = `…（最多 ${hubLimitMaximum("step.brief")}）`;
export const TASK_GRAPH_CREATE_JSON_HINT =
  `{"title":"…","goal":"…","steps":[{"key":"step1","title":"…","brief":"${EXAMPLE_BRIEF}"},{"key":"step2","title":"…","brief":"${EXAMPLE_BRIEF}"}]}`;

export const TASK_GRAPH_PATCH_JSON_HINT =
  `{"goal":"…","addSteps":[{"key":"step3","title":"…","brief":"${EXAMPLE_BRIEF}","deps":["step2"]}],"updateSteps":[{"key":"step2","brief":"${EXAMPLE_BRIEF}"}],"removeSteps":["old"],"skipSteps":["optional"],"doneSteps":[]}`;

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

export interface HubVendorQuotaWindow {
  id: string;
  label: string;
  utilization: number;
  resetsAt: number | null;
}

export interface HubVendorQuota {
  status: "ok" | "limited";
  source: "observed" | "fetched" | "rate_limit";
  resetsAt: number | null;
  observedAt: number;
  reason: string | null;
  windows?: readonly HubVendorQuotaWindow[];
}

export interface HubVendorModels {
  vendor: AgentVendor;
  label: string;
  source: "vendor" | "bundled";
  availability: VendorAvailability;
  quota?: HubVendorQuota;
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
  checklist: null;
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
  caps: HubCapsData;
  ask: { messageId: MessageId; graph?: TaskGraph; item?: RouterItem };
  "ask.close": { item: RouterItem } | { messageId: MessageId };
  "ask.list": { asks: PendingAsk[] };
  "ask.show": { ask: AskDetail };
  "schedule.add": { schedule: ScheduleRecord };
  "schedule.list": { schedules: ScheduleRecord[] };
  "schedule.show": { schedule: ScheduleRecord; runs: ScheduleRunSummary[] };
  "schedule.edit": { schedule: ScheduleRecord };
  "schedule.pause": { schedule: ScheduleRecord };
  "schedule.resume": { schedule: ScheduleRecord };
  "schedule.remove": { schedule: ScheduleRecord };
  "watch.add": { watch: PmWatchRecord };
  "watch.list": { watches: PmWatchRecord[] };
  "watch.close": { watch: PmWatchRecord };
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

/** A step that `worker start --node` put in line for its slot instead of starting a Worker. */
export interface StepSlotQueueReceipt extends NonNullable<TaskNode["slotQueue"]> {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  slot: string;
}

export interface HubResult<C extends HubCommand> {
  text: string;
  data: HubData<C>;
}

/**
 * `worker start --node` on a step whose slot is held puts the step in line instead of starting a Worker.
 * Callers that read `data.worker` from a `--node` start must check for null.
 */
export interface WorkerStartQueuedResult {
  text: string;
  data: { worker: null; slotQueue: StepSlotQueueReceipt };
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
