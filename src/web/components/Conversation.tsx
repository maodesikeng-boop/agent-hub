import { memo, useCallback, useMemo, useState } from "react";
import { HUB_COMPOSER_COMMANDS, type ConversationId, type MessageId, type PmId, type WorkerPick } from "../../shared/index.ts";
import { errorText, formatArchiveRemaining, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { visibleMessages, type ConversationEntry } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { SessionState } from "../../shared/index.ts";
import { Button } from "../ui/button.tsx";
import { ChevronDown } from "../ui/icons.ts";
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
import { actionStartedAt, hasAgentStatus, useAgentStatusNode } from "./AgentStatus.tsx";

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
    <div className="rounded-sm border border-border bg-panel px-4 py-3">
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

export const Conversation = memo(function Conversation({
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
  onRewind,
  onLoadOlder,
  actions,
  link = null,
  focus,
  onFocusDone,
  onOpenProfile,
  onManageProviders,
}: {
  entry: ConversationEntry;
  view: ConversationView;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: DraftSlot;
  staging: StagedFiles;
  leading?: React.ReactNode;
  mobile?: boolean;
  toolbar: React.ReactNode;
  top: React.ReactNode;
  notices: React.ReactNode;
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onRewind?: (conversationId: ConversationId, stopping: boolean, draftText: string) => { text: string; workerPick: WorkerPick | null } | null;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  link?: ComposerLink | null;
  focus: { id: MessageId; n: number } | null;
  onFocusDone: () => void;
  onOpenProfile: (pmId: PmId) => void;
  onManageProviders?: () => void;
}) {
  const id = view.conversation.id;
  const hasQueuedUser = useMemo(
    () => pending.some((p) => p.phase === "sending") || view.messages.some((m) => m.sender === "user" && m.status === "queued"),
    [pending, view.messages],
  );
  const stop = useStop(session, () => onStop(id), hasQueuedUser);
  const handleRewind = useCallback(
    (stopping: boolean): boolean => {
      const res = onRewind?.(id, stopping, draft.store.getState()) ?? null;
      if (res === null) return false;
      draft.restore(res.text, res.workerPick);
      return true;
    },
    [onRewind, id, draft],
  );
  const client = useClient();
  const isPm = view.conversation.kind === "pm";
  const source = useMemo(() => conversationSource(id, client.url, isPm ? HUB_COMPOSER_COMMANDS : undefined), [id, client, isPm]);
  const messages = useMemo(() => visibleMessages(view.messages), [view.messages]);
  const archived = entry.pm?.archivedAt != null;
  const messageActions = useMemo<MessageActions>(
    () => (archived ? actions : { ...actions, onAnswerAsk: async (messageId, body) => void (await client.postAnswerAsk(messageId, body)) }),
    [actions, archived, client],
  );

  const agent = useMemo(() => ({ name: entry.name, look: entry.look }), [entry.name, entry.look]);
  const agentOf = useCallback(() => agent, [agent]);
  const handleLoadOlder = useCallback(() => onLoadOlder(id), [onLoadOlder, id]);
  const handleSend = useCallback((text: string, files: File[]) => onSend(id, text, files), [onSend, id]);
  const statusNode = useAgentStatusNode(session);
  const avatarSize = mobile ? 34 : 24;
  return (
    <FileDropZone className="chat-text flex min-h-0 flex-1 flex-col" aria-label={entry.name} onFiles={staging.add}>
      <header
        data-window-drag
        className={
          mobile
            ? "flex min-h-14 min-w-0 shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-border pt-[var(--safe-top)] pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]"
            : "flex h-11 min-w-0 shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-border pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]"
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {leading}
          {entry.pm ? (
            <button
              type="button"
              aria-label={`View ${entry.pm.name}'s profile`}
              className={cn(
                "-ml-1.5 flex min-w-0 max-w-full cursor-pointer items-center pr-2 pl-1.5 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus",
                mobile ? "h-11 gap-2.5" : "h-8 gap-2",
              )}
              onClick={() => entry.pm && onOpenProfile(entry.pm.id)}
            >
              <Avatar look={entry.look} size={avatarSize} working={hasAgentStatus(session)} className="shrink-0" />
              <h1 title={entry.name} className="min-w-0 truncate text-title leading-snug font-semibold text-foreground">
                {entry.name}
              </h1>
              <ChevronDown className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : (
            <div className={cn("flex min-w-0 items-center", mobile ? "gap-2.5" : "gap-2")}>
              <Avatar look={entry.look} size={avatarSize} working={hasAgentStatus(session)} className="shrink-0" />
              <h1 title={entry.name} className="min-w-0 truncate text-title leading-snug font-semibold text-foreground">
                {entry.name}
              </h1>
            </div>
          )}
        </div>
        {toolbar}
      </header>
      {top}
      {notices}
      <div className="relative min-h-0 flex-1">
        <MessageList
          messages={messages}
          turns={view.turns}
          activeTurnId={session?.activeTurnId}
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
          stepStartedAt={actionStartedAt(session)}
          statusAgent={agent}
          streamingText={session?.streamingText ?? null}
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
            onRewind={onRewind ? handleRewind : undefined}
            link={link}
            source={source}
            onManageProviders={onManageProviders}
            onSend={handleSend}
          />
        )}
      </div>
    </FileDropZone>
  );
});
