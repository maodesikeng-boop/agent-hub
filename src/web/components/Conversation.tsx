import { useEffect, useState } from "react";
import type { ConversationId } from "../../shared/index.ts";
import type { ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Avatar } from "./Avatar.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { StatusLine, type StopPhase } from "./StatusLine.tsx";

export function Conversation({
  entry,
  view,
  pending,
  session,
  older,
  draft,
  onDraftChange,
  onSend,
  onRetry,
  onStop,
  onLoadOlder,
}: {
  entry: ConversationEntry;
  view: ConversationView;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: string;
  onDraftChange: (conversationId: ConversationId, value: string) => void;
  onSend: (conversationId: ConversationId, text: string) => void;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onLoadOlder: (conversationId: ConversationId) => void;
}) {
  const id = view.conversation.id;
  const [stopPhase, setStopPhase] = useState<StopPhase>("idle");
  const activity = session?.activity ?? "idle";

  // 这一轮结束了，下一轮又能点“停止”
  useEffect(() => {
    if (activity === "idle") setStopPhase("idle");
  }, [activity]);

  const stop = () => {
    setStopPhase("sending");
    onStop(id).then(
      () => setStopPhase("requested"),
      () => setStopPhase("failed"),
    );
  };

  const empty = view.messages.length === 0 && pending.length === 0;
  const agent = { name: entry.name, avatarKey: entry.avatarKey };
  return (
    <section className="conversation" aria-label={entry.name}>
      <header className="conversation-header">
        <Avatar name={entry.name} colorKey={entry.avatarKey} />
        <h1>{entry.name}</h1>
      </header>
      <div className="conversation-body">
        {empty && <div className="empty">还没有消息</div>}
        <MessageList
          messages={view.messages}
          pending={pending}
          agent={agent}
          hasMore={view.hasMore}
          older={older}
          onLoadOlder={() => onLoadOlder(id)}
          onRetry={onRetry}
        />
      </div>
      <StatusLine agentName={entry.name} session={session} stopPhase={stopPhase} onStop={stop} />
      <Composer value={draft} onChange={(v) => onDraftChange(id, v)} onSend={(text) => onSend(id, text)} />
    </section>
  );
}
