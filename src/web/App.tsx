import { useState } from "react";
import type { ConversationId } from "../shared/index.ts";
import { Conversation } from "./components/Conversation.tsx";
import { Notices } from "./components/Notices.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { failingHealth, listConversations, pendingOf, sessionOf } from "./selectors.ts";
import { useHub } from "./useHub.ts";

export function App() {
  const hub = useHub();
  const { state } = hub;
  const [selected, setSelected] = useState<ConversationId | null>(null);
  const [drafts, setDrafts] = useState<Record<ConversationId, string>>({});

  if (state.phase === "loading") {
    return (
      <div className="fullpage">
        <span className="spinner" aria-hidden="true" />
        <p>加载中</p>
      </div>
    );
  }
  if (state.phase === "unauthorized") {
    return (
      <div className="fullpage">
        <p>请用守护进程在终端里打印的链接打开</p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="fullpage">
        <p>连不上守护进程</p>
        <button type="button" className="primary-button" onClick={() => void hub.reload()}>
          重试
        </button>
      </div>
    );
  }

  const entries = listConversations(state);
  const active = entries.find((e) => e.id === selected) ?? entries[0] ?? null;
  // 默认选中的那个固定下来，之后别的对话来了新消息排到前面也不会跳走
  if (active && selected !== active.id) setSelected(active.id);
  const view = active ? state.conversations[active.id] : undefined;

  return (
    <div className="app">
      <Sidebar entries={entries} activeId={active?.id ?? null} onSelect={setSelected} />
      <main className="main">
        <Notices health={failingHealth(state)} reconnecting={state.connection === "reconnecting"} />
        {active && view ? (
          <Conversation
            key={active.id}
            entry={active}
            view={view}
            pending={pendingOf(state, active.id)}
            session={sessionOf(state, active.id)}
            older={state.older[active.id]}
            draft={drafts[active.id] ?? ""}
            onDraftChange={(id, value) => setDrafts((d) => ({ ...d, [id]: value }))}
            onSend={(id, text) => {
              setDrafts((d) => ({ ...d, [id]: "" }));
              hub.send(id, text);
            }}
            onRetry={hub.retrySend}
            onStop={hub.stop}
            onLoadOlder={(id) => void hub.loadOlder(id)}
          />
        ) : (
          <div className="empty">还没有对话</div>
        )}
      </main>
    </div>
  );
}
