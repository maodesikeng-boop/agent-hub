import { useMutation } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import type { ConversationId, TaskGraph, TaskNode } from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { computeTaskGraphLayout, DEFAULT_ROOT_FONT_SIZE_PX } from "../task-graph-layout.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { KnifeAvatar } from "./KnifeAvatar.tsx";
import { GateDecisionCard, resolveBoundWorker } from "./PeelTrack.tsx";
import { SliceWheelIcon } from "./SliceWheelIcon.tsx";

function readRootFontSizePx(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return DEFAULT_ROOT_FONT_SIZE_PX;
  }
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROOT_FONT_SIZE_PX;
}

function statusLabelOf(node: TaskNode): string {
  switch (node.status) {
    case "done":
      return "Done";
    case "running":
      return "Working…";
    case "ready":
      return "Ready";
    case "waiting_user":
      return "Waiting on you";
    case "attention":
      return "Needs attention";
    case "skipped":
      return "Skipped";
    case "pending":
      return "Blocked";
  }
}

/**
 * 任务流图放大全览弹窗（TaskGraphDialog，docs/ui-standard.md 第 12.1 条）：
 * 复用 computeTaskGraphLayout(..., viewportMode: "dialog") 横向 LR 自动分层，完整展示并行分支、Piece 跳转与拍板记录。
 */
export const TaskGraphDialog = memo(function TaskGraphDialog({
  graph,
  open,
  onOpenChange,
  workers,
  colorKey = 0,
  onOpenWorker,
}: {
  graph: TaskGraph | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: readonly WorkerEntry[];
  colorKey?: number;
  onOpenWorker: (id: ConversationId) => void;
}) {
  // 当前区域那台设备的接口（device-scope.tsx）：跨设备看远端项目经理时，跳过、取消、拍板都发给那台
  const client = useClient();
  const qc = useHubQueryClient();
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<ErrorLike | null>(null);
  /** Cancel graph 的二次确认弹窗（docs/ui-standard.md 第 12.1 条）：点了先确认，确认了才发请求。 */
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const workerByKey = useMemo(() => workersByWorkerId(workers), [workers]);
  // 同步防重入（Skip step / Cancel graph）：isPending 要等下一次渲染才变，连点会各发一次请求
  const inFlightRef = useRef(false);
  const releaseLock = () => {
    inFlightRef.current = false;
  };

  const nodeByKey = useMemo(() => {
    const map = new Map<string, TaskNode>();
    for (const n of graph?.nodes ?? []) map.set(n.key, n);
    return map;
  }, [graph]);

  const rootFontSizePx = open ? readRootFontSizePx() : DEFAULT_ROOT_FONT_SIZE_PX;

  const layout = useMemo(() => {
    if (graph === null) return null;
    return computeTaskGraphLayout({
      graphId: graph.id,
      nodes: graph.nodes.map((n) => ({
        key: n.key,
        kind: n.kind,
        status: n.status,
        position: n.sortOrder,
        optionCount: n.gateOptions.length,
        hasSummary: Boolean(n.gateSummaryMd || n.artifact?.summary || n.decision),
        noteExpanded: Boolean(expandedNotes[n.key]),
      })),
      edges: graph.edges.map((e) => ({ from: e.fromKey, to: e.toKey })),
      viewportMode: "dialog",
      rootFontSizePx,
    });
  }, [graph, expandedNotes, rootFontSizePx]);

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
        void qc.invalidateQueries({ queryKey: ["project-task-graphs"] });
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

  if (graph === null || layout === null) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={graph.title} className="h-[90dvh] w-[min(96vw,1400px)] max-w-none">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-minor text-muted-foreground">
            <SliceWheelIcon graph={graph} colorKey={colorKey} size={20} />
            <span>
              {graph.status === "completed"
                ? "Completed"
                : graph.status === "cancelled"
                  ? "Cancelled"
                  : "Task Graph"}
            </span>
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
            open={confirmingCancel}
            onOpenChange={(next) => {
              // 请求中不让 Esc、点遮罩把确认弹窗关掉（结果回来再关）
              if (!cancelMutation.isPending) setConfirmingCancel(next);
            }}
          >
            <DialogContent title="Cancel this task graph?" className="max-w-110">
              <p>Unfinished steps in “{graph.title}” won't run. The project manager is told to wrap up any Pieces still working. This can't be undone.</p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={cancelMutation.isPending}>
                    Keep going
                  </Button>
                </DialogClose>
                <Button disabled={cancelMutation.isPending} onClick={() => runExclusive(() => cancelMutation.mutate())}>
                  {cancelMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
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
        <DialogBody className="overflow-auto">
          <div
            data-rankdir={layout.rankdir}
            style={{ width: `${layout.width}px`, minHeight: `${layout.height}px` }}
            className="relative"
          >
            <svg
              aria-hidden="true"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="pointer-events-none absolute inset-0"
            >
              {layout.edges.map((edge) => (
                <g key={edge.id}>
                  <path
                    d={edge.d}
                    fill="none"
                    stroke={edge.solid ? "var(--color-muted-foreground)" : "var(--color-line)"}
                    strokeWidth="1.5"
                    strokeDasharray={edge.solid ? undefined : "4 3"}
                  />
                  {edge.arrowD !== "" && (
                    <path
                      d={edge.arrowD}
                      fill="none"
                      stroke={edge.solid ? "var(--color-muted-foreground)" : "var(--color-line)"}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </g>
              ))}
            </svg>
            {layout.nodes.map((box) => {
              if (box.boxKind !== "node") return null;
              const node = nodeByKey.get(box.nodeKey);
              if (!node) return null;
              const { workerId, worker } = resolveBoundWorker(node, workerByKey);
              const isWaitingGate = node.kind === "gate" && node.status === "waiting_user";
              const isPending = node.status === "pending";
              const isDone = node.status === "done";
              const canSkip =
                graph.status === "active" &&
                (node.status === "ready" || node.status === "pending" || node.status === "attention");

              if (isWaitingGate) {
                return (
                  <div
                    key={box.id}
                    style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` }}
                    className="absolute"
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                      <span className="flex min-w-0 items-center gap-2 text-minor font-semibold text-primary">
                        <KnifeAvatar size={20} />
                        <span className="truncate">{node.title}</span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-primary">Waiting on you</span>
                    </div>
                    <GateDecisionCard
                      graphId={graph.id}
                      node={node}
                      client={client}
                      onNoteToggle={(noteOpen) =>
                        setExpandedNotes((prev) => ({ ...prev, [node.key]: noteOpen }))
                      }
                    />
                  </div>
                );
              }

              const decisionLabel = node.decision?.choice ?? node.decision?.note ?? null;
              const summaryText = node.artifact?.summary ?? null;

              return (
                <div
                  key={box.id}
                  style={{
                    left: `${box.x}px`,
                    top: `${box.y}px`,
                    width: `${box.width}px`,
                    minHeight: `${box.height}px`,
                  }}
                  className={cn(
                    "absolute flex flex-col justify-between gap-1.5 rounded-xl px-3 py-2.5",
                    isPending
                      ? "border border-dashed border-line bg-transparent opacity-65"
                      : "border border-line bg-background",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {isDone && <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />}
                      {node.status === "attention" && (
                        <span className="size-2 shrink-0 rounded-full bg-caution" aria-hidden="true" />
                      )}
                      <span
                        className={cn(
                          "min-w-0 truncate text-minor font-medium",
                          node.status === "running" && "status-shimmer",
                          node.status === "skipped" && "opacity-60",
                        )}
                      >
                        {node.title}
                      </span>
                    </span>
                    {workerId !== null ? (
                      worker !== null ? (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChange(false);
                            onOpenWorker(worker.conversationId);
                          }}
                          className="shrink-0 cursor-pointer rounded-xl px-1.5 py-0.5 text-xs font-medium text-primary transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50 tabular-nums"
                        >
                          #{workerId}
                        </button>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{workerId}</span>
                      )
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{statusLabelOf(node)}</span>
                    )}
                  </div>
                  {decisionLabel !== null && (
                    <p className="truncate text-xs font-medium text-foreground">{decisionLabel}</p>
                  )}
                  {summaryText !== null && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{summaryText}</p>
                  )}
                  {canSkip && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={skipMutation.isPending || cancelMutation.isPending}
                        onClick={() => runExclusive(() => skipMutation.mutate(node.key))}
                        className="pointer-coarse:min-h-11 cursor-pointer rounded-xl px-1.5 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        Skip step
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
});
