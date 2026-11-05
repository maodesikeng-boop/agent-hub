import { Folder } from "lucide-react";
import { useMemo } from "react";
import type { ConversationId, MessageId, PmId } from "../../shared/index.ts";
import { shortPath } from "../format.ts";
import type { ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Avatar } from "./Avatar.tsx";
import type { StagedFiles } from "../upload.ts";
import { conversationSource } from "../composer-suggest.ts";
import { Composer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { useStop } from "../useStop.ts";
import { AgentStatus, hasAgentStatus } from "./AgentStatus.tsx";

export function Conversation({
  entry,
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
  onDraftChange,
  onSend,
  onRetry,
  onStop,
  onLoadOlder,
  actions,
  focus,
  onOpenProfile,
}: {
  entry: ConversationEntry;
  view: ConversationView;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: string;
  /** 还没发的文件、提示、发送中（和 draft 一样由 App 按对话存，见 upload.ts 的 useStagingStore）。 */
  staging: StagedFiles;
  /** 标题栏最左边：窄屏时拉出左栏的按钮。 */
  leading: React.ReactNode;
  /** 标题栏右边：右栏开关。 */
  toolbar: React.ReactNode;
  /** 太窄时放在顶栏下面的右栏。 */
  top: React.ReactNode;
  /** 顶部提醒，放在标题栏下面。 */
  notices: React.ReactNode;
  onDraftChange: (conversationId: ConversationId, value: string) => void;
  /** 只有文字：同步发出（返回 undefined）；带文件：返回 Promise，传完、发出才 resolve，失败 reject（Error.message 给用户看）。 */
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  /** 要滚到并高亮的消息（右栏点开一个提问）：n 每点一次加一，点同一条也再跳一次。 */
  focus: { id: MessageId; n: number } | null;
  onOpenProfile: (pmId: PmId) => void;
}) {
  const id = view.conversation.id;
  const stop = useStop(session, () => onStop(id));
  const source = useMemo(() => conversationSource(id), [id]);

  // agent 的消息都是这个项目经理说的（Worker 的汇报是单独的一行，点开才是 Worker 自己的对话）
  const agent = { name: entry.name, avatarKey: entry.avatarKey };
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={entry.name} onFiles={staging.add}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 py-3 pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]">
        {leading}
        {entry.pm ? (
          <button
            type="button"
            aria-label={`查看 ${entry.pm.name} 的资料`}
            className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => entry.pm && onOpenProfile(entry.pm.id)}
          >
            <Avatar colorKey={entry.avatarKey} size={34} />
          </button>
        ) : (
          <Avatar colorKey={entry.avatarKey} size={34} />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] leading-snug font-semibold">{entry.name}</h1>
          {entry.folders.length > 0 && (
            <ul aria-label="文件夹" className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 text-[13.5px] leading-snug text-muted-foreground">
              {entry.folders.map((f) => (
                <li key={f.id} className="flex min-w-0 items-center gap-1.5" title={f.path}>
                  <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{shortPath(f.path)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {toolbar}
      </header>
      {top}
      {notices}
      <div className="relative min-h-0 flex-1">
        <MessageList
          messages={view.messages}
          pending={pending}
          agentOf={() => agent}
          hasMore={view.hasMore}
          older={older}
          onLoadOlder={() => onLoadOlder(id)}
          onRetry={onRetry}
          actions={actions}
          focus={focus}
          status={hasAgentStatus(session) ? <AgentStatus session={session} /> : null}
          statusAgent={agent}
        />
      </div>
      <div className="chat-column w-full shrink-0 pb-5">
        <Composer
          autoFocus
          value={draft}
          placeholder={`给 ${entry.name} 发消息`}
          staging={staging}
          stop={stop}
          source={source}
          onChange={(v) => onDraftChange(id, v)}
          onSend={(text, files) => onSend(id, text, files)}
        />
      </div>
    </FileDropZone>
  );
}
