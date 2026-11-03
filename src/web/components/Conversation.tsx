import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationId, PmId } from "../../shared/index.ts";
import type { ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Avatar, EntryAvatar } from "./Avatar.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
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
  actions,
  onOpenProfile,
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
  actions: MessageActions;
  onOpenProfile: (pmId: PmId) => void;
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
  // 群里说话的是项目现在的项目经理
  const agent = { name: entry.pm?.name ?? entry.name, avatarKey: entry.pm?.id ?? entry.avatarKey };
  const isGroup = entry.kind === "project_group";
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={entry.name}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 px-6 py-3">
        {entry.pm && !isGroup ? (
          <button
            type="button"
            aria-label={`查看 ${entry.pm.name} 的资料`}
            className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => entry.pm && onOpenProfile(entry.pm.id)}
          >
            <Avatar colorKey={entry.avatarKey} size={34} />
          </button>
        ) : (
          <EntryAvatar kind={entry.kind} name={entry.name} colorKey={entry.avatarKey} size={34} />
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[17px] leading-snug font-semibold">{entry.name}</h1>
          {isGroup && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-[13px] text-muted-foreground">
              {entry.pm && (
                <button
                  type="button"
                  aria-label={`查看 ${entry.pm.name} 的资料`}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => entry.pm && onOpenProfile(entry.pm.id)}
                >
                  <Avatar colorKey={entry.pm.id} size={16} />
                  {entry.pm.name}
                </button>
              )}
              {entry.folders.length > 0 && (
                <ul aria-label="文件夹" className="flex min-w-0 flex-wrap gap-x-4">
                  {entry.folders.map((f) => (
                    <li key={f.id} className="flex min-w-0 items-center gap-1.5" title={f.path}>
                      <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{f.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
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
          actions={actions}
        />
      </div>
      <div className="mx-auto w-full max-w-[888px] shrink-0 space-y-2.5 px-6 pb-5">
        <StatusLine agentName={agent.name} session={session} stopPhase={stopPhase} onStop={stop} />
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
