import { useCallback, useMemo, useState } from "react";
import type { ConversationId, MessageId, PmId } from "../../shared/index.ts";
import { errorText, formatArchiveRemaining, type ErrorLike } from "../format.ts";
import { visibleMessages, type ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import type { DraftSlot, StagedFiles } from "../upload.ts";
import { conversationSource } from "../composer-suggest.ts";
import { useClient } from "../device-scope.tsx";
import { DraftComposer, type ComposerLink } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { RowError } from "./SettingsList.tsx";
import { useStop } from "../useStop.ts";
import { AgentStatus, hasAgentStatus } from "./AgentStatus.tsx";

function ArchivedBanner({ pmId, archivedAt }: { pmId: PmId; archivedAt: number }) {
  const client = useClient();
  const [unarchiving, setUnarchiving] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const unarchive = async () => {
    setUnarchiving(true);
    setError(null);
    try {
      await client.postUnarchivePm(pmId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUnarchiving(false);
    }
  };
  return (
    <div className="rounded-2xl bg-sidebar px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-body">
          <span>Archived</span>
          <span className="text-minor text-muted-foreground">{formatArchiveRemaining(archivedAt)}</span>
        </div>
        <Button variant="outline" size="sm" disabled={unarchiving} onClick={() => void unarchive()}>
          {unarchiving ? "Restoring…" : "Restore"}
        </Button>
      </div>
      {error && (
        <div className="mt-2">
          <RowError error={error} />
        </div>
      )}
    </div>
  );
}

export function Conversation({
  entry,
  view,
  pending,
  session,
  older,
  draft,
  staging,
  mobile = false,
  leading,
  toolbar,
  top,
  notices,
  onSend,
  onRetry,
  onStop,
  onLoadOlder,
  actions,
  link = null,
  focus,
  onFocusDone,
  onOpenProfile,
}: {
  entry: ConversationEntry;
  view: ConversationView;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: DraftSlot;
  /** 还没发的文件、提示、发送中（和 draft 一样由 App 按对话存，见 upload.ts 的 useStagingStore）。 */
  staging: StagedFiles;
  /** 标题栏最左边：手机返回按钮。 */
  leading?: React.ReactNode;
  mobile?: boolean;
  /** 标题栏右边：右栏开关。 */
  toolbar: React.ReactNode;
  /** 太窄时放在顶栏下面的右栏。 */
  top: React.ReactNode;
  /** 顶部提醒，放在标题栏下面。 */
  notices: React.ReactNode;
  /** 只有文字：同步发出（返回 undefined）；带文件：返回 Promise，传完、发出才 resolve，失败 reject（Error.message 给用户看）。 */
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  /** 对话所在的设备连不上时输入框怎么办（见 Composer 的 link）。 */
  link?: ComposerLink | null;
  /** 要滚到并高亮的消息（右栏点开一个提问）：n 每点一次加一，点同一条也再跳一次。 */
  focus: { id: MessageId; n: number } | null;
  onFocusDone: () => void;
  onOpenProfile: (pmId: PmId) => void;
}) {
  const id = view.conversation.id;
  const stop = useStop(session, () => onStop(id));
  const client = useClient();
  const source = useMemo(() => conversationSource(id, client.url), [id, client]);
  const messages = useMemo(() => visibleMessages(view.messages), [view.messages]);
  const archived = entry.pm?.archivedAt != null;
  const messageActions = useMemo<MessageActions>(
    () => (archived ? actions : { ...actions, onAnswerAsk: (text: string) => void onSend(id, text, []) }),
    [actions, archived, id, onSend],
  );

  // agent 的消息都是这个项目经理说的（Worker 的汇报是单独的一行，点开才是 Worker 自己的对话）
  const agent = useMemo(() => ({ name: entry.name, avatarKey: entry.avatarKey }), [entry.name, entry.avatarKey]);
  const agentOf = useCallback(() => agent, [agent]);
  const handleLoadOlder = useCallback(() => onLoadOlder(id), [onLoadOlder, id]);
  const handleSend = useCallback((text: string, files: File[]) => onSend(id, text, files), [onSend, id]);
  const statusNode = useMemo(() => (hasAgentStatus(session) ? <AgentStatus session={session} /> : null), [session]);
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={entry.name} onFiles={staging.add}>
      <header data-window-drag className="flex min-h-16 shrink-0 items-center gap-3 py-3 pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]">
        {leading}
        {entry.pm ? (
          <button
            type="button"
            aria-label={`View ${entry.pm.name}'s profile`}
            className="touch-target cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => entry.pm && onOpenProfile(entry.pm.id)}
          >
            <Avatar colorKey={entry.avatarKey} size={34} className="vt-chat-avatar" />
          </button>
        ) : (
          <Avatar colorKey={entry.avatarKey} size={34} className="vt-chat-avatar" />
        )}
        <div className="min-w-0 flex-1">
          {/* 头像和名字有 view-transition-name（styles.css 的 .vt-chat-*）：切换对话时只有这两样过渡，消息列表直接换 */}
          <h1 className="vt-chat-title w-fit max-w-full truncate text-title leading-snug font-semibold">{entry.name}</h1>
        </div>
        {toolbar}
      </header>
      {top}
      {notices}
      <div className="relative min-h-0 flex-1">
        <MessageList
          messages={messages}
          pending={pending}
          agentOf={agentOf}
          hasMore={view.hasMore}
          older={older}
          onLoadOlder={handleLoadOlder}
          onRetry={onRetry}
          actions={messageActions}
          focus={focus}
          onFocusDone={onFocusDone}
          status={statusNode}
          statusAgent={agent}
        />
      </div>
      <div className="chat-column pointer-events-none relative z-10 -mt-6.5 w-full shrink-0 composer-dock *:pointer-events-auto">
        {entry.pm?.archivedAt != null ? (
          <ArchivedBanner key={entry.pm.id} pmId={entry.pm.id} archivedAt={entry.pm.archivedAt} />
        ) : (
          <DraftComposer
            autoFocus={!mobile}
            draft={draft}
            placeholder={mobile ? "Message…" : `Message ${entry.name}…`}
            staging={staging}
            stop={stop}
            link={link}
            source={source}
            onSend={handleSend}
          />
        )}
      </div>
    </FileDropZone>
  );
}
