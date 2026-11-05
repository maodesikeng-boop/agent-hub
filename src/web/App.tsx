import { Loader2, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AccentScope } from "./lib/accent-scope.tsx";
import type { ConversationId, MessageId, PersonaChangeId, PmId } from "../shared/index.ts";
import { postRevertPersonaChange } from "./client.ts";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { RightRail, RightRailToggle } from "./components/RightRail.tsx";
import { WorkerConversation } from "./components/WorkerConversation.tsx";
import { PmProfile } from "./components/PmProfile.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { failingHealth, isRenewing, listConversations, pendingAsks, pendingOf, quotaResetTimes, quotaUsage, sessionOf, workerLineOf, workerPhaseOf, workersOf } from "./selectors.ts";
import { Button } from "./ui/button.tsx";
import { useWaitingReminders } from "./notify.ts";
import { useStagingStore } from "./upload.ts";
import { ModelCatalogProvider } from "./models.tsx";
import { useRoute } from "./route.ts";
import { useHub } from "./useHub.ts";
import { COMPACT_QUERY, NARROW_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const FULLPAGE = "flex h-full flex-col items-center justify-center gap-3";

/** 用户手动收起右栏后记住（docs/ui-standard.md 第 12 条）：存 "closed"；再手动展开就删掉。 */
export const RIGHT_RAIL_KEY = "agent-hub.rightRail";
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
  const hub = useHub();
  const { state } = hub;
  // 额度到了重置时间自己变（左下角的百分比、状态行的“等额度”），不用刷新页面
  useRerenderAt(quotaResetTimes(state));
  const { route, navigate, replace } = useRoute();
  const [drafts, setDrafts] = useState<Record<ConversationId, string>>({});
  const staging = useStagingStore<ConversationId>();
  const [creating, setCreating] = useState(false);
  /** 窄屏时左栏抽屉拉出来了。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
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

  const entries = listConversations(state);
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
  const active = routedEntry ?? entries[0] ?? null;
  const select = useCallback(
    (id: ConversationId) => {
      setDrawerOpen(false);
      navigate({ view: "conversation", id });
    },
    [navigate],
  );
  // 用户正开着的对话：资料页不算；打开着 Worker 的对话算它的项目经理的会话
  const activeId = profile ? null : (active?.id ?? null);
  const reminders = useWaitingReminders(state, activeId, select);

  // 网址没写（第一次打开）：落到第一个对话，并把网址改成它（不记历史）。默认选中的那个就固定在网址里，
  // 之后别的对话来了新消息排到前面也不会跳走。写了但找不到的（刚建好、服务端的变化还没到；或者编号不对）先显示第一个，网址不动，
  // 对话到了自然切过去
  const defaultId = route === null ? (entries[0]?.id ?? null) : null;
  useEffect(() => {
    if (defaultId !== null) replace({ view: "conversation", id: defaultId });
  }, [defaultId, replace]);

  if (state.phase === "loading") {
    return (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p>加载中</p>
      </div>
    );
  }
  if (state.phase === "unauthorized") {
    return (
      <div className={FULLPAGE}>
        <p>请用守护进程在终端里打印的链接打开</p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className={FULLPAGE}>
        <p>连不上守护进程</p>
        <Button onClick={() => void hub.reload()}>重试</Button>
      </div>
    );
  }

  const view = active ? state.conversations[active.id] : undefined;
  const notices = <Notices health={failingHealth(state)} reconnecting={state.connection === "reconnecting"} />;
  const profileEntry = profile ? entries.find((e) => e.pm?.id === profile.id) : undefined;
  const created = (conversationId: ConversationId) => {
    setCreating(false);
    select(conversationId);
  };
  const openWorkerConversation = (id: ConversationId) => {
    if (compact) setCompactRailOpen(false);
    navigate({ view: "worker", id });
  };
  const actions = {
    retry: state.retry,
    onRetryMessage: (messageId: number) => void hub.retryMessage(messageId),
    onOpenWorker: openWorkerConversation,
    onRevertPersona: async (changeId: PersonaChangeId) => {
      await postRevertPersonaChange(changeId);
    },
  };

  // 项目经理页面和 Worker 页面共用：草稿按对话分开，发出去就清空
  const setDraft = (id: ConversationId, value: string) => setDrafts((d) => ({ ...d, [id]: value }));
  const send = (id: ConversationId, text: string, files: File[]) => {
    // 只有文字：马上发、马上清。带文件：传完、发出之后才清，而且只清提交的这一份（文字没变才清文字、只去掉发出的那几个文件）；
    // 传失败了什么都不清（文字和文件都留着）
    // 以 / 开头的：手打的命令可能被拦（发消息 400，原因显示在输入框上方、原文留着），所以等接口回应了才清
    if (files.length === 0 && text.startsWith("/")) {
      return hub.sendChecked(id, text).then(() => setDrafts((d) => (d[id]?.trim() === text ? { ...d, [id]: "" } : d)));
    }
    if (files.length === 0) {
      setDraft(id, "");
      hub.send(id, text);
      return;
    }
    return hub.sendWithFiles(id, text, files).then(() => {
      setDrafts((d) => (d[id]?.trim() === text ? { ...d, [id]: "" } : d));
      staging.of(id).removeSent(files);
    });
  };

  const workerLine = openWorker === null ? null : workerLineOf(state, openWorker);
  const workerPmEntry = active;
  // 右栏列的是当前打开的项目经理（Worker 的对话也算它）的“等你确定”和 Worker
  const railPm = active?.pm?.id ?? null;
  const railWorkers = railPm === null ? [] : workersOf(state, railPm);
  const railAsks = active ? pendingAsks(state, active.id) : [];
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
    if (active && openWorker !== null) navigate({ view: "conversation", id: active.id });
    setFocus((f) => ({ id: messageId, n: (f?.n ?? 0) + 1 }));
  };
  // 开关跟着右栏走：并排的右栏展开时在右栏顶部，其余（收起、太窄时右栏在顶栏下面）在顶栏右边，也就是窗口右上角
  const railToggle = <RightRailToggle visible={railHasContent} open={railOpen} attention={railAsks.length > 0} onToggle={toggleRail} />;
  const toolbar = railOpen && !compact ? null : railToggle;
  const leading = narrow ? (
    <Button variant="ghost" size="icon" className="shrink-0" aria-label="对话列表" aria-expanded={drawerOpen} aria-controls="sidebar" onClick={() => setDrawerOpen(true)}>
      <PanelLeft aria-hidden="true" />
    </Button>
  ) : null;
  const rail = railOpen ? (
    <RightRail asks={railAsks} workers={railWorkers} openWorkerId={openWorker} layout={compact ? "top" : "side"} toggle={railToggle} onOpenAsk={openAsk} onOpenWorker={openWorkerConversation} />
  ) : null;
  const top = compact ? rail : null;

  return (
    <ModelCatalogProvider>
    <div className="relative flex h-full">
      <Sidebar
        entries={entries}
        activeId={profileEntry?.id ?? activeId}
        waiting={reminders.waiting}
        asking={reminders.asking}
        notify={reminders.notify}
        quota={quotaUsage(state)}
        drawerOpen={narrow && drawerOpen}
        onCloseDrawer={closeDrawer}
        onSelect={select}
        onNewPm={() => {
          setDrawerOpen(false);
          setCreating(true);
        }}
      />
      <NewPmDialog open={creating} onOpenChange={setCreating} onCreated={created} />
      {/* 项目经理的会话（对话、它的 Worker、资料页、右栏）在它的强调色里；左栏和弹窗不在 */}
      <AccentScope colorKey={active?.avatarKey ?? null}>
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col">
        {profile ? (
          <PmProfile
            key={profile.id}
            pm={profile}
            project={profileEntry?.project ?? null}
            folders={profileEntry?.folders ?? []}
            schedules={state.schedules.filter((x) => x.pmId === profile.id)}
            rev={state.personaRev[profile.id] ?? 0}
            renewing={profileEntry !== undefined && isRenewing(state, profileEntry.id)}
            onBack={() => profileEntry && select(profileEntry.id)}
          />
        ) : openWorker !== null ? (
          <WorkerConversation
            key={openWorker}
            title={workerLine?.title ?? workerView?.conversation.title ?? "Worker"}
            readonly={workerLine?.readonly ?? false}
            phase={workerPhaseOf(state, openWorker)}
            pm={{ name: workerPmEntry?.name ?? "项目经理", avatarKey: workerPmEntry?.avatarKey ?? 0 }}
            view={workerView}
            pending={pendingOf(state, openWorker)}
            session={sessionOf(state, openWorker)}
            older={state.older[openWorker]}
            draft={drafts[openWorker] ?? ""}
            staging={staging.of(openWorker)}
            leading={leading}
            toolbar={toolbar}
            top={top}
            notices={notices}
            onBack={() => workerPmEntry && select(workerPmEntry.id)}
            onDraftChange={setDraft}
            onSend={send}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={(id) => void hub.loadOlder(id)}
            actions={actions}
          />
        ) : active && view ? (
          <Conversation
            key={active.id}
            entry={active}
            view={view}
            pending={pendingOf(state, active.id)}
            session={sessionOf(state, active.id)}
            older={state.older[active.id]}
            draft={drafts[active.id] ?? ""}
            staging={staging.of(active.id)}
            leading={leading}
            toolbar={toolbar}
            top={top}
            notices={notices}
            onDraftChange={setDraft}
            onSend={send}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={(id) => void hub.loadOlder(id)}
            actions={actions}
            focus={focus}
            onFocusDone={clearFocus}
            onOpenProfile={(pmId: PmId) => navigate({ view: "profile", pmId })}
          />
        ) : (
          <>
            {notices}
            <div className="flex flex-1 items-center justify-center text-muted-foreground">还没有对话</div>
          </>
        )}
      </main>
      {!compact && rail}
      </AccentScope>
    </div>
    </ModelCatalogProvider>
  );
}
