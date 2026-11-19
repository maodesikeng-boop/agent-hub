import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "../ui/icons.ts";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  isTaskGraphReadyToFinish,
  isTaskNodeWaitingPm,
  isTaskNodeWaitingUser,
  userBlockerCardText,
  type ConversationId,
  type TaskGraph,
  type TaskGraphId,
  type TaskNode,
} from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { computeTaskGraphLayout, DEFAULT_ROOT_FONT_SIZE_PX } from "../task-graph-layout.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, ZOOM_DIALOG } from "../ui/dialog.tsx";
import { PM_FRUITS } from "../../shared/fruits.ts";
import type { JellyColorId } from "../../shared/slimes.ts";
import { fruitTrackVars } from "../lib/palette.ts";
import type { StepBead } from "../pixel-path.ts";
import { GRAPH_TUBE_CELL_PX } from "../task-graph-layout.ts";
import { GateMark } from "./GateMark.tsx";
import { UserBlockerCard } from "./UserBlockerCard.tsx";
import { GateDecisionCard, JellyBead, resolveBoundWorker, TubeLayer } from "./PeelTrack.tsx";
import { TaskProgressIcon } from "./TaskProgressIcon.tsx";

function readRootFontSizePx(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return DEFAULT_ROOT_FONT_SIZE_PX;
  }
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ROOT_FONT_SIZE_PX;
}

function readCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** 一张卡的测量键，也是它的 React key：图、步骤、形态（拍板卡还是普通卡）有一个变了就是另一张卡，重新挂载、重新量。 */
function measureKeyOf(graphId: TaskGraphId, nodeKey: string, waitingGate: boolean): string {
  return `${graphId}:${nodeKey}:${waitingGate ? "gate" : "node"}`;
}

/** 卡片头的果冻珠子（和右栏果皮轨同一套）：做完、在干、等项目经理、没轮到（跳过的也是空珠子）。 */
function beadOf(node: TaskNode): StepBead {
  if (node.status === "done") return node.skipped ? "pending" : "done";
  if (node.status === "running") return "running";
  if (isTaskNodeWaitingPm(node)) return "waitingPm";
  return "pending";
}

/** 卡片左上角的两位步骤号：底色看状态（docs/ui-standard.md 第 12.1 条）。 */
const STEP_TAG: Readonly<Record<"done" | "running" | "gate" | "other", string>> = {
  done: "bg-[var(--peel)] text-foreground",
  running: "bg-background text-foreground shadow-[inset_0_0_0_1px_var(--peel)]",
  gate: "bg-primary text-primary-foreground",
  other: "bg-accent text-muted-foreground",
};

function StepTag({ n, tone }: { n: number; tone: keyof typeof STEP_TAG }) {
  return <span className={cn("absolute top-0 left-0 px-1 text-xs leading-4 tabular-nums", STEP_TAG[tone])}>{String(n).padStart(2, "0")}</span>;
}

/** 卡片头的小珠子：14px 见方的像素小图，格子 2px。 */
function BeadIcon({ bead }: { bead: StepBead }) {
  return (
    <svg viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true" className="size-3.5 shrink-0">
      <JellyBead bead={bead} center={{ x: 7, y: 7 }} cell={GRAPH_TUBE_CELL_PX} />
    </svg>
  );
}

/** 四个状态的英文状态词（docs/ui-standard.md 第 3 条的词表）：等人按等谁分开，完了按是不是跳过的分开。 */
function statusLabelOf(node: TaskNode): string {
  switch (node.status) {
    case "done":
      return node.skipped ? "Skipped" : "Done";
    case "running":
      return "Working…";
    case "waiting":
      return node.waitingFor === "user" ? "Waiting on you" : "Waiting on PM";
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
  color = PM_FRUITS[0]!,
  onOpenWorker,
}: {
  graph: TaskGraph | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: readonly WorkerEntry[];
  /** 所属项目经理现在的颜色：管道、珠子和进度图标跟着它。 */
  color?: JellyColorId;
  onOpenWorker: (id: ConversationId) => void;
}) {
  // 当前区域那台设备的接口（device-scope.tsx）：跨设备看远端项目经理时，跳过、取消、拍板都发给那台
  const client = useClient();
  const qc = useHubQueryClient();
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
  // 每张卡画出来的实际高度（px）：量到了交给排版，同一列的下一张卡才不会压上来（拍板卡的摘要、折成两行的步骤名都估不准）。
  // 键是 measureKeyOf：换了图、同一步从拍板卡变成普通卡都是另一张卡，不沿用旧高度；卡卸载时把它那一项删掉，表里只有画着的卡
  const [measuredHeights, setMeasuredHeights] = useState<Readonly<Record<string, number>>>({});
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureCard = useCallback((el: HTMLDivElement | null) => {
    if (el === null || typeof ResizeObserver === "undefined") return;
    observerRef.current ??= new ResizeObserver((entries) => {
      setMeasuredHeights((prev) => {
        let next = prev;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.measureKey;
          const height = Math.ceil((entry.target as HTMLElement).offsetHeight);
          if (key !== undefined && height > 0 && next[key] !== height) next = { ...next, [key]: height };
        }
        return next;
      });
    });
    observerRef.current.observe(el);
    return () => {
      observerRef.current?.unobserve(el);
      const key = el.dataset.measureKey;
      if (key === undefined) return;
      setMeasuredHeights((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _gone, ...rest } = prev;
        return rest;
      });
    };
  }, []);
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
  const coarsePointer = open && readCoarsePointer();

  const layout = useMemo(() => {
    if (graph === null) return null;
    const isActive = graph.status === "active";
    return computeTaskGraphLayout({
      graphId: graph.id,
      nodes: graph.nodes.map((n) => {
        const activeWaitingUser = isActive && isTaskNodeWaitingUser(n);
        const measured = measuredHeights[measureKeyOf(graph.id, n.key, activeWaitingUser)];
        return {
          key: n.key,
          status: n.status,
          waitingFor: isActive ? n.waitingFor : null,
          hasCard: n.gateQuestion !== null || n.decision !== null,
          position: n.sortOrder,
          optionCount: n.gateOptions.length,
          hasSummary: Boolean(n.gateSummaryMd || n.artifact?.summary || n.decision),
          hasQuestion: n.gateQuestion !== null && n.gateQuestion.trim() !== "" && n.gateQuestion !== n.title,
          noteExpanded: Boolean(
            expandedNotes[n.key] ||
              (activeWaitingUser && (n.gateCheckpoint || n.gateOptions.length === 0)),
          ),
          ...(activeWaitingUser && n.userBlocker == null && n.artifact?.deliverables !== undefined
            ? { deliverables: n.artifact.deliverables }
            : {}),
          ...(measured !== undefined ? { measuredHeightPx: measured } : {}),
        };
      }),
      edges: graph.edges.map((e) => ({ from: e.fromKey, to: e.toKey })),
      viewportMode: "dialog",
      rootFontSizePx,
      coarsePointer,
    });
  }, [graph, expandedNotes, measuredHeights, rootFontSizePx, coarsePointer]);

  // 管子按走没走通分两组画（TubeLayer 先画一组的全部描边再画全部芯）
  const { emptyTubes, filledTubes } = useMemo(() => {
    const edges = layout?.edges ?? [];
    const tubesOf = (solid: boolean) => edges.filter((e) => e.solid === solid).map((e) => ({ center: e.d, highlight: e.highlightD }));
    return { emptyTubes: tubesOf(false), filledTubes: tubesOf(true) };
  }, [layout]);
  /** 步骤号：按 sortOrder 排的第几步（从 1 起）。 */
  const stepNumberOf = useMemo(() => {
    const order = new Map((graph?.nodes ?? []).toSorted((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)).map((n, i) => [n.key, i + 1]));
    return (key: string) => order.get(key) ?? 0;
  }, [graph]);

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
  const graphStateLabel =
    graph.status === "completed" ? "Completed" : graph.status === "cancelled" ? "Cancelled" : isTaskGraphReadyToFinish(graph) ? "Ready to finish" : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={graph.title} className={ZOOM_DIALOG}>
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-minor text-muted-foreground">
            <TaskProgressIcon graph={graph} color={color} size={20} />
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
                <Button variant="destructive" disabled={cancelMutation.isPending} onClick={() => runExclusive(() => cancelMutation.mutate())}>
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
        <DialogBody className="mx-0 block overflow-auto px-0">
          <div
            data-rankdir={layout.rankdir}
            style={{ ...fruitTrackVars(color), width: `${layout.width}px`, minHeight: `${layout.height}px` }}
            className="graph-canvas relative"
          >
            <svg
              aria-hidden="true"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              shapeRendering="crispEdges"
              className="pointer-events-none absolute inset-0"
            >
              <TubeLayer state="empty" segments={emptyTubes} cell={GRAPH_TUBE_CELL_PX} />
              <TubeLayer state="filled" segments={filledTubes} cell={GRAPH_TUBE_CELL_PX} />
              {layout.edges.map((edge) => (
                <g key={edge.id} data-arrow={edge.solid ? "filled" : "empty"}>
                  <path d={edge.arrowOutlineD} fill={edge.solid ? "var(--tube-line)" : "var(--tube-empty-line)"} />
                  <path d={edge.arrowFillD} fill={edge.solid ? "var(--tube-core)" : "var(--tube-empty-core)"} />
                </g>
              ))}
            </svg>
            {layout.nodes.map((box) => {
              if (box.boxKind !== "node") return null;
              const node = nodeByKey.get(box.nodeKey);
              if (!node) return null;
              const { workerId, worker } = resolveBoundWorker(node, workerByKey);
              const isWaitingGate = graph.status === "active" && isTaskNodeWaitingUser(node);
              const isPending = node.status === "pending";
              const isSkipped = node.status === "done" && node.skipped;
              const isDone = node.status === "done" && !node.skipped;
              const isRunning = node.status === "running";
              const isWaitingPm = isTaskNodeWaitingPm(node);
              // 没轮到、等项目经理（没有 Worker 挂着）的步骤能跳过；在干、等用户、完了的不行
              const canSkip = graph.status === "active" && (isPending || (isWaitingPm && node.activeWorkerId === null));
              const measureKey = measureKeyOf(graph.id, node.key, isWaitingGate);

              if (isWaitingGate) {
                return (
                  <div
                    key={measureKey}
                    ref={measureCard}
                    data-measure-key={measureKey}
                    style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` }}
                    className="absolute"
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                      <span className="flex min-w-0 items-center gap-2 text-minor font-semibold text-primary">
                        <span className="bg-primary px-1 text-xs leading-4 font-normal text-primary-foreground tabular-nums">{String(stepNumberOf(node.key)).padStart(2, "0")}</span>
                        <GateMark size={16} />
                        <span className="truncate" title={node.title}>{node.title}</span>
                      </span>
                      <span className="shrink-0 text-xs font-medium text-primary">Waiting on you</span>
                    </div>
                    {node.userBlocker != null ? (
                      <UserBlockerCard blockerId={node.userBlocker.id} text={userBlockerCardText(node.userBlocker)} showStatus={false} />
                    ) : (
                      <GateDecisionCard
                        key={node.gateAskMessageId ?? node.key}
                        graphId={graph.id}
                        node={node}
                        client={client}
                        onNoteToggle={(noteOpen) =>
                          setExpandedNotes((prev) => ({ ...prev, [node.key]: noteOpen }))
                        }
                      />
                    )}
                  </div>
                );
              }

              const decisionLabel = node.decision?.choice ?? node.decision?.note ?? null;
              const summaryText = node.artifact?.summary ?? null;

              return (
                <div
                  key={measureKey}
                  ref={measureCard}
                  data-measure-key={measureKey}
                  // 高度只由内容定，下限是写死的一档：把量到的高度写回这里，卡变矮时（拍板、跳过之后）会被旧高度撑住
                  style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px` }}
                  data-step={beadOf(node)}
                  className={cn("pixel-card absolute flex", isPending && "opacity-65")}
                >
                  <div className="pixel-card-body relative flex min-h-17 w-full flex-col justify-between gap-1.5 px-3 pt-5 pb-2.5">
                    <StepTag n={stepNumberOf(node.key)} tone={isDone ? "done" : isRunning ? "running" : "other"} />
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex min-w-0 items-start gap-1.5 [&>svg]:mt-0.75">
                        <BeadIcon bead={beadOf(node)} />
                        {/* 步骤名最多两行：并行的几步名字常常只有末尾不同，截成一行就分不出来 */}
                        <span
                          title={node.title}
                          className={cn(
                            "line-clamp-2 min-w-0 text-minor font-medium wrap-anywhere",
                            isRunning && "status-shimmer",
                            isSkipped && "text-muted-foreground opacity-60",
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
                </div>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
});
