import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { ConversationId, PersonaChangeId, PmId } from "../shared/index.ts";
import { postRevertPersonaChange } from "./client.ts";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { PmProfile } from "./components/PmProfile.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { failingHealth, listConversations, pendingOf, pmOfMessage, projectsOf, sessionOf } from "./selectors.ts";
import { Button } from "./ui/button.tsx";
import { useHub } from "./useHub.ts";

const FULLPAGE = "flex h-full flex-col items-center justify-center gap-3";

export function App() {
  const hub = useHub();
  const { state } = hub;
  const [selected, setSelected] = useState<ConversationId | null>(null);
  const [drafts, setDrafts] = useState<Record<ConversationId, string>>({});
  /** 打开着的项目经理资料页；选了左栏的对话就回到对话。 */
  const [profilePm, setProfilePm] = useState<PmId | null>(null);
  const [creating, setCreating] = useState<"pm" | "project" | null>(null);

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

  const entries = listConversations(state);
  const active = entries.find((e) => e.id === selected) ?? entries[0] ?? null;
  // 默认选中的那个固定下来，之后别的对话来了新消息排到前面也不会跳走。
  // 选中的对话还没从服务端同步过来（刚建好，响应先于变化到）就不动它，等它到了自然切过去
  if (active && selected === null) setSelected(active.id);
  const view = active ? state.conversations[active.id] : undefined;
  const notices = <Notices health={failingHealth(state)} reconnecting={state.connection === "reconnecting"} />;
  const profile = profilePm === null ? null : (state.pms.find((p) => p.id === profilePm) ?? null);
  const select = (id: ConversationId) => {
    setProfilePm(null);
    setSelected(id);
  };
  const created = (conversationId: ConversationId) => {
    setCreating(null);
    select(conversationId);
  };
  const actions = {
    retry: state.retry,
    onRetryMessage: (messageId: number) => void hub.retryMessage(messageId),
    onRevertPersona: async (changeId: PersonaChangeId) => {
      await postRevertPersonaChange(changeId);
    },
  };

  return (
    <div className="flex h-full">
      <Sidebar
        entries={entries}
        activeId={profile ? null : (active?.id ?? null)}
        onSelect={select}
        onNewPm={() => setCreating("pm")}
        onNewProject={() => setCreating("project")}
      />
      <NewPmDialog open={creating === "pm"} onOpenChange={(open) => !open && setCreating(null)} onCreated={created} />
      <NewProjectDialog open={creating === "project"} onOpenChange={(open) => !open && setCreating(null)} pms={state.pms} onCreated={created} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {profile ? (
          <PmProfile
            key={profile.id}
            pm={profile}
            projects={projectsOf(state, profile.id)}
            rev={state.personaRev[profile.id] ?? 0}
            onBack={() => setProfilePm(null)}
          />
        ) : active && view ? (
          <Conversation
            key={active.id}
            entry={active}
            view={view}
            pending={pendingOf(state, active.id)}
            session={sessionOf(state, active.id)}
            pmOf={(message) => pmOfMessage(state, message)}
            older={state.older[active.id]}
            draft={drafts[active.id] ?? ""}
            notices={notices}
            onDraftChange={(id, value) => setDrafts((d) => ({ ...d, [id]: value }))}
            onSend={(id, text) => {
              setDrafts((d) => ({ ...d, [id]: "" }));
              hub.send(id, text);
            }}
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
  );
}
