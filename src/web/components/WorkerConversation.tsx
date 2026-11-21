import { ArrowLeft } from "../ui/icons.ts";
import { useCallback, useMemo } from "react";
import { WORKER_RETENTION_DAYS, WORKER_RETENTION_MAX_ENDED, type ConversationId, type Message, type SessionState, type WorkerPick } from "../../shared/index.ts";
import type { WorkerEntry, WorkerPhase } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { DraftSlot, StagedFiles } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import type { SlimeLook } from "../../shared/slimes.ts";
import { conversationSource } from "../composer-suggest.ts";
import { useClient } from "../device-scope.tsx";
import { DraftComposer, type ComposerLink } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { MessageList } from "./MessageList.tsx";
import type { MessageActions } from "./Messages.tsx";
import { useStop } from "../useStop.ts";
import { hasAgentStatus, useAgentStatusNode } from "./AgentStatus.tsx";
import { PieceMeta } from "./RightRail.tsx";

export function WorkerConversation({
  title,
  readonly,
  phase,
  pm,
  meta,
  view,
  loading = false,
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
  onBack,
  onSend,
  onRetry,
  onStop,
  onRewind,
  onLoadOlder,
  actions,
  link = null,
}: {
  title: string;
  readonly: boolean;
  phase: WorkerPhase;
  pm: { name: string; look: SlimeLook };
  meta?: WorkerEntry;
  view: ConversationView | undefined;
  loading?: boolean;
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
  onBack: () => void;
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<void>;
  onRewind?: (conversationId: ConversationId, stopping: boolean, draftText: string) => { text: string; workerPick: WorkerPick | null } | null;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  link?: ComposerLink | null;
}) {
  const id = view?.conversation.id;
  const hasQueuedUser = useMemo(
    () => pending.some((p) => p.phase === "sending") || (view?.messages.some((m) => m.sender === "user" && m.status === "queued") ?? false),
    [pending, view?.messages],
  );
  const stop = useStop(session, id === undefined ? null : () => onStop(id), hasQueuedUser);
  const handleRewind = useCallback(
    (stopping: boolean): boolean => {
      if (id === undefined) return false;
      const res = onRewind?.(id, stopping, draft.store.getState()) ?? null;
      if (res === null) return false;
      draft.restore(res.text, res.workerPick);
      return true;
    },
    [onRewind, id, draft],
  );
  const client = useClient();
  const source = useMemo(() => (id === undefined ? undefined : conversationSource(id, client.url)), [id, client]);

  const identity = useMemo(() => ({ name: title, look: pm.look, neutral: true }), [title, pm.look]);
  const pmIdentity = useMemo(() => ({ name: pm.name, look: pm.look }), [pm.name, pm.look]);
  const agentOf = useCallback((message: Message) => (message.sender === "pm" ? pmIdentity : identity), [pmIdentity, identity]);
  const handleLoadOlder = useCallback(() => {
    if (id !== undefined) onLoadOlder(id);
  }, [onLoadOlder, id]);
  const handleSend = useCallback((text: string, files: File[]) => (id === undefined ? undefined : onSend(id, text, files)), [onSend, id]);
  const statusNode = useAgentStatusNode(session);
  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label={`Piece ${title}`} onFiles={(files, skipped) => phase === "open" && staging.add(files, skipped)}>
      <header data-window-drag className="flex min-h-16 min-w-0 shrink-0 items-center gap-3 overflow-hidden py-3 pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]">
        {leading}
        {!mobile && (
          <Button variant="slot" size="icon" className="shrink-0" aria-label={`Back to ${pm.name}`} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <Avatar look={identity.look} size={34} neutral working={hasAgentStatus(session)} />
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 overflow-hidden">
          <div className="flex min-w-[40%] shrink-[9999] items-center gap-3 overflow-hidden">
            <h1 title={title} className="min-w-0 truncate text-title leading-snug font-semibold">
              {title}
            </h1>
            {!mobile && readonly && <span className="tool-badge shrink-0 px-2 py-0.5 text-xs font-medium">Read-only</span>}
          </div>
          {!mobile && meta && <PieceMeta worker={meta} />}
        </div>
        {toolbar}
      </header>
      {top}
      {notices}
      {view === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">{loading ? "Loading…" : "Piece not found"}</div>
      ) : (
        <>
          {view.conversation.purgedAt !== undefined ? (
            <div role="status" className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground">
              Conversation cleared. Finished Pieces keep their conversations for up to {WORKER_RETENTION_DAYS} days, and only the latest {WORKER_RETENTION_MAX_ENDED}.
            </div>
          ) : (
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
                streamingText={session?.streamingText ?? null}
              />
            </div>
          )}
          <div className="chat-column pointer-events-none relative z-10 -mt-6.5 w-full shrink-0 composer-dock *:pointer-events-auto empty:hidden">
            {phase === "ended" && view.conversation.purgedAt === undefined && (
              <div role="status" className="rounded-2xl bg-sidebar px-4 py-3 text-body">
                Completed
              </div>
            )}
            {phase !== "ended" && (
              <DraftComposer
                autoFocus={!mobile}
                draft={draft}
                placeholder={mobile ? "Message…" : phase === "preparing" ? `${title} is setting up…` : `Message ${title}…`}
                disabled={phase === "preparing"}
                stop={stop}
                onRewind={onRewind ? handleRewind : undefined}
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
