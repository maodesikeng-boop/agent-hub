import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAgentVendor, isTaskNodeWaitingUser, type ConversationId, type Message, type MessageId, type PersonaChangeId, type PmId } from "../shared/index.ts";
import type { SidebarGroup, SidebarRouterEntry } from "./components/Sidebar.tsx";
import type { SettingsDialogSection } from "./components/SettingsDialog.tsx";
import type { DeviceSettings } from "./settings-model.ts";
import { useDevices } from "./device-hub.ts";
import { LOCAL_DEVICE, conversationKey, deviceKeyOf, deviceNotices, isReadOnly, routeDeviceOf } from "./devices.ts";
import { useHubQueryClient } from "./query-client.ts";
import {
  activeGraphsOf,
  failingHealth,
  fleetRouterView,
  hasFetchedQuotaSession,
  listConversations,
  pendingAsks,
  quotaResetTimes,
  sessionOf,
  workerLineOf,
  workersOf,
  type ConversationEntry,
  type WorkerEntry,
} from "./selectors.ts";
import { useDeviceReminders, type ConversationRef } from "./notify.ts";
import { useDraftStore, useStagingStore } from "./upload.ts";
import { mobileBack, settingsParent } from "./mobile/back.ts";
import { routeHash, useRoute, type SettingsSection } from "./route.ts";
import { COMPACT_QUERY, NARROW_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const DRAG_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-drag]';
export const ROUTER_DRAFT_KEY = "router";
const EMPTY_ENTRIES: ConversationEntry[] = [];
const EMPTY_WORKERS: WorkerEntry[] = [];
const EMPTY_ASKS: Message[] = [];

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        hubStatus?: { postMessage: (payload: { runningWorkers: number; askingCount: number; waitingCount: number }) => void };
        windowDrag?: { postMessage: (payload: { doubleClick: boolean }) => void };
      };
    };
  }
}

/** 用户手动收起右栏后记住（docs/ui-standard.md 第 12 条）：存 "closed"；再手动展开就删掉。 */
const RIGHT_RAIL_KEY = "agent-hub.rightRail";
const loadRailClosed = () => {
  try {
    return localStorage.getItem(RIGHT_RAIL_KEY) === "closed";
  } catch {
    return false;
  }
};
const saveRailClosed = (closed: boolean) => {
  try {
    if (closed) localStorage.setItem(RIGHT_RAIL_KEY, "closed");
    else localStorage.removeItem(RIGHT_RAIL_KEY);
  } catch {
    // 存不了（隐私模式）：这次照常，刷新后忘掉
  }
};

function desktopSectionOf(section: SettingsSection | undefined, managed: boolean): SettingsDialogSection | undefined {
  if (section === undefined) return undefined;
  if (section === "scale" || section === "notifications" || section === "vendor-sync") return "general";
  if (section === "computers") return managed ? "computers" : "general";
  return "security";
}

export function useShellModel({ autoSelect }: { autoSelect: boolean }) {
  const qc = useHubQueryClient();
  const fleet = useDevices();
  const { route, navigate, replace } = useRoute();
  // HTTP 创建成功已确认编号有效（WebSocket 的变化可能晚到）；等所属对话同步完成或离开该路由后释放，仅保留一个槽。
  const [pendingCreated, setPendingCreated] = useState<ConversationRef | null>(null);
  // 网址里的设备（没写是入口本机）；清单里没有（还没拉到、编号不对）先看入口本机
  const local = fleet.devices[0]!;
  const routedDevice = fleet.devices.find((d) => d.key === deviceKeyOf(route?.device, fleet.selfId));
  const current = routedDevice ?? local;
  const hub = fleet.hub(current.key);
  const { state } = current;
  const remote = current.key !== LOCAL_DEVICE;
  // 额度到了重置时间自己变（左下角的百分比、状态行的“等额度”），不用刷新页面
  const resetTimes = useMemo(() => quotaResetTimes(state), [state.sessions]);
  useRerenderAt(resetTimes);
  /** 草稿、待发的文件按对话存，键带设备（devices.ts 的 conversationKey，各台的对话编号会撞）。 */
  const drafts = useDraftStore<string>();
  const staging = useStagingStore<string>();
  const [creating, setCreating] = useState(false);
  const [desktopSettings, setDesktopSettings] = useState<{ open: boolean; section?: SettingsDialogSection }>({ open: false });
  const onSettingsOpenChange = useCallback((open: boolean) => setDesktopSettings({ open }), []);
  /** 用户手动收起了右栏（记住）。 */
  const [railClosed, setRailClosed] = useState(loadRailClosed);
  /** 太窄时右栏默认收着，点开关才出来（不记住）。 */
  const [compactRailOpen, setCompactRailOpen] = useState(false);
  /** 手动打开右栏看已收工的 Worker 时，是哪个项目经理（没有要关心的事时右栏默认不出来）。 */
  const [railPeek, setRailPeek] = useState<PmId | null>(null);
  const narrow = useMediaQuery(NARROW_QUERY);
  const compact = useMediaQuery(COMPACT_QUERY);
  /** 右栏点开一个提问：对话滚到那条消息。n 每点一次加一，点同一条也再跳一次。 */
  const [focus, setFocus] = useState<{ id: MessageId; n: number } | null>(null);

  const clearFocus = useCallback(() => setFocus(null), []);

  const entries = useMemo(() => listConversations(state), [state.conversations, state.pms, state.projects, state.folders]);
  const profilePm = route?.view === "profile" ? route.pmId : null;
  const profile = profilePm === null ? null : (state.pms.find((p) => p.id === profilePm) ?? null);
  // 网址写的 Worker 对话其实不是 Worker 的（手改的网址）：当没写
  const routedWorker = route?.view === "worker" && state.conversations[route.id]?.conversation.kind !== "pm" ? route.id : null;
  const openWorker = routedWorker;
  const workerView = openWorker === null ? undefined : state.conversations[openWorker];
  const routerActive = route?.view === "router" || (autoSelect && (route === null || route.view === "settings"));
  // 网址指的项目经理对话：直接是对话；Worker 的对话归派它的项目经理；资料页是那个项目经理的对话；Router 与设置视图不选中单个对话
  const routedEntry =
    route === null || route.view === "router" || route.view === "settings"
      ? undefined
      : route.view === "conversation"
        ? entries.find((e) => e.id === route.id)
        : route.view === "worker"
          ? entries.find((e) => e.pm !== null && e.pm.id === workerView?.conversation.pmId)
          : entries.find((e) => e.pm?.id === route.pmId);
  const firstUnarchived = entries.find((e) => e.pm?.archivedAt == null) ?? entries[0];
  const active = routerActive ? null : (routedEntry ?? (autoSelect ? firstUnarchived : null) ?? null);
  const select = useCallback(
    (ref: ConversationRef) => {
      navigate({ view: "conversation", id: ref.id, ...routeDeviceOf(ref.device) }, !autoSelect && route !== null);
    },
    [navigate, autoSelect, route],
  );
  const selectRouter = useCallback(() => {
    navigate({ view: "router" }, !autoSelect && route !== null);
  }, [navigate, autoSelect, route]);
  // 用户正开着的对话：资料页不算；打开着 Worker 的对话算它的项目经理的会话
  const activeId = profile ? null : (active?.id ?? null);
  const reminderDevices = useMemo(() => fleet.devices.map((d) => ({ key: d.key, name: d.info.name, state: d.state })), [fleet.devices]);
  const reminders = useDeviceReminders(reminderDevices, activeId === null ? null : { device: current.key, id: activeId }, select);
  const runningWorkers = useMemo(
    () =>
      fleet.devices.reduce(
        (sum, d) =>
          d.state.phase !== "ready"
            ? sum
            : sum +
              Object.values(d.state.conversations).filter(
                ({ conversation }) => conversation.kind === "worker" && (sessionOf(d.state, conversation.id)?.activity ?? "idle") !== "idle",
              ).length,
        0,
      ),
    [fleet.devices],
  );
  const askingCount = reminders.asking.size;
  const waitingCount = reminders.waiting.size;
  useEffect(() => {
    window.webkit?.messageHandlers?.hubStatus?.postMessage({ runningWorkers, askingCount, waitingCount });
  }, [runningWorkers, askingCount, waitingCount]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !target.closest("[data-window-drag]")) return;
      if (target.closest(DRAG_INTERACTIVE_SELECTOR)) return;
      window.webkit?.messageHandlers?.windowDrag?.postMessage({ doubleClick: e.detail === 2 });
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);

  const shellReady = local.state.phase === "ready" &&
    !(route?.device !== undefined && routedDevice === undefined && !fleet.listed);
  // 电脑外壳空 hash 默认落地水果刀工作台 #/router（replaceState 不留多余历史）；从手机 #/settings* 切回桌面外壳时自动承接打开桌面双栏 SettingsDialog
  useEffect(() => {
    if (!autoSelect || !shellReady) return;
    if (route === null) {
      replace({ view: "router" });
      return;
    }
    if (route.view === "settings") {
      const section = desktopSectionOf(route.section, fleet.managed);
      setDesktopSettings(section === undefined ? { open: true } : { open: true, section });
      replace({ view: "router" });
    }
  }, [autoSelect, shellReady, route, fleet.managed, replace]);
  // 手机设置：不认识的子页归一为 #/settings；确定未开联机（fleet.listed && !fleet.managed）时直达电脑/公网入口退回一级设置（拉清单期间等待）
  useEffect(() => {
    if (autoSelect || route?.view !== "settings") return;
    const unmanagedSection = fleet.listed && !fleet.managed && (route.section === "computers" || route.section === "public-access");
    if (unmanagedSection || window.location.hash !== routeHash(route)) {
      replace({ view: "settings" });
    }
  }, [autoSelect, fleet.listed, fleet.managed, route, replace]);
  // 网址写的设备清单里没有（编号不对、已经移除了）：回到入口本机
  const unknownDevice = fleet.listed && route?.device !== undefined && routedDevice === undefined;
  const localEntries = useMemo(
    () => (local.state.phase === "ready" ? (local.key === current.key ? entries : listConversations(local.state)) : []),
    [local.state, local.key, current.key, entries],
  );
  const localFirst = (localEntries.find((e) => e.pm?.archivedAt == null) ?? localEntries[0])?.id ?? null;
  useEffect(() => {
    if (unknownDevice) {
      if (!autoSelect) replace(null);
      else if (localFirst !== null) replace({ view: "conversation", id: localFirst });
      else replace({ view: "router" });
    }
  }, [unknownDevice, localFirst, replace, autoSelect]);
  const awaitingCreated = pendingCreated !== null && route?.view === "conversation" &&
    route.id === pendingCreated.id && deviceKeyOf(route.device, fleet.selfId) === pendingCreated.device &&
    routedEntry === undefined;
  useEffect(() => {
    if (!awaitingCreated) setPendingCreated(null);
  }, [awaitingCreated]);
  useEffect(() => {
    const valid = new Set<string>();
    const pendingDevicePrefixes = new Set<string>();
    let keepLocalAll = false;
    for (const d of fleet.devices) {
      if (d.state.phase === "ready") {
        for (const id of Object.keys(d.state.conversations)) valid.add(conversationKey(d.key, Number(id)));
      } else if (d.key === LOCAL_DEVICE) {
        keepLocalAll = true;
      } else {
        pendingDevicePrefixes.add(`${d.key}/`);
      }
    }
    if (pendingCreated !== null) valid.add(conversationKey(pendingCreated.device, pendingCreated.id));
    drafts.retain((k) => {
      if (k === ROUTER_DRAFT_KEY || valid.has(k)) return true;
      const slash = k.indexOf("/");
      if (slash < 0) return keepLocalAll;
      return !fleet.listed || pendingDevicePrefixes.has(k.slice(0, slash + 1));
    });
  }, [fleet.devices, fleet.listed, pendingCreated, drafts]);
  const invalidMobileRoute = !autoSelect && shellReady && routedDevice !== undefined && state.phase === "ready" && !awaitingCreated && route !== null &&
    route.view !== "router" && route.view !== "settings" &&
    (route.view === "profile" ? profile === null : route.view === "worker" ? workerView === undefined || routedEntry === undefined : routedEntry === undefined);
  useEffect(() => {
    if (invalidMobileRoute || (!autoSelect && route === null && window.location.hash !== "")) replace(null);
  }, [invalidMobileRoute, autoSelect, route, replace]);

  const here = useMemo(() => routeDeviceOf(current.key), [current.key]);
  const keyOf = useCallback((id: ConversationId) => conversationKey(current.key, id), [current.key]);
  const openWorkerConversation = useCallback(
    (id: ConversationId) => {
      if (compact) setCompactRailOpen(false);
      navigate({ view: "worker", id, ...here }, !autoSelect && route?.view === "worker");
    },
    [compact, navigate, here, autoSelect, route?.view],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const actions = useMemo(
    () => ({
      retry: state.retry,
      onRetryMessage: (messageId: number) => void hub.retryMessage(messageId),
      onOpenWorker: openWorkerConversation,
      onRevertPersona: async (changeId: PersonaChangeId) => {
        await hub.client.postRevertPersonaChange(changeId);
      },
      vendorOf: (id: ConversationId) => {
        const vendor = sessionOf(stateRef.current, id)?.vendor;
        return isAgentVendor(vendor) ? vendor : undefined;
      },
    }),
    [state.retry, hub, openWorkerConversation],
  );
  const send = useCallback(
    (id: ConversationId, text: string, files: File[]) => {
      const key = keyOf(id);
      const slot = drafts.of(key);
      // 只有文字：马上发、马上清。带文件：传完、发出之后才清，而且只清提交的这一份（文字没变才清文字、只去掉发出的那几个文件）；
      // 传失败了什么都不清（文字和文件都留着）
      // 以 / 开头的：手打的命令可能被拦（发消息 400，原因显示在输入框上方、原文留着），所以等接口回应了才清
      // /hub:worker 选的标签：发出去才清（中途换过的不动），被拦、上传失败时和文字一起留着
      const pick = slot.getPick();
      if (files.length === 0 && text.startsWith("/")) {
        return hub.sendChecked(id, text, pick).then(() => {
          slot.clearIfMatch(text);
          slot.clearPickIfMatch(pick);
        });
      }
      if (files.length === 0) {
        slot.set("");
        slot.setPick(null);
        hub.send(id, text, pick);
        return;
      }
      return hub.sendWithFiles(id, text, files, pick).then(() => {
        slot.clearIfMatch(text);
        slot.clearPickIfMatch(pick);
        staging.of(key).removeSent(files);
      });
    },
    [keyOf, drafts, hub, staging],
  );
  const handleLoadOlder = useCallback((id: ConversationId) => void hub.loadOlder(id), [hub]);
  const openProfile = useCallback((pmId: PmId) => navigate({ view: "profile", pmId, ...here }), [navigate, here]);
  const health = useMemo(() => failingHealth(state), [state.health]);
  const quotaFetchable = useMemo(() => hasFetchedQuotaSession(state), [state.sessions]);
  const workerLine = useMemo(() => (openWorker === null ? null : workerLineOf(state, openWorker)), [state.conversations, openWorker]);
  const railPm = active?.pm?.id ?? null;
  const railWorkers = useMemo(() => (railPm === null ? EMPTY_WORKERS : workersOf(state, railPm)), [state.conversations, state.sessions, railPm]);
  const railAsks = useMemo(() => (active ? pendingAsks(state, active.id) : EMPTY_ASKS), [state.conversations, state.pms, state.pending, active?.id]);
  // 右栏的果皮轨：当前项目经理那个项目的活跃任务图（activeGraphsOf 按 state.activeTaskGraphs 的 WeakMap 缓存，流式帧里引用不变）
  const railProjectId = active?.project?.id ?? null;
  const railGraphs = useMemo(() => activeGraphsOf(state, railProjectId), [state.activeTaskGraphs, railProjectId]);
  const railGraphNeedsYou = useMemo(() => railGraphs.some((g) => g.nodes.some(isTaskNodeWaitingUser)), [railGraphs]);
  // 别的设备连不上（联机第 4.3 节）：离线时提示显示的是多久以前的内容、只读；重连中照常显示，发送等连上。入口本机照旧
  const { offline, link: rawLink } = deviceNotices(current);
  const link = useMemo(
    () => (rawLink === null ? null : { readOnly: rawLink.readOnly, waiting: rawLink.waiting }),
    [rawLink?.readOnly, rawLink?.waiting],
  );
  const openNewPm = useCallback(() => setCreating(true), []);
  const openSettings = useCallback(() => navigate({ view: "settings" }), [navigate]);
  const openSettingsSection = useCallback((section: SettingsSection) => navigate({ view: "settings", section }), [navigate]);
  const routeRef = useRef(route);
  routeRef.current = route;
  const settingsBack = useCallback(() => {
    const currentRoute = routeRef.current;
    if (currentRoute?.view === "settings") mobileBack(settingsParent(currentRoute), replace);
  }, [replace]);
  const refreshFleet = useCallback(() => void fleet.refresh(), [fleet.refresh]);
  const deviceSettingsRef = useRef<DeviceSettings | null>(null);
  const deviceSettings = useMemo<DeviceSettings | null>(() => {
    if (!fleet.managed) {
      deviceSettingsRef.current = null;
      return null;
    }
    const next: DeviceSettings = {
      devices: fleet.devices,
      ...(local.state.tunnel !== undefined ? { tunnel: local.state.tunnel } : {}),
      ...(local.state.publicEntry !== undefined ? { publicEntry: local.state.publicEntry } : {}),
      ...(local.state.server.repoDir !== undefined ? { repoDir: local.state.server.repoDir } : {}),
      onChanged: refreshFleet,
    };
    const prev = deviceSettingsRef.current;
    if (
      prev !== null &&
      prev.tunnel === next.tunnel &&
      prev.publicEntry === next.publicEntry &&
      prev.repoDir === next.repoDir &&
      prev.onChanged === next.onChanged &&
      prev.devices.length === next.devices.length &&
      next.devices.every((d, i) => {
        const o = prev.devices[i]!;
        return d.key === o.key && d.info === o.info && d.status === o.status && (d.status !== "offline" || d.lastOnlineAt === o.lastOnlineAt);
      })
    ) {
      return prev;
    }
    deviceSettingsRef.current = next;
    return next;
  }, [fleet.managed, fleet.devices, local.state.tunnel, local.state.publicEntry, local.state.server.repoDir, refreshFleet]);
  const created = useCallback(
    (device: string, conversationId: ConversationId) => {
      setCreating(false);
      setPendingCreated({ device, id: conversationId });
      select({ device, id: conversationId });
    },
    [select],
  );
  const profileEntry = profile ? entries.find((e) => e.pm?.id === profile.id) : undefined;
  // 右栏列的是当前打开的项目经理（Worker 的对话也算它）的“等你确定”和 Worker
  const railHasContent = !profile && (railWorkers.length > 0 || railAsks.length > 0 || railGraphs.length > 0);
  // 有要关心的事才自动出来：有活跃任务图、有没收工的 Worker（在干活、等验收）或有没回答的提问；只有收工的 Worker 时整栏不出来，点开关才手动看
  const railNeedsYou = !profile && (railAsks.length > 0 || railGraphs.length > 0 || railWorkers.some((w) => !w.ended));
  // 开关上的小圆点：有没回答的提问或待拍板的门禁（docs/ui-standard.md 第 12 条）
  const railAttention = !profile && (railAsks.length > 0 || railGraphNeedsYou);
  const railPeeking = railPeek !== null && railPeek === railPm;
  const railOpen = railHasContent && (compact ? compactRailOpen : !railClosed && (railNeedsYou || railPeeking));
  const toggleRail = useCallback(() => {
    if (compact) {
      setCompactRailOpen((v) => !v);
      return;
    }
    const closed = railOpen;
    setRailClosed(closed);
    saveRailClosed(closed);
    // 手动打开、而又没有要关心的事：记下来，右栏才不会马上又收回去（只在这个项目经理、这次打开期间）
    setRailPeek(closed || railNeedsYou ? null : railPm);
  }, [compact, railOpen, railNeedsYou, railPm]);
  const openAsk = useCallback(
    (messageId: MessageId) => {
      if (active && openWorker !== null) {
        const parent = { view: "conversation", id: active.id, ...here } as const;
        if (autoSelect) navigate(parent);
        else mobileBack(parent, replace);
      }
      setFocus((f) => ({ id: messageId, n: (f?.n ?? 0) + 1 }));
    },
    [active, openWorker, here, autoSelect, navigate, replace],
  );
  const sidebarActive = profileEntry?.id ?? activeId;
  const sidebarActiveRef = useMemo(
    () => (sidebarActive === null ? null : { device: current.key, id: sidebarActive }),
    [current.key, sidebarActive],
  );
  const routerView = useMemo(
    () =>
      fleetRouterView(
        fleet.devices.map((d) => ({
          id: d.key === LOCAL_DEVICE ? "local" : d.key,
          key: d.key,
          name: d.info.name,
          self: d.key === LOCAL_DEVICE,
          online: d.key === LOCAL_DEVICE ? true : !isReadOnly(d.status),
          state: d.state,
        })),
      ),
    [fleet.devices],
  );
  const sidebarRouter = useMemo<SidebarRouterEntry>(
    () => ({
      active: routerActive,
      pendingCount: routerView.summary.pendingCount,
      unreadReportCount: routerView.summary.unreadReportCount,
      subtitle: routerView.summary.subtitle,
      onSelect: selectRouter,
    }),
    [routerActive, routerView.summary.pendingCount, routerView.summary.unreadReportCount, routerView.summary.subtitle, selectRouter],
  );
  const fleetHub = fleet.hub;
  const clientForDevice = useCallback((deviceKey: string) => fleetHub(deviceKey).client, [fleetHub]);
  const openDeviceWorker = useCallback(
    (deviceKey: string, id: ConversationId) => {
      navigate({ view: "worker", id, ...routeDeviceOf(deviceKey) });
    },
    [navigate],
  );
  const openDeviceConversation = useCallback(
    (deviceKey: string, id: ConversationId) => {
      select({ device: deviceKey, id });
    },
    [select],
  );
  const groupsRef = useRef<SidebarGroup[]>([]);

  // 保留 App 原来的提前返回边界：入口尚未就绪时不遍历列表。
  const shared = { replace, qc, fleet, route, local, routedDevice, current, hub, state };
  if (!shellReady) return { ...shared, content: null };

  const view = active ? state.conversations[active.id] : undefined;
  const reconnecting = remote ? current.status === "reconnecting" : state.connection === "reconnecting";
  const workerPmEntry = active;
  const avatarKey = active?.avatarKey ?? 0;
  const nextGroups: SidebarGroup[] = fleet.devices.map((d) => ({
    key: d.key,
    name: d.info.name,
    platform: d.info.platform,
    status: d.status,
    lastOnlineAt: d.lastOnlineAt,
    entries: d.state.phase === "ready" ? (d.key === current.key ? entries : listConversations(d.state)) : EMPTY_ENTRIES,
  }));
  const prevGroups = groupsRef.current;
  const groups =
    prevGroups.length === nextGroups.length &&
    nextGroups.every((g, i) => {
      const p = prevGroups[i]!;
      return (
        p.key === g.key &&
        p.name === g.name &&
        p.platform === g.platform &&
        p.status === g.status &&
        (g.status !== "offline" || p.lastOnlineAt === g.lastOnlineAt) &&
        p.entries === g.entries
      );
    })
      ? prevGroups
      : nextGroups;
  groupsRef.current = groups;
  const newPmDevices = fleet.devices.map((d) => ({ key: d.key, name: d.info.name, status: d.status, client: fleet.hub(d.key).client, server: d.state.server }));
  return {
    ...shared,
    content: {
      active,
      activeId,
      actions,
      avatarKey,
      clearFocus,
      clientForDevice,
      compact,
      created,
      creating,
      desktopSettingsOpen: desktopSettings.open,
      desktopSettingsSection: desktopSettings.section,
      deviceSettings,
      drafts,
      focus,
      groups,
      handleLoadOlder,
      health,
      keyOf,
      link,
      narrow,
      newPmDevices,
      offline,
      onSettingsOpenChange,
      openAsk,
      openDeviceConversation,
      openDeviceWorker,
      openNewPm,
      openProfile,
      openSettings,
      openSettingsSection,
      openWorker,
      openWorkerConversation,
      profile,
      profileEntry,
      quotaFetchable,
      railAsks,
      railAttention,
      railGraphs,
      railHasContent,
      railOpen,
      railProjectId,
      railWorkers,
      reconnecting,
      refreshFleet,
      reminders,
      routerActive,
      routerView,
      select,
      send,
      setCreating,
      settingsBack,
      sidebarActive,
      sidebarActiveRef,
      sidebarRouter,
      staging,
      toggleRail,
      view,
      workerLine,
      workerPmEntry,
      workerView,
    },
  };
}
