import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isAgentVendor,
  isTaskNodeAwaitingUserAction,
  type ConversationId,
  type Message,
  type MessageId,
  type PersonaChangeId,
  type PmId,
  type WorkerId,
} from "../shared/index.ts";
import type { AppRailRouter } from "./components/AppRail.tsx";
import { useDevices } from "./device-hub.ts";
import type { DeviceStoreLookup } from "./forward-reply.ts";
import { LOCAL_DEVICE, conversationKey, deviceKeyOf, deviceNotices, isReadOnly, routeDeviceOf, type DeviceKey } from "./devices.ts";
import { useHubQueryClient } from "./query-client.ts";
import { railComputersOf } from "./rail-model.ts";
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
import { totalRunningWorkers } from "../shared/reminders.ts";
import { useDeviceReminders, type ConversationRef } from "./notify.ts";
import { useDraftStore, useStagingStore } from "./upload.ts";
import { mobileBack } from "./mobile/back.ts";
import type { InfoPage, SettingsSection } from "./route.ts";
import { useWorkbenchNav } from "./workbench-nav.ts";
import {
  accountSettingsTarget,
  newPmDevicesOf,
  togglePmPin,
  useDeviceSettings,
  usePruneStaleDrafts,
  useStableRailInputs,
  useWindowDrag,
} from "./shell-actions.ts";
import { defaultLookOf } from "../shared/slimes.ts";
import { useRerenderAt } from "./useRerenderAt.ts";
import type { WorkPanelTab } from "./work-panel-model.ts";

const NO_LOOK = defaultLookOf(0);
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

const RIGHT_RAIL_KEY = "agent-hub.rightRail";
const WORK_TAB_KEY = "agent-hub.workPanel.tab";
export const PROVIDERS_GUIDED_KEY = "agent-hub.providersGuided";

type RememberedWorkTab = Exclude<WorkPanelTab, "info">;

const loadWorkTab = (): RememberedWorkTab => {
  try {
    return localStorage.getItem(WORK_TAB_KEY) === "completed" ? "completed" : "active";
  } catch {
    return "active";
  }
};
const saveWorkTab = (tab: RememberedWorkTab) => {
  try {
    localStorage.setItem(WORK_TAB_KEY, tab);
  } catch {
  }
};

const loadProvidersGuided = () => {
  try {
    return (
      localStorage.getItem(PROVIDERS_GUIDED_KEY) === "1" ||
      sessionStorage.getItem(PROVIDERS_GUIDED_KEY) === "1"
    );
  } catch {
    return false;
  }
};

const saveProvidersGuided = () => {
  try {
    localStorage.setItem(PROVIDERS_GUIDED_KEY, "1");
  } catch {
    try {
      sessionStorage.setItem(PROVIDERS_GUIDED_KEY, "1");
    } catch {
    }
  }
};

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
  }
};

function reuseEntryList(prev: ConversationEntry[], next: ConversationEntry[]): ConversationEntry[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) if (next[i] !== prev[i]) return next;
  return prev;
}

const EMPTY_NEW_PM_DEVICES: never[] = [];

export function useShellModel({ mobile }: { mobile: boolean }) {
  const qc = useHubQueryClient();
  const fleet = useDevices();
  const navigation = useWorkbenchNav();
  const { nav, openPage: navigate, replacePage: replace, repairPage, openSettings: showSettings, showSettingsSection } = navigation;
  const route = nav.page;
  const [startedInColumns] = useState(!mobile);
  const [pendingCreated, setPendingCreated] = useState<ConversationRef | null>(null);
  const [pickedDevice, setPickedDevice] = useState<DeviceKey | null>(null);
  const activatePickedDevice = useRef(false);
  const lastByDeviceRef = useRef(new Map<DeviceKey, ConversationId>());
  const prevEntriesRef = useRef<ConversationEntry[]>(EMPTY_ENTRIES);
  const devicesRef = useRef(fleet.devices);
  devicesRef.current = fleet.devices;
  const routeRef = useRef(route);
  routeRef.current = route;
  const effectivePickedDevice = route === null ? pickedDevice : null;
  const local = fleet.devices[0]!;
  const routedDevice = route !== null && route.view !== "router"
    ? fleet.devices.find((d) => d.key === deviceKeyOf(route.device, fleet.selfId))
    : undefined;
  const pickedView = effectivePickedDevice === null ? undefined : fleet.devices.find((d) => d.key === effectivePickedDevice);
  const current = routedDevice ?? pickedView ?? local;
  const hub = fleet.hub(current.key);
  const { state } = current;
  const remote = current.key !== LOCAL_DEVICE;
  const resetTimes = useMemo(() => quotaResetTimes(state), [state.sessions]);
  useRerenderAt(resetTimes);
  const drafts = useDraftStore<string>();
  const staging = useStagingStore<string>();
  const [creating, setCreating] = useState(false);
  const openSettings = useCallback(() => showSettings({ providerDevice: current.key }), [showSettings, current.key]);
  const openSettingsSection = useCallback((section: SettingsSection) => {
    if (nav.settings === null) showSettings({ section, providerDevice: current.key });
    else showSettingsSection(section);
  }, [nav.settings, showSettings, showSettingsSection, current.key]);
  const openManageProviders = useCallback((target: DeviceKey = current.key) => {
    setCreating(false);
    showSettings({ section: "providers", providerDevice: target });
  }, [showSettings, current.key]);
  const [providersGuided, setProvidersGuided] = useState(loadProvidersGuided);
  const [railClosed, setRailClosed] = useState(loadRailClosed);
  const [railPeek, setRailPeek] = useState<PmId | null>(null);
  const [workTab, setWorkTabState] = useState<RememberedWorkTab>(loadWorkTab);
  const setWorkTab = useCallback((tab: RememberedWorkTab) => {
    setWorkTabState(tab);
    saveWorkTab(tab);
  }, []);
  const [focus, setFocus] = useState<{ id: MessageId; n: number } | null>(null);

  const clearFocus = useCallback(() => setFocus(null), []);

  const entries = useMemo(() => listConversations(state), [state.conversations, state.pms, state.projects, state.folders]);
  const profilePm = route?.view === "profile" ? route.pmId : null;
  const profile = profilePm === null ? null : (state.pms.find((p) => p.id === profilePm) ?? null);
  const profilePage =
    route?.view === "profile" && !(profile?.archivedAt != null && route.page === "capabilities")
      ? (route.page ?? null)
      : null;
  const routedWorker = route?.view === "worker" && state.conversations[route.id]?.conversation.kind !== "pm" ? route.id : null;
  const openWorker = routedWorker;
  const workerView = openWorker === null ? undefined : state.conversations[openWorker];
  const routerActive = route?.view === "router" || (route === null && pickedDevice === null);
  const routedEntry =
    route === null || route.view === "router"
      ? undefined
      : route.view === "conversation"
        ? entries.find((e) => e.id === route.id)
        : route.view === "worker"
          ? entries.find((e) => e.pm !== null && e.pm.id === workerView?.conversation.pmId)
          : entries.find((e) => e.pm?.id === route.pmId);
  const firstUnarchived = entries.find((e) => e.pm?.archivedAt == null) ?? entries[0];
  const active = routerActive ? null : (routedEntry ?? (route === null || startedInColumns ? firstUnarchived : null) ?? null);
  if (active !== null) lastByDeviceRef.current.set(current.key, active.id);
  const select = useCallback(
    (ref: ConversationRef) => {
      activatePickedDevice.current = false;
      setPickedDevice(mobile ? ref.device : null);
      navigate({ view: "conversation", id: ref.id, ...routeDeviceOf(ref.device) }, mobile && route !== null);
    },
    [navigate, mobile, route],
  );
  const selectRouter = useCallback(() => {
    activatePickedDevice.current = false;
    if (!mobile) setPickedDevice(null);
    navigate({ view: "router" }, mobile && route !== null);
  }, [navigate, mobile, route]);
  const selectComputer = useCallback(
    (key: DeviceKey) => {
      activatePickedDevice.current = false;
      if (mobile) {
        setPickedDevice(key);
        return;
      }
      const target = devicesRef.current.find((d) => d.key === key);
      const targetEntries = target?.state.phase === "ready" ? listConversations(target.state) : EMPTY_ENTRIES;
      const lastId = lastByDeviceRef.current.get(key);
      const chosen =
        (lastId === undefined ? undefined : targetEntries.find((e) => e.id === lastId && e.pm?.archivedAt == null)) ??
        targetEntries.find((e) => e.pm?.archivedAt == null) ??
        targetEntries[0];
      if (chosen !== undefined) {
        setPickedDevice(null);
        navigate({ view: "conversation", id: chosen.id, ...routeDeviceOf(key) }, false);
        return;
      }
      activatePickedDevice.current = true;
      setPickedDevice(key);
      if (routeRef.current !== null) replace(null);
    },
    [mobile, navigate, replace],
  );
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (route !== null || !activatePickedDevice.current || activeId === null) return;
    activatePickedDevice.current = false;
    setPickedDevice(null);
    repairPage({ view: "conversation", id: activeId, ...routeDeviceOf(current.key) });
  }, [route, activeId, current.key, repairPage]);
  const reminderDevices = useMemo(() => fleet.devices.map((d) => ({ key: d.key, name: d.info.name, state: d.state })), [fleet.devices]);
  const reminders = useDeviceReminders(reminderDevices, activeId === null ? null : { device: current.key, id: activeId }, select);
  const runningWorkers = useMemo(
    () => fleet.devices.reduce((sum, d) => (d.state.phase !== "ready" ? sum : sum + totalRunningWorkers(d.state)), 0),
    [fleet.devices],
  );
  const askingCount = reminders.asking.size;
  const waitingCount = reminders.waiting.size;
  useEffect(() => {
    window.webkit?.messageHandlers?.hubStatus?.postMessage({ runningWorkers, askingCount, waitingCount });
  }, [runningWorkers, askingCount, waitingCount]);

  useWindowDrag();

  const shellReady = local.state.phase === "ready" &&
    !(route?.device !== undefined && routedDevice === undefined && !fleet.listed);

  const localClientRef = fleet.hub(LOCAL_DEVICE).client;
  const shouldCheckFirstRunProviders =
    startedInColumns && shellReady && !providersGuided;
  const markProvidersGuided = useCallback(
    (openProviders: boolean) => {
      setProvidersGuided(true);
      saveProvidersGuided();
      if (openProviders) openManageProviders(LOCAL_DEVICE);
    },
    [openManageProviders],
  );

  useEffect(() => {
    if (fleet.listed && !fleet.managed && nav.settings?.section === "computers") openSettings();
  }, [fleet.listed, fleet.managed, nav.settings?.section, openSettings]);
  const unknownDevice = fleet.listed && route?.device !== undefined && routedDevice === undefined;
  const localEntries = useMemo(
    () => (local.state.phase === "ready" ? (local.key === current.key ? entries : listConversations(local.state)) : []),
    [local.state, local.key, current.key, entries],
  );
  const localFirst = (localEntries.find((e) => e.pm?.archivedAt == null) ?? localEntries[0])?.id ?? null;
  useEffect(() => {
    if (unknownDevice) {
      if (localFirst !== null) repairPage({ view: "conversation", id: localFirst });
      else repairPage({ view: "router" });
    }
  }, [unknownDevice, localFirst, repairPage]);
  const awaitingCreated = pendingCreated !== null && route?.view === "conversation" &&
    route.id === pendingCreated.id && deviceKeyOf(route.device, fleet.selfId) === pendingCreated.device &&
    routedEntry === undefined;
  useEffect(() => {
    if (!awaitingCreated) setPendingCreated(null);
  }, [awaitingCreated]);
  usePruneStaleDrafts(fleet.devices, fleet.listed, pendingCreated, drafts, ROUTER_DRAFT_KEY);
  const missingWorker = route?.view === "worker" && state.phase === "ready" && workerView === undefined && state.conversations[route.id] === undefined ? route.id : null;
  const workerLookup = missingWorker === null ? undefined : state.lookups[missingWorker];
  useEffect(() => {
    if (missingWorker !== null && workerLookup === undefined) hub.ensureConversation(missingWorker);
  }, [hub, missingWorker, workerLookup]);
  const invalidRoute = !startedInColumns && shellReady && (route?.device === undefined || routedDevice !== undefined) && state.phase === "ready" && !awaitingCreated && route !== null &&
    route.view !== "router" &&
    (route.view === "profile"
      ? profile === null
      : route.view === "worker"
        ? workerView === undefined ? state.conversations[route.id] !== undefined || workerLookup === "missing" : routedEntry === undefined
        : routedEntry === undefined);
  useEffect(() => {
    if (invalidRoute) repairPage(null);
  }, [invalidRoute, repairPage]);

  const here = useMemo(() => routeDeviceOf(current.key), [current.key]);
  const keyOf = useCallback((id: ConversationId) => conversationKey(current.key, id), [current.key]);
  const openWorkerConversation = useCallback(
    (id: ConversationId) => {
      navigate({ view: "worker", id, ...here }, mobile && route?.view === "worker");
    },
    [navigate, here, mobile, route?.view],
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
  const openProfile = useCallback(
    (pmId: PmId, page?: InfoPage) => navigate({ view: "profile", pmId, ...(page === undefined ? {} : { page }), ...here }),
    [navigate, here],
  );
  const health = useMemo(() => failingHealth(state), [state.health]);
  const quotaFetchable = useMemo(() => hasFetchedQuotaSession(state), [state.sessions]);
  const workerLine = useMemo(() => (openWorker === null ? null : workerLineOf(state, openWorker)), [state.conversations, openWorker]);
  const railPm = active?.pm?.id ?? null;
  const railWorkers = useMemo(() => (railPm === null ? EMPTY_WORKERS : workersOf(state, railPm)), [state.conversations, state.sessions, railPm]);
  const ensureWorkers = useCallback((ids: WorkerId[]) => hub.ensureWorkers(ids), [hub]);
  const railAsks = useMemo(() => (active ? pendingAsks(state, active.id) : EMPTY_ASKS), [state.conversations, state.pms, state.pending, active?.id]);
  const railProjectId = active?.project?.id ?? null;
  const railGraphs = useMemo(() => activeGraphsOf(state, railProjectId), [state.activeTaskGraphs, railProjectId]);
  const railGraphNeedsYou = useMemo(
    () => railGraphs.some((g) => g.nodes.some(isTaskNodeAwaitingUserAction)),
    [railGraphs],
  );
  const { offline, link: rawLink } = deviceNotices(current);
  const link = useMemo(
    () => (rawLink === null ? null : { readOnly: rawLink.readOnly, waiting: rawLink.waiting }),
    [rawLink?.readOnly, rawLink?.waiting],
  );
  const openNewPm = useCallback(() => setCreating(true), []);
  const refreshFleet = useCallback(() => void fleet.refresh(), [fleet.refresh]);
  const deviceSettings = useDeviceSettings(fleet.managed, fleet.devices, refreshFleet);
  const created = useCallback(
    (device: string, conversationId: ConversationId) => {
      setCreating(false);
      setPendingCreated({ device, id: conversationId });
      select({ device, id: conversationId });
    },
    [select],
  );
  const profileEntry = profile ? entries.find((e) => e.pm?.id === profile.id) : undefined;
  const railNeedsYou = railGraphs.length > 0 || railWorkers.some((w) => !w.ended);
  const railAttention = railAsks.length > 0 || railGraphNeedsYou;
  const railPeeking = railPeek !== null && railPeek === railPm;
  const railOpen = active !== null && !railClosed && (railNeedsYou || railPeeking);
  const toggleRail = useCallback(
    (forceOpen?: boolean) => {
      const closed = forceOpen === undefined ? railOpen : !forceOpen;
      setRailClosed(closed);
      saveRailClosed(closed);
      setRailPeek(closed ? null : railPm);
    },
    [railOpen, railPm],
  );
  const openAsk = useCallback(
    (messageId: MessageId) => {
      if (active && openWorker !== null) {
        const parent = { view: "conversation", id: active.id, ...here } as const;
        if (!mobile) navigate(parent);
        else mobileBack(parent, replace);
      }
      setFocus((f) => ({ id: messageId, n: (f?.n ?? 0) + 1 }));
    },
    [active, openWorker, here, mobile, navigate, replace],
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
  const routerWorking = local.state.router.commands.some((c) => c.status === "planning");
  const routerSummary = useMemo<AppRailRouter>(
    () => ({
      active: routerActive,
      pendingCount: routerView.summary.pendingCount,
      working: routerWorking,
      onSelect: selectRouter,
    }),
    [routerActive, routerView.summary.pendingCount, routerWorking, selectRouter],
  );
  const fleetHub = fleet.hub;
  const clientForDevice = useCallback((deviceKey: string) => fleetHub(deviceKey).client, [fleetHub]);
  const storeForDevice = useCallback<DeviceStoreLookup>(
    (deviceKey) => {
      const hub = fleetHub(deviceKey);
      return hub.key === deviceKey ? hub.store : null;
    },
    [fleetHub],
  );
  const openDeviceWorker = useCallback(
    (deviceKey: string, id: ConversationId) => {
      activatePickedDevice.current = false;
      setPickedDevice(mobile ? deviceKey : null);
      navigate({ view: "worker", id, ...routeDeviceOf(deviceKey) });
    },
    [mobile, navigate],
  );
  const openDeviceConversation = useCallback(
    (deviceKey: string, id: ConversationId) => {
      select({ device: deviceKey, id });
    },
    [select],
  );
  const railInputs = useStableRailInputs(fleet.devices);
  const railComputers = useMemo(() => railComputersOf(railInputs, reminders.asking), [railInputs, reminders.asking]);
  const allDevices = useMemo(
    () => railInputs.map((c) => ({ ...c, badge: railComputers.find((rc) => rc.key === c.key)?.badge ?? 0 })),
    [railInputs, railComputers],
  );
  const togglePin = useCallback((pmId: PmId, pinned: boolean) => togglePmPin(hub.client, pmId, pinned), [hub.client]);
  const accountTarget = accountSettingsTarget(fleet.devices, fleet.managed);

  const shared = { navigate, replace, navigation, qc, fleet, route, local, routedDevice, current, hub, state };
  if (!shellReady) return { ...shared, content: null };

  const view = active ? state.conversations[active.id] : undefined;
  const reconnecting = remote ? current.status === "reconnecting" : state.connection === "reconnecting";
  const workerPmEntry = active;
  const look = active?.look ?? NO_LOOK;
  const listEntries = reuseEntryList(prevEntriesRef.current, state.phase === "ready" ? entries : EMPTY_ENTRIES);
  prevEntriesRef.current = listEntries;
  const newPmDevices = !creating ? EMPTY_NEW_PM_DEVICES : newPmDevicesOf(fleet.devices, clientForDevice);
  return {
    ...shared,
    content: {
      accountTarget,
      active,
      activeId,
      actions,
      allDevices,
      look,
      clearFocus,
      clientForDevice,
      storeForDevice,
      created,
      creating,
      defaultProviderDevice: nav.settings?.providerDevice ?? current.key,
      deviceSettings,
      drafts,
      focus,
      handleLoadOlder,
      health,
      keyOf,
      link,
      listEntries,
      newPmDevices,
      offline,
      openAsk,
      openDeviceConversation,
      openDeviceWorker,
      openManageProviders,
      openNewPm,
      openProfile,
      openSettings,
      openSettingsSection,
      openWorker,
      openWorkerConversation,
      profile,
      profileEntry,
      profilePage,
      quotaFetchable,
      railAsks,
      railAttention,
      railComputers,
      railGraphs,
      railOpen,
      railProjectId,
      railWorkers,
      reconnecting,
      refreshFleet,
      reminders,
      routerActive,
      routerSummary,
      routerView,
      select,
      selectComputer,
      send,
      setCreating,
      sidebarActive,
      sidebarActiveRef,
      staging,
      togglePin,
      toggleRail,
      workTab,
      setWorkTab,
      view,
      workerLine,
      workerLoading: workerLookup === "loading" || (missingWorker !== null && workerLookup === undefined),
      workerPmEntry,
      workerView,
      ensureWorkers,
      firstRunCheck: shouldCheckFirstRunProviders ? { client: localClientRef, onDone: markProvidersGuided } : null,
    },
  };
}
