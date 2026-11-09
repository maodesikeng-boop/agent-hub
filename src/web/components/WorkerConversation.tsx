import { ArrowLeft } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ConversationId, Message, SessionState } from "../../shared/index.ts";
import type { WorkerEntry, WorkerPhase } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { DraftSlot, StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { conversationSource } from "../composer-suggest.ts";
import { useClient } from "../device-scope.tsx";
import { DraftComposer, type ComposerLink } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { useStop } from "../useStop.ts";
import { AgentStatus, hasAgentStatus } from "./AgentStatus.tsx";
import { PieceMeta } from "./RightRail.tsx";

/**
 * 点开项目经理会话里的 Worker 那一行看到的：这个 Worker 自己的对话。用户可以直接对它说话，输入框、草稿、乐观显示、
 * 重试和项目经理页面（Conversation）是同一套。收工了（selectors.ts 的 workerPhaseOf）不显示输入框，还在准备时输入框不可用。
 */
export function WorkerConversation({
  title,
  readonly,
  phase,
  pm,
  meta,
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
  onSend,
  onRetry,
  onStop,
  onLoadOlder,
  actions,
  link = null,
}: {
  title: string;
  readonly: boolean;
  phase: WorkerPhase;
  /** 派它的项目经理：返回按钮上的名字，也是 Worker 对话里项目经理那些话（任务、打回）的署名。 */
  pm: { name: string; avatarKey: number };
  /** 右栏里这个 Piece 的那一项：顶栏右边显示它的模型、思考程度、对话长度；找不到不显示。 */
  meta?: WorkerEntry;
  /** 找不到（还没同步过来）是 undefined。 */
  view: ConversationView | undefined;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: DraftSlot;
  /** 还没发的文件（和项目经理页面同一套，见 upload.ts 的 useStagingStore）。 */
  staging: StagedFiles;
  /** 标题栏最左边：窄屏时拉出左栏的按钮。 */
  leading?: React.ReactNode;
  /** 标题栏右边：右栏开关。 */
  toolbar: React.ReactNode;
  /** 太窄时放在顶栏下面的右栏。 */
  top: React.ReactNode;
  notices: React.ReactNode;
  onBack: () => void;
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  /** 对话所在的设备连不上时输入框怎么办（见 Composer 的 link）。 */
  link?: ComposerLink | null;
}) {
  const id = view?.conversation.id;
  const stop = useStop(session, id === undefined ? null : () => onStop(id));
  const client = useClient();
  const source = useMemo(() => (id === undefined ? undefined : conversationSource(id, client.url)), [id, client]);

  // Worker 头像用所属项目经理对应水果切下的一瓣（docs/ui-standard.md 第 17 条）
  const identity = useMemo(() => ({ name: title, avatarKey: pm.avatarKey, neutral: true }), [title, pm.avatarKey]);
  const pmIdentity = useMemo(() => ({ name: pm.name, avatarKey: pm.avatarKey }), [pm.name, pm.avatarKey]);
  const agentOf = useCallback((message: Message) => (message.sender === "pm" ? pmIdentity : identity), [pmIdentity, identity]);
  const handleLoadOlder = useCallback(() => {
    if (id !== undefined) onLoadOlder(id);
  }, [onLoadOlder, id]);
  const handleSend = useCallback((text: string, files: File[]) => (id === undefined ? undefined : onSend(id, text, files)), [onSend, id]);
  const statusNode = useMemo(() => (hasAgentStatus(session) ? <AgentStatus session={session} /> : null), [session]);
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={`Piece ${title}`} onFiles={(files, skipped) => phase === "open" && staging.add(files, skipped)}>
      <header data-window-drag className="flex min-h-16 shrink-0 items-center gap-3 py-3 pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]">
        {leading}
        <Button variant="ghost" size="icon" aria-label={`Back to ${pm.name}`} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Avatar colorKey={identity.avatarKey} size={34} neutral />
        <h1 className="min-w-0 truncate text-title leading-snug font-semibold">{title}</h1>
        {readonly && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">Read-only</span>}
        <span className="flex-1" />
        {meta && <PieceMeta worker={meta} />}
        {toolbar}
      </header>
      {top}
      {notices}
      {view === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">Piece not found</div>
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <MessageList
              messages={view.messages}
              pending={pending}
              agentOf={agentOf}
              hasMore={view.hasMore}
              older={older}
              onLoadOlder={handleLoadOlder}
              onRetry={onRetry}
              actions={actions}
              status={statusNode}
              statusAgent={identity}
            />
          </div>
          <div className="chat-column pointer-events-none relative z-10 -mt-6.5 w-full shrink-0 pb-5 *:pointer-events-auto empty:hidden">
            {phase !== "ended" && (
              <DraftComposer
                autoFocus
                draft={draft}
                placeholder={phase === "preparing" ? `${title} is setting up…` : `Message ${title}…`}
                disabled={phase === "preparing"}
                stop={stop}
                link={link}
                source={source}
                staging={staging}
                onSend={handleSend}
              />
            )}
          </div>
        </>
      )}
    </FileDropZone>
  );
}
