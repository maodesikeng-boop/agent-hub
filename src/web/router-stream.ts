// Router 时间流选择器与多源水位线合并（docs/router-workbench-v2-design.md 第 5 节）：
// 按 state.router.items -> state.router.commands -> state.pms -> state.projects 四级 WeakMap 缓存，
// 流式会话更新零重算、单条指令或简报变更时其余条目对象引用保持严格 ===。
import {
  type Attachment,
  type ConversationId,
  type Pm,
  type PmId,
  type Project,
  type ProjectId,
  type RouterCommandRecord,
  type RouterCommandStatus,
  type RouterItem,
  type RouterReportItem,
} from "../shared/index.ts";
import { deviceKeyOf } from "./devices.ts";
import type { HubState } from "./state.ts";

type RouterDispatchOp = NonNullable<RouterCommandRecord["dispatched"]>[number]["op"];

/** 后端契约 PR 在 RouterAgentPlan 上新增的可选字段（网页按结构兼容读取，不改 shared/router.ts）。 */
export interface RouterPlanExtras {
  attachments?: readonly { id: string; name: string; mime?: string; size: number }[];
  replyTruncated?: boolean;
  errorRaw?: string;
}

export interface RouterTurnDestination {
  key: string;
  deviceKey: string;
  deviceName: string;
  self: boolean;
  worker: boolean;
  conversationId: ConversationId;
  name: string;
  projectName: string | null;
  avatarKey: number;
  opLabel: string | null;
}

export interface RouterTurnEntry {
  kind: "turn";
  key: string;
  clientId: string;
  createdAt: number;
  inputText: string;
  attachments: Attachment[];
  status: RouterCommandStatus | "sending" | "send_failed";
  unsentError?: unknown;
  command: RouterCommandRecord | null;
  destinations: readonly RouterTurnDestination[];
  /** 近窗里的条目（true）失败时允许原地 Retry；翻历史翻出来的旧条目（false）只读展示原因。 */
  live: boolean;
}

export interface RouterBriefingEntry {
  kind: "briefing";
  key: string;
  createdAt: number;
  report: RouterReportItem;
  deviceKey: string;
  deviceName: string;
  self: boolean;
  pmName: string;
  projectName: string | null;
  avatarKey: number;
  live: boolean;
}

export type RouterStreamEntry = RouterTurnEntry | RouterBriefingEntry;

export interface RouterDeviceBriefings {
  key: string;
  name: string;
  self: boolean;
  online: boolean;
  briefings: readonly RouterBriefingEntry[];
  oldestCursor: string | null;
  liveReportCount: number;
  pmById: ReadonlyMap<PmId, Pm>;
  projectById: ReadonlyMap<ProjectId, Project>;
}

export interface DeviceRouterStreamSlice {
  commands: readonly RouterCommandRecord[];
  oldestCommandCursor: string | null;
  liveCommandCount: number;
  reports: readonly RouterReportItem[];
  oldestReportCursor: string | null;
  liveReportCount: number;
  pmById: ReadonlyMap<PmId, Pm>;
  projectById: ReadonlyMap<ProjectId, Project>;
}

export interface RouterStreamDeviceInput {
  key: string;
  name: string;
  self: boolean;
  online: boolean;
  state: HubState;
}

export interface FleetRouterStream {
  turns: readonly RouterTurnEntry[];
  oldestCommandCursor: string | null;
  liveCommandCount: number;
  devices: readonly RouterDeviceBriefings[];
  multiDevice: boolean;
}

export interface RouterStreamItemBase {
  createdAt: number;
  key: string;
  kind?: string;
}

export interface RouterStreamSource<out T extends RouterStreamItemBase = RouterStreamEntry> {
  readonly entries: readonly T[];
  /** 这个来源当前已覆盖到的最早毫秒时间戳；已翻到头或无需拦水位时是 null。 */
  readonly loadedDownTo: number | null;
  readonly hasMore: boolean;
}

const NO_ATTACHMENTS: Attachment[] = [];
const NO_DESTINATIONS: readonly RouterTurnDestination[] = [];
const NO_TURNS: readonly RouterTurnEntry[] = [];
const NO_BRIEFINGS: readonly RouterBriefingEntry[] = [];

function opLabelOf(op: RouterDispatchOp | undefined): string | null {
  switch (op) {
    case "worker.start":
      return "Started";
    case "worker.stop":
      return "Paused";
    case "worker.end":
      return "Ended";
    case "project.create":
      return "Created";
    default:
      return null;
  }
}

function attachmentsFromPlan(plan: RouterCommandRecord["plan"]): Attachment[] {
  const raw = (plan as (RouterCommandRecord["plan"] & RouterPlanExtras) | null)?.attachments;
  if (!raw || raw.length === 0) return NO_ATTACHMENTS;
  return raw.map((a) => ({
    id: a.id,
    name: a.name,
    mime: a.mime ?? "application/octet-stream",
    size: a.size,
    path: "",
  }));
}

function buildDestinations(command: RouterCommandRecord, selfId: string | undefined): readonly RouterTurnDestination[] {
  const list = command.dispatched;
  if (!list || list.length === 0) return NO_DESTINATIONS;
  const out: RouterTurnDestination[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i]!;
    if (!d.ok) continue;
    const worker = d.workerConversationId !== undefined;
    const conversationId = d.workerConversationId ?? d.conversationId;
    if (conversationId === undefined) continue;
    const deviceKey = deviceKeyOf(d.deviceId === "local" ? undefined : d.deviceId, selfId ?? null);
    const self = deviceKey === "";
    const name = worker
      ? (d.title ?? d.pmName ?? `Piece #${d.workerId ?? conversationId}`)
      : (d.pmName ?? `#${d.pmId}`);
    out.push({
      key: `${deviceKey || "local"}:${worker ? "w" : "c"}:${conversationId}:${i}`,
      deviceKey,
      deviceName: d.deviceName ?? "",
      self,
      worker,
      conversationId,
      name,
      projectName: d.projectName ?? null,
      avatarKey: d.pmId,
      opLabel: opLabelOf(d.op),
    });
  }
  return out.length === 0 ? NO_DESTINATIONS : out;
}

/** 失败回合能不能在原地出 Retry：有明确 retryOps，或者一条都没投出去时才允许重试。 */
export function canRetryCommand(command: RouterCommandRecord): boolean {
  const hasRetryOps = Array.isArray(command.plan?.retryOps) && command.plan.retryOps.length > 0;
  const anySucceeded = (command.dispatched ?? []).some((d) => d.ok);
  return hasRetryOps || !anySucceeded;
}

const turnEntryLiveCache = new WeakMap<RouterCommandRecord, Map<string, RouterTurnEntry>>();
const turnEntryHistoryCache = new WeakMap<RouterCommandRecord, Map<string, RouterTurnEntry>>();

/** 把单条 RouterCommandRecord 转成时间流回合条目；按记录对象与 selfId 做 WeakMap 缓存，单条更新不波及其他回合。 */
export function turnEntryOfCommand(command: RouterCommandRecord, selfId: string | undefined, live: boolean): RouterTurnEntry {
  const cache = live ? turnEntryLiveCache : turnEntryHistoryCache;
  const selfKey = selfId ?? "";
  let bySelf = cache.get(command);
  if (bySelf === undefined) {
    bySelf = new Map();
    cache.set(command, bySelf);
  }
  const hit = bySelf.get(selfKey);
  if (hit !== undefined) return hit;

  const clientKey = command.clientId || `id-${command.id}`;
  const entry: RouterTurnEntry = {
    kind: "turn",
    key: `turn:${clientKey}`,
    clientId: command.clientId,
    createdAt: command.createdAt,
    inputText: command.inputText,
    attachments: attachmentsFromPlan(command.plan),
    status: command.status,
    command,
    destinations: buildDestinations(command, selfId),
    live,
  };
  bySelf.set(selfKey, entry);
  return entry;
}

const briefingEntryCache = new WeakMap<RouterReportItem, RouterBriefingEntry>();

/** 把单条 RouterReportItem 转成时间流简报条目；按记录对象缓存，并在 PM / 项目 / 设备改名时即时失效重建。 */
export function briefingEntryOfReport(
  report: RouterReportItem,
  ctx: {
    deviceKey: string;
    deviceName: string;
    self: boolean;
    pmById: ReadonlyMap<PmId, Pm>;
    projectById: ReadonlyMap<ProjectId, Project>;
    live: boolean;
  },
): RouterBriefingEntry | null {
  const pm = ctx.pmById.get(report.pmId);
  if (pm?.archivedAt != null) return null;
  const proj = report.projectId === null ? undefined : ctx.projectById.get(report.projectId);
  const pmName = pm?.name ?? `#${report.pmId}`;
  const projectName = proj?.name ?? null;
  const hit = briefingEntryCache.get(report);
  if (
    hit !== undefined &&
    hit.deviceKey === ctx.deviceKey &&
    hit.deviceName === ctx.deviceName &&
    hit.self === ctx.self &&
    hit.pmName === pmName &&
    hit.projectName === projectName &&
    hit.live === ctx.live
  ) {
    return hit;
  }
  const entry: RouterBriefingEntry = {
    kind: "briefing",
    key: `briefing:${ctx.deviceKey || "local"}:${report.id}`,
    createdAt: report.createdAt,
    report,
    deviceKey: ctx.deviceKey,
    deviceName: ctx.deviceName,
    self: ctx.self,
    pmName,
    projectName,
    avatarKey: report.pmId,
    live: ctx.live,
  };
  briefingEntryCache.set(report, entry);
  return entry;
}

interface CommandsSlice {
  commands: readonly RouterCommandRecord[];
  oldestCommandCursor: string | null;
  liveCommandCount: number;
}

interface ReportsSlice {
  reports: readonly RouterReportItem[];
  oldestReportCursor: string | null;
  liveReportCount: number;
  pmById: ReadonlyMap<PmId, Pm>;
  projectById: ReadonlyMap<ProjectId, Project>;
}

const commandsSliceCache = new WeakMap<HubState["router"]["commands"], CommandsSlice>();
const reportsSliceCache = new WeakMap<
  HubState["router"]["items"],
  WeakMap<HubState["pms"], WeakMap<HubState["projects"], ReportsSlice>>
>();
const deviceStreamCache = new WeakMap<CommandsSlice, WeakMap<ReportsSlice, DeviceRouterStreamSlice>>();

function commandsSliceOf(rawCommands: HubState["router"]["commands"]): CommandsSlice {
  const hit = commandsSliceCache.get(rawCommands);
  if (hit !== undefined) return hit;
  let oldestCmd: RouterCommandRecord | null = null;
  const commands: RouterCommandRecord[] = [];
  for (const cmd of rawCommands) {
    if (
      oldestCmd === null ||
      cmd.createdAt < oldestCmd.createdAt ||
      (cmd.createdAt === oldestCmd.createdAt && cmd.id < oldestCmd.id)
    ) {
      oldestCmd = cmd;
    }
    if (cmd.status !== "cancelled") commands.push(cmd);
  }
  commands.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const slice: CommandsSlice = {
    commands,
    oldestCommandCursor: oldestCmd ? `${oldestCmd.createdAt}:${oldestCmd.id}` : null,
    liveCommandCount: rawCommands.length,
  };
  commandsSliceCache.set(rawCommands, slice);
  return slice;
}

function reportsSliceOf(state: HubState): ReportsSlice {
  let byPms = reportsSliceCache.get(state.router.items);
  if (byPms === undefined) {
    byPms = new WeakMap();
    reportsSliceCache.set(state.router.items, byPms);
  }
  let byProjects = byPms.get(state.pms);
  if (byProjects === undefined) {
    byProjects = new WeakMap();
    byPms.set(state.pms, byProjects);
  }
  const hit = byProjects.get(state.projects);
  if (hit !== undefined) return hit;

  const pmById = new Map<PmId, Pm>();
  for (const pm of state.pms) pmById.set(pm.id, pm);
  const projectById = new Map<ProjectId, Project>();
  for (const proj of state.projects) projectById.set(proj.id, proj);

  let oldestRep: RouterReportItem | null = null;
  let liveReportCount = 0;
  const reports: RouterReportItem[] = [];
  for (const item of state.router.items) {
    if (item.kind !== "report") continue;
    liveReportCount++;
    if (
      oldestRep === null ||
      item.createdAt < oldestRep.createdAt ||
      (item.createdAt === oldestRep.createdAt && item.id < oldestRep.id)
    ) {
      oldestRep = item;
    }
    if (pmById.get(item.pmId)?.archivedAt != null) continue;
    reports.push(item);
  }
  reports.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

  const slice: ReportsSlice = {
    reports,
    oldestReportCursor: oldestRep ? `${oldestRep.createdAt}:${oldestRep.id}` : null,
    liveReportCount,
    pmById,
    projectById,
  };
  byProjects.set(state.projects, slice);
  return slice;
}

/** 单台设备的近窗时间流切片（按旧→新排好指令与简报，记住各自最旧一条的分页游标）。 */
export function routerStreamOf(state: HubState): DeviceRouterStreamSlice {
  const cSlice = commandsSliceOf(state.router.commands);
  const rSlice = reportsSliceOf(state);
  let byReports = deviceStreamCache.get(cSlice);
  if (byReports === undefined) {
    byReports = new WeakMap();
    deviceStreamCache.set(cSlice, byReports);
  }
  const hit = byReports.get(rSlice);
  if (hit !== undefined) return hit;

  const slice: DeviceRouterStreamSlice = {
    commands: cSlice.commands,
    oldestCommandCursor: cSlice.oldestCommandCursor,
    liveCommandCount: cSlice.liveCommandCount,
    reports: rSlice.reports,
    oldestReportCursor: rSlice.oldestReportCursor,
    liveReportCount: rSlice.liveReportCount,
    pmById: rSlice.pmById,
    projectById: rSlice.projectById,
  };
  byReports.set(rSlice, slice);
  return slice;
}

const turnsByCommandsCache = new WeakMap<readonly RouterCommandRecord[], Map<string, readonly RouterTurnEntry[]>>();

function liveTurnsOf(commands: readonly RouterCommandRecord[], selfId: string | undefined): readonly RouterTurnEntry[] {
  if (commands.length === 0) return NO_TURNS;
  const selfKey = selfId ?? "";
  let bySelf = turnsByCommandsCache.get(commands);
  if (bySelf === undefined) {
    bySelf = new Map();
    turnsByCommandsCache.set(commands, bySelf);
  }
  const hit = bySelf.get(selfKey);
  if (hit !== undefined) return hit;
  const turns = commands.map((cmd) => turnEntryOfCommand(cmd, selfId, true));
  bySelf.set(selfKey, turns);
  return turns;
}

const briefingsByReportsCache = new WeakMap<readonly RouterReportItem[], Map<string, readonly RouterBriefingEntry[]>>();

function liveBriefingsOf(
  slice: DeviceRouterStreamSlice,
  deviceKey: string,
  deviceName: string,
  self: boolean,
): readonly RouterBriefingEntry[] {
  if (slice.reports.length === 0) return NO_BRIEFINGS;
  const sig = `${deviceKey}\0${deviceName}\0${self ? 1 : 0}`;
  let bySig = briefingsByReportsCache.get(slice.reports);
  if (bySig === undefined) {
    bySig = new Map();
    briefingsByReportsCache.set(slice.reports, bySig);
  }
  const hit = bySig.get(sig);
  if (hit !== undefined) return hit;
  const list: RouterBriefingEntry[] = [];
  for (const rep of slice.reports) {
    const entry = briefingEntryOfReport(rep, {
      deviceKey,
      deviceName,
      self,
      pmById: slice.pmById,
      projectById: slice.projectById,
      live: true,
    });
    if (entry !== null) list.push(entry);
  }
  const out = list.length === 0 ? NO_BRIEFINGS : list;
  bySig.set(sig, out);
  return out;
}

interface ReadyDeviceStreamDep {
  key: string;
  name: string;
  self: boolean;
  online: boolean;
  slice: DeviceRouterStreamSlice;
}

let lastFleetStreamMemo: {
  selfKey: string;
  multiDevice: boolean;
  localCommands: readonly RouterCommandRecord[] | null;
  oldestCommandCursor: string | null;
  liveCommandCount: number;
  readyDeps: ReadyDeviceStreamDep[];
  deviceByKey: Map<string, RouterDeviceBriefings>;
  value: FleetRouterStream;
} | null = null;

/**
 * 汇总全舰队近窗时间流（入口本机指令回合 + 各就绪设备简报）。
 * 未就绪设备不会击穿缓存；单条指令变化时不重建任何设备的简报数组或设备对象。
 */
export function fleetRouterStream(
  devices: readonly RouterStreamDeviceInput[],
  selfId?: string,
): FleetRouterStream {
  const selfKey = selfId ?? "";
  const multiDevice = devices.length > 1;
  let localCommands: readonly RouterCommandRecord[] | null = null;
  let oldestCommandCursor: string | null = null;
  let liveCommandCount = 0;
  const readyDeps: ReadyDeviceStreamDep[] = [];

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i]!;
    if (d.state.phase !== "ready") continue;
    const slice = routerStreamOf(d.state);
    if (d.self) {
      localCommands = slice.commands;
      oldestCommandCursor = slice.oldestCommandCursor;
      liveCommandCount = slice.liveCommandCount;
    }
    readyDeps.push({
      key: d.self ? "" : d.key,
      name: d.name,
      self: d.self,
      online: d.online,
      slice,
    });
  }

  if (
    lastFleetStreamMemo !== null &&
    lastFleetStreamMemo.selfKey === selfKey &&
    lastFleetStreamMemo.multiDevice === multiDevice &&
    lastFleetStreamMemo.localCommands === localCommands &&
    lastFleetStreamMemo.oldestCommandCursor === oldestCommandCursor &&
    lastFleetStreamMemo.liveCommandCount === liveCommandCount &&
    lastFleetStreamMemo.readyDeps.length === readyDeps.length &&
    readyDeps.every((cur, idx) => {
      const prev = lastFleetStreamMemo!.readyDeps[idx]!;
      return (
        prev.key === cur.key &&
        prev.name === cur.name &&
        prev.self === cur.self &&
        prev.online === cur.online &&
        prev.slice === cur.slice
      );
    })
  ) {
    return lastFleetStreamMemo.value;
  }

  const turns = localCommands ? liveTurnsOf(localCommands, selfId) : NO_TURNS;
  const prevMap = lastFleetStreamMemo?.deviceByKey;
  const deviceByKey = new Map<string, RouterDeviceBriefings>();
  const deviceStreams: RouterDeviceBriefings[] = [];

  for (let i = 0; i < readyDeps.length; i++) {
    const dep = readyDeps[i]!;
    const briefings = liveBriefingsOf(dep.slice, dep.key, dep.name, dep.self);
    const prev = prevMap?.get(dep.key);
    const resolved: RouterDeviceBriefings =
      prev !== undefined &&
      prev.key === dep.key &&
      prev.name === dep.name &&
      prev.self === dep.self &&
      prev.online === dep.online &&
      prev.briefings === briefings &&
      prev.oldestCursor === dep.slice.oldestReportCursor &&
      prev.liveReportCount === dep.slice.liveReportCount &&
      prev.pmById === dep.slice.pmById &&
      prev.projectById === dep.slice.projectById
        ? prev
        : {
            key: dep.key,
            name: dep.name,
            self: dep.self,
            online: dep.online,
            briefings,
            oldestCursor: dep.slice.oldestReportCursor,
            liveReportCount: dep.slice.liveReportCount,
            pmById: dep.slice.pmById,
            projectById: dep.slice.projectById,
          };
    deviceByKey.set(dep.key, resolved);
    deviceStreams.push(resolved);
  }

  const value: FleetRouterStream = {
    turns,
    oldestCommandCursor,
    liveCommandCount,
    devices: deviceStreams,
    multiDevice,
  };
  lastFleetStreamMemo = {
    selfKey,
    multiDevice,
    localCommands,
    oldestCommandCursor,
    liveCommandCount,
    readyDeps,
    deviceByKey,
    value,
  };
  return value;
}

/**
 * 按各来源已覆盖到的最早时间水位线（watermark = max(loadedDownTo)）合并时间流：
 * 尚未翻完的来源挡在水位线之前，保证往回翻页时更老的内容永远只接在列表顶部，不往已看过的记录中间插队。
 */
export function mergeRouterStream<S extends RouterStreamSource<RouterStreamItemBase>>(
  sources: readonly S[],
): { entries: Array<S["entries"][number]>; hasMore: boolean; watermark: number | null } {
  let watermark: number | null = null;
  let hasMore = false;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    if (s.hasMore) hasMore = true;
    if (s.loadedDownTo !== null && (watermark === null || s.loadedDownTo > watermark)) {
      watermark = s.loadedDownTo;
    }
  }

  type Entry = S["entries"][number];
  const entries: Entry[] = [];
  for (let i = 0; i < sources.length; i++) {
    const list = sources[i]!.entries;
    for (let j = 0; j < list.length; j++) {
      const item = list[j] as Entry;
      if (watermark === null || item.createdAt >= watermark) {
        entries.push(item);
      }
    }
  }

  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.kind !== b.kind) return a.kind === "turn" ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return { entries, hasMore, watermark };
}
