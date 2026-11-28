import { memo, useCallback, useMemo } from "react";
import {
  isAgentVendor,
  REPORT_START,
  WORKER_RETENTION_DAYS,
  WORKER_RETENTION_MAX_ENDED,
  type AgentVendor,
  type ConversationId,
  type Message,
  type SessionState,
  type WorkerPick,
} from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import type { WorkerOutcome, WorkerPhase } from "../selectors.ts";
import type { ConversationView, OlderState, PendingMessage } from "../state.ts";
import type { DraftSlot, StagedFiles } from "../upload.ts";
import { formatTime } from "../format.ts";
import { workerStatusOf } from "../worker-status.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import { conversationSource } from "../composer-suggest.ts";
import { useClient } from "../device-scope.tsx";
import { CircleX, Info } from "../ui/icons.ts";
import { DraftComposer, type ComposerLink } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageList } from "./MessageList.tsx";
import { AgentHead, CopyButton, displayText, type AgentIdentity, type MessageActions } from "./Messages.tsx";
import { useStop, type StopRequestResult } from "../useStop.ts";
import { actionStartedAt, useAgentStatusNode } from "./AgentStatus.tsx";

const NO_OUTCOMES: readonly WorkerOutcome[] = [];
const CLEARED_NOTICE = `Conversation cleared. Finished Workers keep their conversations for up to ${WORKER_RETENTION_DAYS} days, and only the latest ${WORKER_RETENTION_MAX_ENDED}.`;

function WorkerFailureStrip({ outcome, vendor }: { outcome: WorkerOutcome; vendor?: AgentVendor }) {
  const tag = outcome.line.event === "worktree_failed" ? "Couldn't create worktree" : "Turn failed";
  const rawSummary = outcome.line.summary?.trim() ?? "";
  const failure = rawSummary !== "" ? describeFailure(rawSummary, { unknown: "raw", vendor }) : null;
  const detail = failure?.text ?? "";
  const rawTitle = failure && failure.raw !== failure.text ? failure.raw : undefined;
  return (
    <div role="alert" data-worker-failure={outcome.line.event} className="mt-4 w-full min-w-0 overflow-hidden rounded-sm bg-danger-soft">
      <div className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left text-minor leading-5" title={rawTitle}>
        <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">
          <span className="mr-1 font-medium">{tag}</span>
          {detail !== "" && ` ${detail}`}
        </p>
      </div>
    </div>
  );
}

function RetainedReport({ outcome, identity }: { outcome: WorkerOutcome; identity: AgentIdentity }) {
  const body = outcome.reportBody;
  const fallback = outcome.line.summary?.trim() || workerStatusOf(outcome.line).label || "";
  const formatted = body !== null ? displayText(body) : null;
  const markdown = formatted !== null && body!.trimStart().startsWith(REPORT_START) ? formatted.replace(/^---\n\n/, "") : formatted;
  const copyText = body ?? fallback;
  return (
    <div className="mt-6 flex flex-col" data-retained-outcome="report">
      <AgentHead identity={identity} />
      <div className="flex flex-col gap-2.5">
        {markdown !== null ? (
          <div className="w-full min-w-0 text-body leading-relaxed">
            <Markdown text={markdown} />
          </div>
        ) : (
          fallback !== "" && <p className="w-full min-w-0 text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{fallback}</p>
        )}
        <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          {copyText !== "" && <CopyButton text={copyText} />}
          <span>{formatTime(outcome.at)}</span>
        </div>
      </div>
    </div>
  );
}

function PurgedWorkerHistory({
  outcomes,
  identity,
  vendor,
}: {
  outcomes: readonly WorkerOutcome[];
  identity: AgentIdentity;
  vendor?: AgentVendor;
}) {
  return (
    <div className="messages messages-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain" data-purged-history>
      <div className="flex min-h-full flex-col pt-8 pb-12">
        <div role="status" className="w-full min-w-0 overflow-hidden rounded-sm bg-panel">
          <div className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left text-minor leading-5">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-muted-foreground">{CLEARED_NOTICE}</p>
          </div>
        </div>
        {outcomes.map((outcome) =>
          outcome.line.event === "report" ? (
            <RetainedReport key={outcome.id} outcome={outcome} identity={identity} />
          ) : (
            <WorkerFailureStrip key={outcome.id} outcome={outcome} vendor={vendor} />
          ),
        )}
      </div>
    </div>
  );
}

export const WorkerConversation = memo(function WorkerConversation({
  title,
  phase,
  pm,
  outcomes = NO_OUTCOMES,
  view,
  loading = false,
  pending,
  session,
  older,
  draft,
  staging,
  mobile = false,
  top,
  notices,
  onSend,
  onRetry,
  onStop,
  onRewind,
  onLoadOlder,
  actions,
  link = null,
}: {
  title: string;
  phase: WorkerPhase;
  pm: { name: string; look: SlimeLook };
  outcomes?: readonly WorkerOutcome[];
  view: ConversationView | undefined;
  loading?: boolean;
  pending: PendingMessage[];
  session: SessionState | null;
  older: OlderState | undefined;
  draft: DraftSlot;
  staging: StagedFiles;
  mobile?: boolean;
  top?: React.ReactNode;
  notices: React.ReactNode;
  onSend: (conversationId: ConversationId, text: string, files: File[]) => void | Promise<void>;
  onRetry: (clientId: string) => void;
  onStop: (conversationId: ConversationId) => Promise<StopRequestResult>;
  onRewind?: (conversationId: ConversationId, stopping: boolean, draftText: string) => { text: string; workerPick: WorkerPick | null } | null;
  onLoadOlder: (conversationId: ConversationId) => void;
  actions: MessageActions;
  link?: ComposerLink | null;
}) {
  const id = view?.conversation.id;
  const vendor = isAgentVendor(session?.vendor) ? session.vendor : undefined;
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
  const trailingFailure = useMemo(() => {
    if (view === undefined || view.conversation.purgedAt !== undefined) return null;
    const last = outcomes.at(-1);
    if (last === undefined || last.line.event === "report") return null;
    if (last.line.event === "worktree_failed") return last;
    if (session?.activity === "working" || session?.activity === "preparing") return null;
    if (view.messages.some((m) => m.sender === "agent" && m.createdAt > last.at)) return null;
    return last;
  }, [view, outcomes, session?.activity]);
  const failureFooter = useMemo(
    () => (trailingFailure === null ? null : <WorkerFailureStrip outcome={trailingFailure} vendor={vendor} />),
    [trailingFailure, vendor],
  );
  return (
    <FileDropZone
      data-worker-detail=""
      className="chat-text flex min-h-0 flex-1 flex-col"
      aria-label={`Worker ${title}`}
      onFiles={(files, skipped) => phase === "open" && staging.add(files, skipped)}
    >
      {top}
      {notices}
      {view === undefined ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">{loading ? "Loading…" : "Worker not found"}</div>
      ) : (
        <>
          {view.conversation.purgedAt !== undefined ? (
            outcomes.length > 0 ? (
              <PurgedWorkerHistory outcomes={outcomes} identity={identity} vendor={vendor} />
            ) : (
              <div role="status" className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground">
                {CLEARED_NOTICE}
              </div>
            )
          ) : (
            <div className="relative min-h-0 flex-1">
              <MessageList
                messages={view.messages}
                turns={view.turns}
                activeTurnId={session?.activeTurnId}
                pending={pending}
                agentOf={agentOf}
                hasMore={view.hasMore}
                older={older}
                onLoadOlder={handleLoadOlder}
                onRetry={onRetry}
                actions={actions}
                status={statusNode}
                stepStartedAt={actionStartedAt(session)}
                statusAgent={identity}
                streamingText={session?.streamingText ?? null}
                footer={failureFooter}
                leanReports
              />
            </div>
          )}
          <div className="chat-column pointer-events-none relative z-10 -mt-6.5 w-full shrink-0 composer-dock *:pointer-events-auto empty:hidden">
            {phase === "ended" && view.conversation.purgedAt === undefined && trailingFailure?.line.event !== "worktree_failed" && (
              <div role="status" className="rounded-sm border border-border bg-panel px-4 py-3 text-body">
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
});
