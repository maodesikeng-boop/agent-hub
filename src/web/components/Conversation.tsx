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
  notices,
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
  /** 顶部提醒，放在标题栏下面。 */
  notices: React.ReactNode;
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
    <section className="flex min-h-0 flex-1 flex-col" aria-label={entry.name}>
      <header className="flex h-16 shrink-0 items-center gap-3 px-6">
        <Avatar colorKey={entry.avatarKey} size={34} />
        <h1 className="text-[17px] font-semibold">{entry.name}</h1>
      </header>
      {notices}
      <div className="relative min-h-0 flex-1">
        {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">还没有消息</div>}
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
      <div className="mx-auto w-full max-w-[888px] shrink-0 space-y-2.5 px-6 pb-5">
        <StatusLine agentName={entry.name} session={session} stopPhase={stopPhase} onStop={stop} />
        <Composer
          value={draft}
          placeholder={`给 ${entry.name} 发消息`}
          onChange={(v) => onDraftChange(id, v)}
          onSend={(text) => onSend(id, text)}
        />
      </div>
    </section>
  );
}
