import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationId, PmId } from "../../shared/index.ts";
import type { ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Avatar } from "./Avatar.tsx";
import type { StagedFiles } from "../upload.ts";
import { Composer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
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
  staging,
  stats,
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
  /** 还没发的文件、提示、发送中（和 draft 一样由 App 按对话存，见 upload.ts 的 useStagingStore）。 */
  staging: StagedFiles;
  /** 标题栏右边的额度和在跑的 Worker 数。 */
  stats: React.ReactNode;
  /** 顶部提醒，放在标题栏下面。 */
  notices: React.ReactNode;
  onDraftChange: (conversationId: ConversationId, value: string) => void;
  /** 只有文字：同步发出（返回 undefined）；带文件：返回 Promise，传完、发出才 resolve，失败 reject（Error.message 给用户看）。 */
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
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
  // agent 的消息都是这个项目经理说的（Worker 的汇报是单独的一行，点开才是 Worker 自己的对话）
  const agent = { name: entry.name, avatarKey: entry.avatarKey };
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={entry.name} onFiles={staging.add}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 px-6 py-3">
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
        <div className="min-w-0">
          <h1 className="truncate text-[17px] leading-snug font-semibold">{entry.name}</h1>
          {entry.folders.length > 0 && (
            <ul aria-label="文件夹" className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-muted-foreground">
              {entry.folders.map((f) => (
                <li key={f.id} className="flex min-w-0 items-center gap-1.5" title={f.path}>
                  <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{f.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {stats}
      </header>
      {notices}
      <div className="relative min-h-0 flex-1">
        {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">还没有消息</div>}
        <MessageList
          messages={view.messages}
          pending={pending}
          agentOf={() => agent}
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
          staging={staging}
          onChange={(v) => onDraftChange(id, v)}
          onSend={(text, files) => onSend(id, text, files)}
        />
      </div>
    </FileDropZone>
  );
}
