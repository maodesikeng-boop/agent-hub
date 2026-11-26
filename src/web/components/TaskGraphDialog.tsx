import { useMutation } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  isTaskNodeUserBlocked,
  isTaskNodeAwaitingUserAction,
  isTaskNodeWaitingPm,
  userBlockerCardText,
  type ConversationId,
  type TaskGraph,
  type TaskNode,
  type TaskNodeKey,
} from "../../shared/index.ts";
import type { JellyColorId } from "../../shared/slimes.ts";
import { clearDecisionDraft, gateDecisionDraftKey, useDecisionDraft } from "../decision-drafts.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { graphFlowOf } from "../graph-flow.ts";
import { useHubQueryClient } from "../query-client.ts";
import { workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, ZOOM_DIALOG } from "../ui/dialog.tsx";
import { Loader2 } from "../ui/icons.ts";
import { graphDeliveryOf, nodeWorkStatusOf, slotQueueTextOf } from "../work-status.ts";
import { UnsentDraftBanner } from "./Deliverables.tsx";
import { GateDecisionCard, resolveBoundWorker } from "./GateDecisionCard.tsx";
import { GraphDeliveryRow } from "./GraphDeliveryRow.tsx";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { SandboxApprovalCard } from "./SandboxApprovalCard.tsx";
import { UserBlockerCard } from "./UserBlockerCard.tsx";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

function showUserCard(node: TaskNode, status: TaskGraph["status"]): boolean {
  return status !== "cancelled" && (node.gateAskPending === true ||
    (status === "active" && isTaskNodeAwaitingUserAction(node)));
}

function statusLabelOf(node: TaskNode, graphStatus: TaskGraph["status"]): string {
  if (node.status === "cancelled" || (graphStatus === "cancelled" && node.status !== "done")) return "Cancelled";
  switch (node.status) {
    case "done":
      return node.skipped ? "Skipped" : "Done";
    case "running":
      return "Working…";
    case "waiting":
      return node.waitingFor === "user" ? "Waiting on you" : "Waiting on PM";
    case "pending":
      return slotQueueTextOf(node) === null ? "Pending" : "Queued";
  }
}

function SettledGateDraft({ draftKey, settledNote }: { draftKey: string; settledNote: string | null }) {
  const draft = useDecisionDraft(draftKey);
  if (draft.trim() === "" || (settledNote !== null && settledNote.trim() === draft.trim())) return null;
  return <UnsentDraftBanner draft={draft} compact onDismiss={() => clearDecisionDraft(draftKey)} />;
}

export const TaskGraphDialog = memo(function TaskGraphDialog({
  graph,
  open,
  onOpenChange,
  workers,
  onOpenWorker,
  decisionKey,
  terminal,
}: {
  graph: TaskGraph | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: readonly WorkerEntry[];
  color?: JellyColorId;
  onOpenWorker: (id: ConversationId) => void;
  decisionKey?: TaskNodeKey | undefined;
  terminal?: { title: string; outcome: "done" | "cancelled" | undefined } | undefined;
}) {
  const client = useClient();
  const qc = useHubQueryClient();
  const [actionError, setActionError] = useState<ErrorLike | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const seenGateDraftKeyRef = useRef(new Map<string, string>());
  const inFlightRef = useRef(false);
  const releaseLock = () => {
    inFlightRef.current = false;
  };

  const contentRef = useRef<HTMLDivElement>(null);
  const focusDecision = useCallback((key: TaskNodeKey) => {
    const card = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-decision-key]") ?? [])
      .find((element) => element.dataset.decisionKey === key);
    if (card === undefined) return false;
    card.focus();
    return true;
  }, []);

  const workerByKey = useMemo(() => workersByWorkerId(workers), [workers]);
  const flow = useMemo(() => (graph === null ? null : graphFlowOf(graph)), [graph]);
  const orderedNodes = useMemo(
    () => (graph === null ? [] : graph.nodes.toSorted((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))),
    [graph],
  );
  const nodeByKey = useMemo(() => new Map(orderedNodes.map((n) => [n.key, n])), [orderedNodes]);

  const skipMutation = useMutation(
    {
      mutationFn: async (nodeKey: string) => {
        if (graph === null) return;
        await client.postTaskGraphSkip(graph.id, nodeKey);
      },
      onMutate: () => setActionError(null),
      onError: (err) => setActionError(errorText(err)),
      onSettled: releaseLock,
    },
    qc,
  );

  const cancelMutation = useMutation(
    {
      mutationFn: async () => {
        if (graph === null) return;
        await client.postTaskGraphCancel(graph.id);
      },
      onMutate: () => setActionError(null),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["completed-work"] });
        setConfirmingCancel(false);
        onOpenChange(false);
      },
      onError: (err) => {
        setConfirmingCancel(false);
        setActionError(errorText(err));
      },
      onSettled: releaseLock,
    },
    qc,
  );

  const runExclusive = (run: () => void) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    run();
  };

  const stepInteractive = useCallback(
    (key: TaskNodeKey): boolean => {
      const node = nodeByKey.get(key);
      if (node === undefined) return false;
      return (graph !== null && showUserCard(node, graph.status)) || resolveBoundWorker(node, workerByKey).worker !== null;
    },
    [graph, nodeByKey, workerByKey],
  );

  const handleOpenStep = useCallback(
    (key: TaskNodeKey) => {
      const node = nodeByKey.get(key);
      if (node === undefined || focusDecision(key)) return;
      const { worker } = resolveBoundWorker(node, workerByKey);
      if (worker === null) return;
      onOpenChange(false);
      onOpenWorker(worker.conversationId);
    },
    [nodeByKey, workerByKey, focusDecision, onOpenChange, onOpenWorker],
  );

  if (graph === null || flow === null) {
    if (terminal === undefined) return null;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={terminal.title} className="max-w-110">
          <p role="status" className="text-minor text-muted-foreground">
            {terminal.outcome === "cancelled" ? "Cancelled" : terminal.outcome === "done" ? "Completed" : "This task graph is no longer active."}
          </p>
        </DialogContent>
      </Dialog>
    );
  }

  const delivery = graphDeliveryOf(graph);
  const graphStateLabel = graph.status === "completed" ? "Completed" : graph.status === "cancelled" ? "Cancelled" : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        title={graph.title}
        className={ZOOM_DIALOG}
        onOpenAutoFocus={(event) => {
          if (decisionKey !== undefined && focusDecision(decisionKey)) event.preventDefault();
        }}
      >
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-minor text-muted-foreground">
            <span className="tabular-nums">{delivery.header}</span>
            {graphStateLabel !== null && <span>{graphStateLabel}</span>}
          </div>
          {graph.status === "active" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cancelMutation.isPending || skipMutation.isPending}
              onClick={() => setConfirmingCancel(true)}
              className="text-muted-foreground hover:text-danger"
            >
              Cancel graph
            </Button>
          )}
          <Dialog
            open={graph.status === "active" && confirmingCancel}
            onOpenChange={(next) => {
              if (!cancelMutation.isPending) setConfirmingCancel(next);
            }}
          >
            <DialogContent title="Cancel this task graph?" className="max-w-110">
              <p className="text-minor">Unfinished steps in “{graph.title}” won't run. The project manager is told to wrap up any Workers still working. This can't be undone.</p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm" disabled={cancelMutation.isPending}>
                    Keep going
                  </Button>
                </DialogClose>
                <Button variant="destructive" size="sm" disabled={cancelMutation.isPending} onClick={() => runExclusive(() => cancelMutation.mutate())}>
                  {cancelMutation.isPending && <Loader2 aria-hidden="true" />}
                  Cancel graph
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        {actionError !== null && (
          <p role="alert" title={errorTitle(actionError)} className="shrink-0 text-minor text-danger">
            {errorLine(actionError)}
          </p>
        )}
        <DialogBody className="mx-0 flex flex-col gap-4 overflow-auto px-0">
          <div className="shrink-0 overflow-x-auto rounded-sm">
            <GraphCanvas
              flow={flow}
              orientation="horizontal"
              paper
              onOpenStep={handleOpenStep}
              stepInteractive={stepInteractive}
            />
          </div>
          <div className="grid grid-cols-1 gap-2.5">
            {orderedNodes.map((node) => {
              const { workerId, worker } = resolveBoundWorker(node, workerByKey);
              const isWaitingGate = showUserCard(node, graph.status);
              const isPending = node.status === "pending";
              const isWaitingPm = isTaskNodeWaitingPm(node);
              const canSkip = graph.status === "active" && (isPending || (isWaitingPm && node.activeWorkerId === null));
              const nodeRefKey = `${graph.id}:${node.key}`;
              const activeDraftKey = gateDecisionDraftKey(client.device, graph.id, node.key, node.gateAskMessageId);
              if (isWaitingGate && node.sandboxApproval == null && !isTaskNodeUserBlocked(node)) {
                seenGateDraftKeyRef.current.set(nodeRefKey, activeDraftKey);
              }
              if (isWaitingGate) {
                return (
                  <div
                    key={node.key}
                    data-step="waiting"
                    data-decision-key={node.key}
                    tabIndex={-1}
                    className="grid scroll-mt-2 grid-cols-1 gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-border-focus"
                  >
                    <div className="flex items-center justify-between gap-2 px-1">
                      <span className="flex min-w-0 items-center gap-2 text-minor font-semibold text-foreground">
                        <WorkStatusIcon status="waiting" />
                        <span className="truncate" title={node.title}>
                          {node.title}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-brand-ink">Waiting on you</span>
                    </div>
                    {node.sandboxApproval != null ? (
                      <SandboxApprovalCard key={node.sandboxApproval.id} approvalId={node.sandboxApproval.id} text={node.sandboxApproval.text} />
                    ) : node.userBlocker != null && isTaskNodeUserBlocked(node) ? (
                      <UserBlockerCard blockerId={node.userBlocker.id} text={userBlockerCardText(node.userBlocker)} showStatus={false} />
                    ) : (
                      <GateDecisionCard key={node.gateAskMessageId ?? node.key} graphId={graph.id} node={node} client={client} />
                    )}
                  </div>
                );
              }
              const stepStatus = nodeWorkStatusOf(node, graph.status);
              const decisionLabel = node.decision?.choice ?? node.decision?.note ?? null;
              const summaryText = node.artifact?.summary ?? null;
              const queueText = graph.status === "active" && node.status === "pending" ? slotQueueTextOf(node) : null;
              const settledDraftKey =
                node.gateAskMessageId !== null ? activeDraftKey : (seenGateDraftKeyRef.current.get(nodeRefKey) ?? activeDraftKey);
              return (
                <div
                  key={node.key}
                  data-step={node.status === "done" && node.skipped ? "pending" : node.status}
                  className="flex flex-col gap-1.5 rounded-sm border border-border bg-background px-3.5 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <WorkStatusIcon status={stepStatus} />
                      <span title={node.title} className="min-w-0 truncate text-minor font-medium text-foreground">
                        {node.title}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {workerId !== null ? (
                        worker !== null ? (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenChange(false);
                              onOpenWorker(worker.conversationId);
                            }}
                            className="touch-target cursor-pointer rounded-xs px-1.5 py-0.5 text-xs font-medium text-brand-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus tabular-nums"
                          >
                            #{workerId}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground tabular-nums">#{workerId}</span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">{statusLabelOf(node, graph.status)}</span>
                      )}
                      {canSkip && (
                        <button
                          type="button"
                          disabled={skipMutation.isPending || cancelMutation.isPending}
                          onClick={() => runExclusive(() => skipMutation.mutate(node.key))}
                          className="touch-target cursor-pointer rounded-xs px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus"
                        >
                          Skip step
                        </button>
                      )}
                    </div>
                  </div>
                  {decisionLabel !== null && (
                    <p title={decisionLabel} className="truncate text-xs font-medium text-foreground">
                      {decisionLabel}
                    </p>
                  )}
                  {queueText !== null && <p className="truncate text-xs text-muted-foreground" title={queueText}>{queueText}</p>}
                  {summaryText !== null && <p className="line-clamp-2 text-xs text-muted-foreground">{summaryText}</p>}
                  <SettledGateDraft draftKey={settledDraftKey} settledNote={node.decision?.note ?? null} />
                </div>
              );
            })}
            {delivery.row !== null && <GraphDeliveryRow row={delivery.row} detail />}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
});
