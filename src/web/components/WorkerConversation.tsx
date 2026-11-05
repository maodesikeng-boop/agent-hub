import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import type { ConversationId, SessionState } from "../../shared/index.ts";
import type { WorkerPhase } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { conversationSource } from "../composer-suggest.ts";
import { Composer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { useStop } from "../useStop.ts";
import { AgentStatus, hasAgentStatus } from "./AgentStatus.tsx";

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
  leading,
  toolbar,
  top,
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
  /** 标题栏最左边：窄屏时拉出左栏的按钮。 */
  leading: React.ReactNode;
  /** 标题栏右边：右栏开关。 */
  toolbar: React.ReactNode;
  /** 太窄时放在顶栏下面的右栏。 */
  top: React.ReactNode;
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
  const stop = useStop(session, id === undefined ? null : () => onStop(id));
  const source = useMemo(() => (id === undefined ? undefined : conversationSource(id)), [id]);

  // Worker 统一用中性灰的头像（docs/ui-standard.md 第 17 条）
  const identity = { name: title, avatarKey: id ?? 0, neutral: true };
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={`Worker ${title}`} onFiles={(files) => phase === "open" && staging.add(files)}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 py-3 pr-4 pl-[var(--chat-inset)]">
        {leading}
        <Button variant="ghost" size="icon" aria-label={`返回 ${pm.name}`} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Avatar colorKey={identity.avatarKey} size={34} neutral />
        <h1 className="min-w-0 truncate text-[17px] leading-snug font-semibold">{title}</h1>
        {readonly && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">只读</span>}
        <span className="flex-1" />
        {toolbar}
      </header>
      {top}
      {notices}
      {view === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">找不到这个 Worker 的对话</div>
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <MessageList
              messages={view.messages}
              pending={pending}
              agentOf={(message) => (message.sender === "pm" ? pm : identity)}
              hasMore={view.hasMore}
              older={older}
              onLoadOlder={() => onLoadOlder(view.conversation.id)}
              onRetry={onRetry}
              actions={actions}
              status={hasAgentStatus(session) ? <AgentStatus session={session} /> : null}
              statusAgent={identity}
            />
          </div>
          <div className="chat-column w-full shrink-0 pb-5 empty:hidden">
            {phase !== "ended" && (
              <Composer
                autoFocus
                value={draft}
                placeholder={phase === "preparing" ? `${title} 还在准备` : `给 ${title} 发消息`}
                disabled={phase === "preparing"}
                stop={stop}
                source={source}
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
