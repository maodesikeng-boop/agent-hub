import {
  type Attachment,
  type ConversationId,
  type MessageId,
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

export interface RouterTurnDestination {
  key: string;
  deviceKey: string;
  deviceName: string;
  self: boolean;
  worker: boolean;
  conversationId: ConversationId;
  name: string;
  projectName: string | null;
  pmId: PmId;
  opLabel: string | null;
  forwardMessageId: MessageId | null;
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
  pmId: PmId;
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
  oldestReport: RouterReportItem | null;
  hasMore: boolean;
  pmById: ReadonlyMap<PmId, Pm>;
  projectById: ReadonlyMap<ProjectId, Project>;
}

export interface DeviceRouterStreamSlice {
  commands: readonly RouterCommandRecord[];
  oldestCommandCursor: string | null;
  oldestCommand: RouterCommandRecord | null;
  commandsHasMore: boolean;
  reports: readonly RouterReportItem[];
  oldestReportCursor: string | null;
  oldestReport: RouterReportItem | null;
  briefingsHasMore: boolean;
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
  oldestCommand: RouterCommandRecord | null;
  commandsHasMore: boolean;
  devices: readonly RouterDeviceBriefings[];
  multiDevice: boolean;
}

export interface RouterStreamPos {
  readonly createdAt: number;
  readonly kind: RouterStreamEntry["kind"];
  readonly deviceKey: string;
  readonly id: number;
}

export interface RouterStreamSource {
  readonly entries: readonly RouterStreamEntry[];
  readonly loadedDownTo: RouterStreamPos | null;
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
  const list = plan?.attachments;
  if (!list || list.length === 0) return NO_ATTACHMENTS;
  return list.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, path: "" }));
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
    const deviceKey = deviceKeyOf(d.deviceId, selfId ?? null);
    const self = deviceKey === "";
    const name = worker
      ? (d.title ?? d.pmName ?? `Worker #${d.workerId ?? conversationId}`)
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
      pmId: d.pmId,
      opLabel: opLabelOf(d.op),
      forwardMessageId: !worker && (d.op ?? "pm.forward") === "pm.forward" && d.messageId > 0 ? d.messageId : null,
    });
  }
  return out.length === 0 ? NO_DESTINATIONS : out;
}

export function canRetryCommand(command: RouterCommandRecord): boolean {
  const hasRetryOps = Array.isArray(command.plan?.retryOps) && command.plan.retryOps.length > 0;
  const anySucceeded = (command.dispatched ?? []).some((d) => d.ok);
  return hasRetryOps || !anySucceeded;
}

const turnEntryLiveCache = new WeakMap<RouterCommandRecord, Map<string, RouterTurnEntry>>();
const turnEntryHistoryCache = new WeakMap<RouterCommandRecord, Map<string, RouterTurnEntry>>();

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
    pmId: report.pmId,
    live: ctx.live,
  };
  briefingEntryCache.set(report, entry);
  return entry;
}

interface CommandsSlice {
  commands: readonly RouterCommandRecord[];
  oldestCommandCursor: string | null;
  oldestCommand: RouterCommandRecord | null;
  commandsHasMore: boolean;
}

interface ReportsSlice {
  reports: readonly RouterReportItem[];
  oldestReportCursor: string | null;
  oldestReport: RouterReportItem | null;
  briefingsHasMore: boolean;
  pmById: ReadonlyMap<PmId, Pm>;
  projectById: ReadonlyMap<ProjectId, Project>;
}

const commandsSliceCache = new WeakMap<HubState["router"]["commands"], CommandsSlice>();
const reportsSliceCache = new WeakMap<
  HubState["router"]["items"],
  WeakMap<HubState["pms"], WeakMap<HubState["projects"], ReportsSlice>>
>();
const deviceStreamCache = new WeakMap<CommandsSlice, WeakMap<ReportsSlice, DeviceRouterStreamSlice>>();

function commandsSliceOf(router: HubState["router"]): CommandsSlice {
  const rawCommands = router.commands;
  const commandsHasMore = router.commandsHasMore;
  const hit = commandsSliceCache.get(rawCommands);
  if (hit !== undefined) {
    if (hit.commandsHasMore === commandsHasMore) return hit;
    const updated: CommandsSlice = { ...hit, commandsHasMore };
    commandsSliceCache.set(rawCommands, updated);
    return updated;
  }
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
    oldestCommand: oldestCmd,
    commandsHasMore,
  };
  commandsSliceCache.set(rawCommands, slice);
  return slice;
}

function reportsSliceOf(state: HubState): ReportsSlice {
  const briefingsHasMore = state.router.briefingsHasMore;
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
  if (hit !== undefined) {
    if (hit.briefingsHasMore === briefingsHasMore) return hit;
    const updated: ReportsSlice = { ...hit, briefingsHasMore };
    byProjects.set(state.projects, updated);
    return updated;
  }

  const pmById = new Map<PmId, Pm>();
  for (const pm of state.pms) pmById.set(pm.id, pm);
  const projectById = new Map<ProjectId, Project>();
  for (const proj of state.projects) projectById.set(proj.id, proj);

  let oldestRep: RouterReportItem | null = null;
  const reports: RouterReportItem[] = [];
  for (const item of state.router.items) {
    if (item.kind !== "report") continue;
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
    oldestReport: oldestRep,
    briefingsHasMore,
    pmById,
    projectById,
  };
  byProjects.set(state.projects, slice);
  return slice;
}

export function routerStreamOf(state: HubState): DeviceRouterStreamSlice {
  const cSlice = commandsSliceOf(state.router);
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
    oldestCommand: cSlice.oldestCommand,
    commandsHasMore: cSlice.commandsHasMore,
    reports: rSlice.reports,
    oldestReportCursor: rSlice.oldestReportCursor,
    oldestReport: rSlice.oldestReport,
    briefingsHasMore: rSlice.briefingsHasMore,
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
  oldestCommand: RouterCommandRecord | null;
  commandsHasMore: boolean;
  readyDeps: ReadyDeviceStreamDep[];
  deviceByKey: Map<string, RouterDeviceBriefings>;
  value: FleetRouterStream;
} | null = null;

export function fleetRouterStream(
  devices: readonly RouterStreamDeviceInput[],
  selfId?: string,
): FleetRouterStream {
  const selfKey = selfId ?? "";
  const multiDevice = devices.length > 1;
  let localCommands: readonly RouterCommandRecord[] | null = null;
  let oldestCommandCursor: string | null = null;
  let oldestCommand: RouterCommandRecord | null = null;
  let commandsHasMore = false;
  const readyDeps: ReadyDeviceStreamDep[] = [];

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i]!;
    if (d.state.phase !== "ready") continue;
    const slice = routerStreamOf(d.state);
    if (d.self) {
      localCommands = slice.commands;
      oldestCommandCursor = slice.oldestCommandCursor;
      oldestCommand = slice.oldestCommand;
      commandsHasMore = slice.commandsHasMore;
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
    lastFleetStreamMemo.oldestCommand === oldestCommand &&
    lastFleetStreamMemo.commandsHasMore === commandsHasMore &&
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
      prev.oldestReport === dep.slice.oldestReport &&
      prev.hasMore === dep.slice.briefingsHasMore &&
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
            oldestReport: dep.slice.oldestReport,
            hasMore: dep.slice.briefingsHasMore,
            pmById: dep.slice.pmById,
            projectById: dep.slice.projectById,
          };
    deviceByKey.set(dep.key, resolved);
    deviceStreams.push(resolved);
  }

  // Reuse the previous device array when only commands changed so mark-read and briefing paging do not rerun.
  const prevValue = lastFleetStreamMemo?.value;
  const devicesOut =
    prevValue !== undefined &&
    prevValue.devices.length === deviceStreams.length &&
    deviceStreams.every((d, i) => d === prevValue.devices[i])
      ? prevValue.devices
      : deviceStreams;
  const value: FleetRouterStream =
    prevValue !== undefined &&
    prevValue.turns === turns &&
    prevValue.devices === devicesOut &&
    prevValue.oldestCommandCursor === oldestCommandCursor &&
    prevValue.oldestCommand === oldestCommand &&
    prevValue.commandsHasMore === commandsHasMore &&
    prevValue.multiDevice === multiDevice
      ? prevValue
      : { turns, oldestCommandCursor, oldestCommand, commandsHasMore, devices: devicesOut, multiDevice };
  lastFleetStreamMemo = {
    selfKey,
    multiDevice,
    localCommands,
    oldestCommandCursor,
    oldestCommand,
    commandsHasMore,
    readyDeps,
    deviceByKey,
    value,
  };
  return value;
}

const UNSAVED_ID = Number.MAX_SAFE_INTEGER;

export function routerStreamPosOf(entry: RouterStreamEntry): RouterStreamPos {
  return entry.kind === "turn"
    ? { createdAt: entry.createdAt, kind: "turn", deviceKey: "", id: entry.command?.id ?? UNSAVED_ID }
    : { createdAt: entry.createdAt, kind: "briefing", deviceKey: entry.deviceKey, id: entry.report.id };
}

function comparePos(a: RouterStreamPos, b: RouterStreamPos): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.kind !== b.kind) return a.kind === "turn" ? -1 : 1;
  if (a.deviceKey !== b.deviceKey) return a.deviceKey < b.deviceKey ? -1 : 1;
  return a.id - b.id;
}

export function mergeRouterStream(sources: readonly RouterStreamSource[]): {
  entries: RouterStreamEntry[];
  hasMore: boolean;
  watermark: RouterStreamPos | null;
} {
  let watermark: RouterStreamPos | null = null;
  let hasMore = false;
  for (const s of sources) {
    if (s.hasMore) hasMore = true;
    if (s.loadedDownTo !== null && (watermark === null || comparePos(s.loadedDownTo, watermark) > 0)) {
      watermark = s.loadedDownTo;
    }
  }

  const ranked: Array<{ entry: RouterStreamEntry; pos: RouterStreamPos }> = [];
  for (const s of sources) {
    for (const entry of s.entries) {
      const pos = routerStreamPosOf(entry);
      if (watermark === null || comparePos(pos, watermark) >= 0) ranked.push({ entry, pos });
    }
  }
  ranked.sort((a, b) => comparePos(a.pos, b.pos) || (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0));

  return { entries: ranked.map((r) => r.entry), hasMore, watermark };
}
