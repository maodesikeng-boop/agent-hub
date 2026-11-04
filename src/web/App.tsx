import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { ConversationId, PersonaChangeId, PmId } from "../shared/index.ts";
import { postRevertPersonaChange } from "./client.ts";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { WorkerPanel } from "./components/WorkerPanel.tsx";
import { WorkerConversation } from "./components/WorkerConversation.tsx";
import { PmProfile } from "./components/PmProfile.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { failingHealth, isRenewing, listConversations, pendingOf, quotaResetTimes, quotaUsage, sessionOf, workerLineOf, workerPhaseOf, workersOf } from "./selectors.ts";
import { Button } from "./ui/button.tsx";
import { useWaitingReminders } from "./notify.ts";
import { useStagingStore } from "./upload.ts";
import { ModelCatalogProvider } from "./models.tsx";
import { useHub } from "./useHub.ts";
import { useRerenderAt } from "./useRerenderAt.ts";

const FULLPAGE = "flex h-full flex-col items-center justify-center gap-3";

export function App() {
  const hub = useHub();
  const { state } = hub;
  // 额度到了重置时间自己变（左下角的百分比、状态行的“等额度”），不用刷新页面
  useRerenderAt(quotaResetTimes(state));
  const [selected, setSelected] = useState<ConversationId | null>(null);
  const [drafts, setDrafts] = useState<Record<ConversationId, string>>({});
  const staging = useStagingStore<ConversationId>();
  /** 打开着的项目经理资料页；选了左栏的对话就回到对话。 */
  const [profilePm, setProfilePm] = useState<PmId | null>(null);
  const [creating, setCreating] = useState(false);
  /** 打开着的 Worker 的对话；选了左栏的对话或点“返回”就回到项目经理的会话。 */
  const [openWorker, setOpenWorker] = useState<ConversationId | null>(null);

  const entries = listConversations(state);
  const active = entries.find((e) => e.id === selected) ?? entries[0] ?? null;
  const profile = profilePm === null ? null : (state.pms.find((p) => p.id === profilePm) ?? null);
  const select = (id: ConversationId) => {
    setProfilePm(null);
    setOpenWorker(null);
    setSelected(id);
  };
  const workerView = openWorker === null ? undefined : state.conversations[openWorker];
  // Worker 的对话归派它的项目经理；对话还没同步过来就用打开它的那个会话
  const workerPm = workerView?.conversation.pmId ?? active?.pm?.id ?? null;
  const workerPmEntry = entries.find((e) => e.pm?.id === workerPm) ?? active;
  // 用户正开着的对话：资料页不算；打开着 Worker 的对话算它的项目经理的会话
  const activeId = profile ? null : ((openWorker !== null ? workerPmEntry?.id : active?.id) ?? null);
  const reminders = useWaitingReminders(state, activeId, select);

  if (state.phase === "loading") {
    return (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
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

  // 默认选中的那个固定下来，之后别的对话来了新消息排到前面也不会跳走。
  // 选中的对话还没从服务端同步过来（刚建好，响应先于变化到）就不动它，等它到了自然切过去
  if (active && selected === null) setSelected(active.id);
  const view = active ? state.conversations[active.id] : undefined;
  const notices = <Notices health={failingHealth(state)} reconnecting={state.connection === "reconnecting"} />;
  const profileEntry = profile ? entries.find((e) => e.pm?.id === profile.id) : undefined;
  const created = (conversationId: ConversationId) => {
    setCreating(false);
    select(conversationId);
  };
  const actions = {
    retry: state.retry,
    onRetryMessage: (messageId: number) => void hub.retryMessage(messageId),
    onOpenWorker: setOpenWorker,
    onRevertPersona: async (changeId: PersonaChangeId) => {
      await postRevertPersonaChange(changeId);
    },
  };

  // 项目经理页面和 Worker 页面共用：草稿按对话分开，发出去就清空
  const setDraft = (id: ConversationId, value: string) => setDrafts((d) => ({ ...d, [id]: value }));
  const send = (id: ConversationId, text: string, files: File[]) => {
    // 只有文字：马上发、马上清。带文件：传完、发出之后才清，而且只清提交的这一份（文字没变才清文字、只去掉发出的那几个文件）；
    // 传失败了什么都不清（文字和文件都留着）
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
  // 对话页顶栏右边的 Worker 按钮列的是当前打开的项目经理（Worker 的对话也算它）的 Worker
  const panelPm = (openWorker !== null ? workerPm : active?.pm?.id) ?? null;
  const workerPanel = <WorkerPanel workers={panelPm === null ? [] : workersOf(state, panelPm)} openId={openWorker} onOpen={setOpenWorker} />;

  return (
    <ModelCatalogProvider>
    <div className="relative flex h-full">
      <Sidebar
        entries={entries}
        activeId={activeId}
        waiting={reminders.waiting}
        notify={reminders.notify}
        quota={quotaUsage(state)}
        onSelect={select}
        onNewPm={() => setCreating(true)}
      />
      <NewPmDialog open={creating} onOpenChange={setCreating} onCreated={created} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {profile ? (
          <PmProfile
            key={profile.id}
            pm={profile}
            project={profileEntry?.project ?? null}
            folders={profileEntry?.folders ?? []}
            rev={state.personaRev[profile.id] ?? 0}
            renewing={profileEntry !== undefined && isRenewing(state, profileEntry.id)}
            onBack={() => setProfilePm(null)}
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
            stats={workerPanel}
            notices={notices}
            onBack={() => setOpenWorker(null)}
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
            stats={workerPanel}
            notices={notices}
            onDraftChange={setDraft}
            onSend={send}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={(id) => void hub.loadOlder(id)}
            actions={actions}
            onOpenProfile={setProfilePm}
          />
        ) : (
          <>
            {notices}
            <div className="flex flex-1 items-center justify-center text-muted-foreground">还没有对话</div>
          </>
        )}
      </main>
    </div>
    </ModelCatalogProvider>
  );
}
