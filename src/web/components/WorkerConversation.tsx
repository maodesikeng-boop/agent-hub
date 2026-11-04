import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationId, SessionState } from "../../shared/index.ts";
import type { WorkerPhase } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { Composer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { StatusLine, type StopPhase } from "./StatusLine.tsx";

/**
 * 点开项目经理会话里的 Worker 那一行看到的：这个 Worker 自己的对话。用户可以直接对它说话，输入框、草稿、乐观显示、
 * 重试和项目经理页面（Conversation）是同一套。收工了（selectors.ts 的 workerPhaseOf）不显示输入框，还在准备时输入框不可用。
 */
export function WorkerConversation({
  title,
  readonly,
  phase,
  pm,
  view,
  pending,
  session,
  older,
  draft,
  staging,
  notices,
  onBack,
  onDraftChange,
  onSend,
  onRetry,
  onStop,
  onLoadOlder,
  actions,
}: {
  title: string;
  readonly: boolean;
  phase: WorkerPhase;
  /** 派它的项目经理：返回按钮上的名字，也是 Worker 对话里项目经理那些话（任务、打回）的署名。 */
  pm: { name: string; avatarKey: number };
  /** 找不到（还没同步过来）是 undefined。 */
  view: ConversationView | undefined;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: string;
  /** 还没发的文件（和项目经理页面同一套，见 upload.ts 的 useStagingStore）。 */
  staging: StagedFiles;
  /** 标题栏右边：Worker 按钮。 */
  stats: React.ReactNode;
  notices: React.ReactNode;
  onBack: () => void;
  onDraftChange: (conversationId: ConversationId, value: string) => void;
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
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
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={`Worker · ${title}`} onFiles={(files) => phase === "open" && staging.add(files)}>
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
            {view.messages.length === 0 && pending.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">还没有消息</div>
            )}
            <MessageList
              messages={view.messages}
              pending={pending}
              agentOf={(message) => (message.sender === "pm" ? pm : identity)}
              hasMore={view.hasMore}
              older={older}
              onLoadOlder={() => onLoadOlder(view.conversation.id)}
              onRetry={onRetry}
              actions={actions}
            />
          </div>
          <div className="mx-auto w-full max-w-[888px] shrink-0 space-y-2.5 px-6 pb-5 empty:hidden">
            <StatusLine agentName={title} session={session} stopPhase={stopPhase} onStop={stop} />
            {phase !== "ended" && (
              <Composer
                value={draft}
                placeholder={phase === "preparing" ? `${title} 还在准备` : `给 ${title} 发消息`}
                disabled={phase === "preparing"}
                onChange={(v) => onDraftChange(view.conversation.id, v)}
                staging={staging}
                onSend={(text, files) => onSend(view.conversation.id, text, files)}
              />
            )}
          </div>
        </>
      )}
    </FileDropZone>
  );
}
