import { QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccentScope } from "./lib/accent-scope.tsx";
import { isAgentVendor, type ConversationId, type MessageId, type PersonaChangeId, type PmId } from "../shared/index.ts";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { RightRail, RightRailToggle } from "./components/RightRail.tsx";
import { WorkerConversation } from "./components/WorkerConversation.tsx";
import { PmProfile } from "./components/PmProfile.tsx";
import { Sidebar, type SidebarGroup } from "./components/Sidebar.tsx";
import { useDevices } from "./device-hub.ts";
import { DeviceScope } from "./device-scope.tsx";
import { errorTitle } from "./format.ts";
import { LOCAL_DEVICE, conversationKey, deviceKeyOf, deviceNotices, routeDeviceOf } from "./devices.ts";
import { useHubQueryClient } from "./query-client.ts";
import {
  failingHealth,
  isRenewing,
  listConversations,
  pendingAsks,
  pendingOf,
  quotaResetTimes,
  quotaUsage,
  hasFetchedQuotaSession,
  sessionOf,
  visibleSessionOf,
  workerLineOf,
  workerPhaseOf,
  workersOf,
} from "./selectors.ts";
import { Button } from "./ui/button.tsx";
import { useDeviceReminders, type ConversationRef } from "./notify.ts";
import { useDraftStore, useStagingStore } from "./upload.ts";
import { ModelCatalogProvider } from "./models.tsx";
import { useRoute } from "./route.ts";
import { COMPACT_QUERY, NARROW_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const FULLPAGE = "flex h-full flex-col items-center justify-center gap-3";
const DRAG_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-drag]';

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

export function App() {
  const qc = useHubQueryClient();
  const fleet = useDevices();
  const { route, navigate, replace } = useRoute();
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
  // 网址指的项目经理对话：直接是对话；Worker 的对话归派它的项目经理；资料页是那个项目经理的对话
  const routedEntry =
    route === null
      ? undefined
      : route.view === "conversation"
        ? entries.find((e) => e.id === route.id)
        : route.view === "worker"
          ? entries.find((e) => e.pm !== null && e.pm.id === workerView?.conversation.pmId)
          : entries.find((e) => e.pm?.id === route.pmId);
  const firstUnarchived = entries.find((e) => e.pm?.archivedAt == null) ?? entries[0];
  const active = routedEntry ?? firstUnarchived ?? null;
  const select = useCallback(
    (ref: ConversationRef) => {
      navigate({ view: "conversation", id: ref.id, ...routeDeviceOf(ref.device) });
    },
    [navigate],
  );
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

  // 网址没写（第一次打开）：落到第一个对话，并把网址改成它（不记历史）。默认选中的那个就固定在网址里，
  // 之后别的对话来了新消息排到前面也不会跳走。写了但找不到的（刚建好、服务端的变化还没到；或者编号不对）先显示第一个，网址不动，
  // 对话到了自然切过去
  const defaultId = route === null ? (firstUnarchived?.id ?? null) : null;
  useEffect(() => {
    if (defaultId !== null) replace({ view: "conversation", id: defaultId });
  }, [defaultId, replace]);
  // 网址写的设备清单里没有（编号不对、已经移除了）：回到入口本机
  const unknownDevice = fleet.listed && route?.device !== undefined && routedDevice === undefined;
  const localEntries = useMemo(
    () => (local.state.phase === "ready" ? (local.key === current.key ? entries : listConversations(local.state)) : []),
    [local.state, local.key, current.key, entries],
  );
  const localFirst = (localEntries.find((e) => e.pm?.archivedAt == null) ?? localEntries[0])?.id ?? null;
  useEffect(() => {
    if (unknownDevice && localFirst !== null) replace({ view: "conversation", id: localFirst });
  }, [unknownDevice, localFirst, replace]);

  const here = useMemo(() => routeDeviceOf(current.key), [current.key]);
  const keyOf = useCallback((id: ConversationId) => conversationKey(current.key, id), [current.key]);
  const openWorkerConversation = useCallback(
    (id: ConversationId) => {
      if (compact) setCompactRailOpen(false);
      navigate({ view: "worker", id, ...here });
    },
    [compact, navigate, here],
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
      if (files.length === 0 && text.startsWith("/")) {
        return hub.sendChecked(id, text).then(() => slot.clearIfMatch(text));
      }
      if (files.length === 0) {
        slot.set("");
        hub.send(id, text);
        return;
      }
      return hub.sendWithFiles(id, text, files).then(() => {
        slot.clearIfMatch(text);
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
  const railWorkers = useMemo(() => (railPm === null ? [] : workersOf(state, railPm)), [state.conversations, state.sessions, railPm]);
  const railAsks = useMemo(() => (active ? pendingAsks(state, active.id) : []), [state.conversations, state.pms, state.pending, active?.id]);
  // 别的设备连不上（联机第 4.3 节）：离线时提示显示的是多久以前的内容、只读；重连中照常显示，发送等连上。入口本机照旧
  const { offline, link: rawLink } = deviceNotices(current);
  const link = useMemo(
    () => (rawLink === null ? null : { readOnly: rawLink.readOnly, waiting: rawLink.waiting }),
    [rawLink?.readOnly, rawLink?.waiting],
  );

  // 整页的加载中、没登录、连不上只看入口本机；别的设备连不上在主区里说
  if (local.state.phase === "loading" || (route?.device !== undefined && routedDevice === undefined && !fleet.listed)) {
    return (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    );
  }
  if (local.state.phase === "unauthorized") {
    return (
      <div className={FULLPAGE} data-testid="unauthenticated">
        <p>Not signed in. On your computer, open the sign-in link printed in the terminal at startup. On a phone, scan the code from Settings → Security &amp; Access → Sign in on phone on a signed-in computer</p>
      </div>
    );
  }
  if (local.state.phase === "error") {
    return (
      <div className={FULLPAGE}>
        <p title={local.state.loadError ? errorTitle(local.state.loadError) : undefined}>{local.state.loadError?.text ?? "连不上守护进程"}</p>
        {local.state.loadError?.hint && <p>{local.state.loadError.hint}</p>}
        <p className="text-minor text-muted-foreground">If the service isn't running, run pnpm start in the project folder</p>
        <Button onClick={() => void fleet.hub(LOCAL_DEVICE).reload()}>Retry</Button>
      </div>
    );
  }

  const view = active ? state.conversations[active.id] : undefined;
  const reconnecting = remote ? current.status === "reconnecting" : state.connection === "reconnecting";
  const notices = <Notices health={health} reconnecting={reconnecting} offline={offline} listFailed={fleet.listFailed} />;
  const profileEntry = profile ? entries.find((e) => e.pm?.id === profile.id) : undefined;
  const created = (device: string, conversationId: ConversationId) => {
    setCreating(false);
    select({ device, id: conversationId });
  };
  const workerPmEntry = active;
  // 右栏列的是当前打开的项目经理（Worker 的对话也算它）的“等你确定”和 Worker
  const railHasContent = !profile && (railWorkers.length > 0 || railAsks.length > 0);
  // 有要关心的事才自动出来：有没收工的 Worker（在干活、等验收）或有没回答的提问；只有收工的 Worker 时整栏不出来，点开关才手动看
  const railNeedsYou = !profile && (railAsks.length > 0 || railWorkers.some((w) => !w.ended));
  const railPeeking = railPeek !== null && railPeek === railPm;
  const railOpen = railHasContent && (compact ? compactRailOpen : !railClosed && (railNeedsYou || railPeeking));
  const toggleRail = () => {
    if (compact) {
      setCompactRailOpen((v) => !v);
      return;
    }
    const closed = railOpen;
    setRailClosed(closed);
    saveRailClosed(closed);
    // 手动打开、而又没有要关心的事：记下来，右栏才不会马上又收回去（只在这个项目经理、这次打开期间）
    setRailPeek(closed || railNeedsYou ? null : railPm);
  };
  const openAsk = (messageId: MessageId) => {
    if (active && openWorker !== null) navigate({ view: "conversation", id: active.id, ...here });
    setFocus((f) => ({ id: messageId, n: (f?.n ?? 0) + 1 }));
  };
  const avatarKey = active?.avatarKey ?? 0;
  // 开关跟着右栏走：并排的右栏展开时在右栏顶部，其余（收起、太窄时右栏在顶栏下面）在顶栏右边，也就是窗口右上角
  const railToggle = <RightRailToggle visible={railHasContent} open={railOpen} attention={railAsks.length > 0} avatarKey={avatarKey} onToggle={toggleRail} />;
  const toolbar = railOpen && !compact ? null : railToggle;
  const rail = railOpen ? (
    <RightRail asks={railAsks} workers={railWorkers} openWorkerId={openWorker} layout={compact ? "top" : "side"} toggle={railToggle} avatarKey={avatarKey} onOpenAsk={openAsk} onOpenWorker={openWorkerConversation} />
  ) : null;
  const top = compact ? rail : null;

  const sidebarActive = profileEntry?.id ?? activeId;
  const groups: SidebarGroup[] = fleet.devices.map((d) => ({
    key: d.key,
    name: d.info.name,
    platform: d.info.platform,
    status: d.status,
    lastOnlineAt: d.lastOnlineAt,
    entries: d.state.phase === "ready" ? (d.key === current.key ? entries : listConversations(d.state)) : [],
  }));
  const newPmDevices = fleet.devices.map((d) => ({ key: d.key, name: d.info.name, status: d.status, client: fleet.hub(d.key).client, server: d.state.server }));
  // 别的设备还没加载好：加载中，或者一次都没连上（联机第 4.3 节）
  const deviceWaiting =
    state.phase === "ready" ? null : current.status === "connecting" ? (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    ) : (
      <div className={FULLPAGE}>
        <p>Not connected to this computer yet</p>
        <p className="text-minor text-muted-foreground">Check that Tailscale is on and the daemon is running on {current.info.name}</p>
      </div>
    );

  return (
    <QueryClientProvider client={qc}>
    <DeviceScope client={hub.client} server={state.server}>
    <ModelCatalogProvider>
    <div className="relative flex h-full">
      <Sidebar
        groups={groups}
        active={sidebarActive === null ? null : { device: current.key, id: sidebarActive }}
        waiting={reminders.waiting}
        asking={reminders.asking}
        notify={reminders.notify}
        devices={
          fleet.managed
            ? {
                devices: fleet.devices,
                ...(local.state.tunnel !== undefined ? { tunnel: local.state.tunnel } : {}),
                ...(local.state.publicEntry !== undefined ? { publicEntry: local.state.publicEntry } : {}),
                ...(local.state.server.repoDir !== undefined ? { repoDir: local.state.server.repoDir } : {}),
                onChanged: () => void fleet.refresh(),
              }
            : null
        }
        quota={quotaUsage(state)}
        quotaFetchable={quotaFetchable}
        narrow={narrow}
        onSelect={select}
        onNewPm={() => {
          setCreating(true);
        }}
      />
      <NewPmDialog open={creating} devices={newPmDevices} defaultDevice={current.key} onOpenChange={setCreating} onCreated={created} />
      {/* 项目经理的会话（对话、它的 Worker、资料页、右栏）在它的强调色里；左栏和弹窗不在 */}
      <AccentScope colorKey={active?.avatarKey ?? null}>
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col">
        {deviceWaiting ? (
          <>
            <header data-window-drag className="flex h-16 shrink-0 items-center px-3" />
            {deviceWaiting}
          </>
        ) : profile ? (
          <PmProfile
            key={keyOf(profile.id)}
            pm={profile}
            project={profileEntry?.project ?? null}
            folders={profileEntry?.folders ?? []}
            schedules={state.schedules.filter((x) => x.pmId === profile.id)}
            rev={state.personaRev[profile.id] ?? 0}
            renewing={profileEntry !== undefined && isRenewing(state, profileEntry.id)}
            onBack={() => profileEntry && select({ device: current.key, id: profileEntry.id })}
          />
        ) : openWorker !== null ? (
          <WorkerConversation
            key={keyOf(openWorker)}
            title={workerLine?.title ?? workerView?.conversation.title ?? "Piece"}
            readonly={workerLine?.readonly ?? false}
            phase={workerPhaseOf(state, openWorker)}
            pm={{ name: workerPmEntry?.name ?? "Project manager", avatarKey: workerPmEntry?.avatarKey ?? 0 }}
            meta={railWorkers.find((w) => w.conversationId === openWorker)}
            view={workerView}
            pending={pendingOf(state, openWorker)}
            session={sessionOf(state, openWorker)}
            older={state.older[openWorker]}
            draft={drafts.of(keyOf(openWorker))}
            staging={staging.of(keyOf(openWorker))}
            toolbar={toolbar}
            top={top}
            notices={notices}
            onBack={() => workerPmEntry && select({ device: current.key, id: workerPmEntry.id })}
            onSend={send}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={handleLoadOlder}
            actions={actions}
            link={link}
          />
        ) : active && view ? (
          <Conversation
            key={keyOf(active.id)}
            entry={active}
            view={view}
            pending={pendingOf(state, active.id)}
            session={visibleSessionOf(state, active.id)}
            older={state.older[active.id]}
            draft={drafts.of(keyOf(active.id))}
            staging={staging.of(keyOf(active.id))}
            toolbar={toolbar}
            top={top}
            notices={notices}
            onSend={send}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={handleLoadOlder}
            actions={actions}
            focus={focus}
            onFocusDone={clearFocus}
            onOpenProfile={openProfile}
            link={link}
          />
        ) : (
          <>
            {notices}
            <div className="flex flex-1 items-center justify-center text-muted-foreground">No conversations yet</div>
          </>
        )}
      </main>
      {!compact && rail}
      </AccentScope>
    </div>
    </ModelCatalogProvider>
    </DeviceScope>
    </QueryClientProvider>
  );
}
