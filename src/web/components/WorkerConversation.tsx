import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationId, SessionState } from "../../shared/index.ts";
import type { ConversationView, OlderState } from "../state.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { StatusLine, type StopPhase } from "./StatusLine.tsx";

/** 点开项目经理会话里的 Worker 那一行看到的：这个 Worker 自己的对话，只看不发（M3 用户不直接跟 Worker 说话，m3-plan 第 1 节）。 */
export function WorkerConversation({
  title,
  readonly,
  pm,
  view,
  session,
  older,
  stats,
  notices,
  onBack,
  onStop,
  onLoadOlder,
  actions,
}: {
  title: string;
  readonly: boolean;
  /** 派它的项目经理：返回按钮上的名字，也是 Worker 对话里项目经理那些话（任务、打回）的署名。 */
  pm: { name: string; avatarKey: number };
  /** 找不到（还没同步过来）是 undefined。 */
  view: ConversationView | undefined;
  session: SessionState | null;
  older: OlderState | undefined;
  /** 标题栏右边的额度和在跑的 Worker 数。 */
  stats: React.ReactNode;
  notices: React.ReactNode;
  onBack: () => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
}) {
  const id = view?.conversation.id;
  const [stopPhase, setStopPhase] = useState<StopPhase>("idle");
  const activity = session?.activity ?? "idle";

  useEffect(() => {
    if (activity === "idle") setStopPhase("idle");
  }, [activity]);

  const stop = () => {
    if (id === undefined) return;
    setStopPhase("sending");
    onStop(id).then(
      () => setStopPhase("requested"),
      () => setStopPhase("failed"),
    );
  };

  const identity = { name: title, avatarKey: id ?? 0 };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={`Worker · ${title}`}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 px-6 py-3">
        <Button variant="ghost" size="icon" aria-label={`返回 ${pm.name}`} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Avatar colorKey={identity.avatarKey} size={34} />
        <h1 className="min-w-0 truncate text-[17px] leading-snug font-semibold">{title}</h1>
        {readonly && <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-[13px] font-medium">只读</span>}
        {stats}
      </header>
      {notices}
      {view === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">找不到这个 Worker 的对话</div>
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            {view.messages.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">还没有消息</div>
            )}
            <MessageList
              messages={view.messages}
              pending={[]}
              agentOf={(message) => (message.sender === "pm" ? pm : identity)}
              hasMore={view.hasMore}
              older={older}
              onLoadOlder={() => onLoadOlder(view.conversation.id)}
              onRetry={() => {}}
              actions={actions}
            />
          </div>
          <div className="mx-auto w-full max-w-[888px] shrink-0 space-y-2.5 px-6 pb-5 empty:hidden">
            <StatusLine agentName={title} session={session} stopPhase={stopPhase} onStop={stop} />
          </div>
        </>
      )}
    </section>
  );
}
