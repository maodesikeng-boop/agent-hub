import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Loader2, Maximize2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isTaskGraphReadyToFinish, type ConversationId, type TaskGraph, type TaskGraphId, type TaskNode, type WorkerId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import { useClient } from "../device-scope.tsx";
import { cleanPieceTitle, errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { sortActiveGraphs, taskGraphPriority, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { KnifeAvatar } from "./KnifeAvatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { computeGraphComponents, fruitTrackVars, SliceWheelIcon } from "./SliceWheelIcon.tsx";

type GutterKind = "station" | "parA" | "parB" | "coil" | "gate";
type LineStyle = "solid" | "dash" | "none";
type DotTone = "done" | "run" | "ready" | "warn" | "blocked";

const GUTTER_H = 32;
const GUTTER_CY = GUTTER_H / 2;
const GATE_TOP_Y = GUTTER_CY - 9;
const GATE_BOT_Y = GUTTER_CY + 11;
const DEFAULT_GUTTER_W = 40;
const MAX_GUTTER_W = 96;
const LANE_MAIN_X = 11;
const LANE_PAR_X = 29;
const MULTI_LANE_PAD_X = 10;
const MULTI_LANE_STEP_X = 14;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeGutterGeometry(maxLanes: number): { gutterWidth: number; laneX: (lane: number) => number } {
  if (maxLanes <= 2) {
    return {
      gutterWidth: DEFAULT_GUTTER_W,
      laneX: (lane: number) => (lane <= 0 ? LANE_MAIN_X : LANE_PAR_X),
    };
  }
  const gutterWidth = Math.min(MAX_GUTTER_W, 2 * MULTI_LANE_PAD_X + (maxLanes - 1) * MULTI_LANE_STEP_X);
  const step = (gutterWidth - 2 * MULTI_LANE_PAD_X) / (maxLanes - 1);
  return {
    gutterWidth,
    laneX: (lane: number) => round2(MULTI_LANE_PAD_X + lane * step),
  };
}

function buildCoilPathD(baseX: number): string {
  const pts: string[] = [];
  const turns = 1.6;
  const r0 = 7.6;
  const cyc = GUTTER_CY + 2;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const r = r0 - 5.8 * t;
    const a = Math.PI + t * turns * 2 * Math.PI;
    const x = round2(baseX + r0 + r * Math.cos(a));
    const y = round2(cyc + r * Math.sin(a));
    pts.push(`${x} ${y}`);
  }
  return `M${baseX} ${GUTTER_H}V${cyc}L${pts.join("L")}`;
}

interface GutterSegment {
  readonly d: string;
  readonly style: "solid" | "dash";
}

interface LaneExit {
  readonly x: number;
  readonly style: "solid" | "dash";
}

function TrackPath({ style, d }: { style: LineStyle; d: string }) {
  if (style === "none") return null;
  if (style === "solid") {
    return <path d={d} fill="none" stroke="var(--peel)" strokeWidth="3.6" strokeLinecap="round" />;
  }
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--ghost-line)"
      strokeWidth="1.6"
      strokeDasharray="2 4"
      strokeLinecap="round"
    />
  );
}

function TrackDot({ x, tone }: { x: number; tone: DotTone }) {
  if (tone === "done") {
    return (
      <>
        <circle cx={x} cy={GUTTER_CY} r="6.2" fill="var(--cut)" />
        <circle cx={x} cy={GUTTER_CY} r="4.4" fill="var(--peel)" />
      </>
    );
  }
  if (tone === "run") {
    return (
      <>
        <circle cx={x} cy={GUTTER_CY} r="7.6" fill="var(--pulp-pale)" />
        <circle cx={x} cy={GUTTER_CY} r="5.1" fill="var(--cut)" stroke="var(--peel)" strokeWidth="2.5" />
      </>
    );
  }
  if (tone === "ready") {
    return <circle cx={x} cy={GUTTER_CY} r="4.8" fill="var(--cut)" stroke="var(--peel)" strokeWidth="2" />;
  }
  if (tone === "warn") {
    return (
      <>
        <circle cx={x} cy={GUTTER_CY} r="6.2" fill="var(--cut)" />
        <circle cx={x} cy={GUTTER_CY} r="4.4" fill="var(--caution)" />
      </>
    );
  }
  return <circle cx={x} cy={GUTTER_CY} r="4.3" fill="var(--cut)" stroke="var(--ghost-line)" strokeWidth="1.5" />;
}

function PeelGutter({
  kind,
  gutterWidth,
  dotX,
  tone = "done",
  segments,
}: {
  kind: GutterKind;
  gutterWidth: number;
  dotX: number;
  tone?: DotTone;
  segments: readonly GutterSegment[];
}) {
  const dashSegments = segments.filter((s) => s.style === "dash");
  const solidSegments = segments.filter((s) => s.style === "solid");

  return (
    <svg
      data-peel-gutter={kind}
      data-dot-x={dotX}
      viewBox={`0 0 ${gutterWidth} ${GUTTER_H}`}
      style={{ width: `${gutterWidth / 16}rem`, height: "2rem" }}
      aria-hidden="true"
      className="block shrink-0 select-none"
    >
      {dashSegments.map((seg, idx) => (
        <TrackPath key={`d-${idx}`} style="dash" d={seg.d} />
      ))}
      {solidSegments.map((seg, idx) => (
        <TrackPath key={`s-${idx}`} style="solid" d={seg.d} />
      ))}
      {kind === "coil" && (
        <path
          d={buildCoilPathD(dotX)}
          fill="none"
          stroke="var(--peel)"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {kind !== "coil" && kind !== "gate" && <TrackDot x={dotX} tone={tone} />}
    </svg>
  );
}

function isNodeSettled(node: TaskNode): boolean {
  return node.status === "done" || node.status === "skipped";
}

function dotToneOf(node: TaskNode): DotTone {
  if (node.status === "done") return "done";
  if (node.status === "running") return "run";
  if (node.status === "ready") return "ready";
  if (node.status === "attention") return "warn";
  return "blocked";
}

function makeClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 激活态门禁（waiting_user）浅果冻拍板卡：
 * 支持一键点选推荐/普通项、点选选项+附言、或直接输入自定义备注提交（POST /api/task-graphs/:graphId/nodes/:nodeKey/decide）。
 */
export function GateDecisionCard({
  graphId,
  node,
  client,
  onNoteToggle,
  className,
}: {
  graphId: TaskGraphId;
  node: TaskNode;
  client: HubClient;
  onNoteToggle?: (open: boolean) => void;
  className?: string;
}) {
  const qc = useHubQueryClient();
  const hasOptions = node.gateOptions.length > 0;
  const [noteOpen, setNoteOpen] = useState(!hasOptions);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<ErrorLike | null>(null);
  // 同一次拍板（含失败后重试）沿用同一个 clientId，服务端按它严格幂等；成功后才换新的
  const clientIdRef = useRef<string | null>(null);
  // 同步防重入：useMutation 的 isPending 要等下一次渲染才变，连点两下会在它变之前各发一次请求
  const inFlightRef = useRef(false);

  const decideMutation = useMutation(
    {
      mutationFn: async (vars: { choice: string | null; note: string | null }) => {
        clientIdRef.current ??= makeClientId();
        return client.postTaskGraphDecide(graphId, node.key, {
          clientId: clientIdRef.current,
          choice: vars.choice,
          ...(vars.note !== null ? { note: vars.note } : {}),
        });
      },
      onMutate: () => setErr(null),
      onSuccess: () => {
        clientIdRef.current = null;
        setNote("");
      },
      onError: (error) => {
        setErr(errorText(error));
      },
      onSettled: () => {
        inFlightRef.current = false;
      },
    },
    qc,
  );

  const submit = (choice: string | null, rawNote: string) => {
    if (inFlightRef.current) return;
    const trimmed = rawNote.trim();
    if (choice === null && trimmed === "") return;
    inFlightRef.current = true;
    decideMutation.mutate({ choice, note: trimmed === "" ? null : trimmed });
  };

  const showQuestion = node.gateQuestion !== null && node.gateQuestion.trim() !== "" && node.gateQuestion !== node.title;
  const showSummary = node.gateSummaryMd !== null && node.gateSummaryMd.trim() !== "";

  return (
    <div
      data-testid="peel-gate-card"
      className={cn("rounded-2xl border border-primary bg-jelly px-3.5 py-3", className)}
    >
      {showQuestion && <p className="mb-1 text-minor font-medium text-foreground">{node.gateQuestion}</p>}
      {showSummary && (
        <div className="mb-2 text-minor leading-relaxed text-foreground">
          <Markdown text={node.gateSummaryMd!} />
        </div>
      )}
      {hasOptions && (
        <div className="grid gap-2">
          {node.gateOptions.map((opt) => {
            const isRec = node.gateRecommended !== null && opt === node.gateRecommended;
            return (
              <button
                key={opt}
                type="button"
                disabled={decideMutation.isPending}
                onClick={() => submit(opt, note)}
                className={cn(
                  "flex min-h-9 pointer-coarse:min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-left text-minor font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:bg-sidebar-active disabled:text-muted-foreground",
                  isRec
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-background text-foreground hover:bg-jelly-hover",
                )}
              >
                <span className="min-w-0 flex-1">{opt}</span>
                {isRec && <span className="shrink-0 text-xs font-normal opacity-90">Recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      {!noteOpen && hasOptions ? (
        <button
          type="button"
          onClick={() => {
            setNoteOpen(true);
            onNoteToggle?.(true);
          }}
          className="mt-2 inline-flex min-h-7 pointer-coarse:min-h-11 cursor-pointer items-center rounded-xl px-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Add note
        </button>
      ) : (
        <div className={cn("flex items-center gap-2", hasOptions && "mt-2.5")}>
          <Input
            value={note}
            disabled={decideMutation.isPending}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note, or type a custom reply…"
            aria-label="Add note"
            className="min-w-0 flex-1 text-minor"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && note.trim() !== "") {
                e.preventDefault();
                submit(null, note);
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={decideMutation.isPending || note.trim() === ""}
            onClick={() => submit(null, note)}
          >
            {decideMutation.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Send
          </Button>
        </div>
      )}
      {err !== null && (
        <p role="alert" title={errorTitle(err)} className="mt-2 text-xs text-danger">
          {errorLine(err)}
        </p>
      )}
    </div>
  );
}

export function resolveBoundWorker(
  node: TaskNode,
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>,
): { workerId: WorkerId | null; worker: WorkerEntry | null } {
  const wid = node.activeWorkerId ?? node.workerIds.at(-1) ?? null;
  if (wid === null) return { workerId: null, worker: null };
  return { workerId: wid, worker: workerByKey.get(wid) ?? null };
}

function PeelStageRow({
  graphId,
  node,
  gutterKind,
  gutterWidth,
  dotX,
  segments,
  exitLanes,
  hasBelow,
  workerByKey,
  openWorkerId,
  client,
  onOpenWorker,
}: {
  graphId: TaskGraphId;
  node: TaskNode;
  gutterKind: GutterKind;
  gutterWidth: number;
  dotX: number;
  segments: readonly GutterSegment[];
  exitLanes: readonly LaneExit[];
  hasBelow: boolean;
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  client: HubClient;
  onOpenWorker: (id: ConversationId) => void;
}) {
  if (node.kind === "gate" && node.status === "waiting_user") {
    const gutterRem = `${gutterWidth / 16}rem`;
    const knifeLeftRem = `${(dotX - 15) / 16}rem`;
    return (
      <div data-node-key={node.key} className="relative flex items-start">
        {hasBelow && exitLanes.length > 0 && (
          <svg
            data-peel-gate-ext
            aria-hidden="true"
            style={{ width: gutterRem, height: "calc(100% - 2rem)" }}
            className="pointer-events-none absolute top-8 left-0 block select-none"
          >
            {exitLanes.map((lane, idx) => {
              const xPct = `${round2((lane.x / gutterWidth) * 100)}%`;
              return lane.style === "solid" ? (
                <line
                  key={`ext-${idx}`}
                  x1={xPct}
                  y1="0"
                  x2={xPct}
                  y2="100%"
                  stroke="var(--peel)"
                  strokeWidth="3.6"
                  strokeLinecap="round"
                />
              ) : (
                <line
                  key={`ext-${idx}`}
                  x1={xPct}
                  y1="0"
                  x2={xPct}
                  y2="100%"
                  stroke="var(--ghost-line)"
                  strokeWidth="1.6"
                  strokeDasharray="2 4"
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        )}
        <div style={{ width: gutterRem, height: "2rem" }} className="relative flex shrink-0 items-center">
          <PeelGutter kind="gate" gutterWidth={gutterWidth} dotX={dotX} segments={segments} />
          <span style={{ left: knifeLeftRem }} className="pointer-events-none absolute top-0 inline-flex">
            <KnifeAvatar size={30} />
          </span>
        </div>
        <div className="min-w-0 flex-1 pb-2">
          <div className="flex min-h-8 items-center text-body font-semibold text-primary">
            <span className="truncate">{cleanPieceTitle(node.title)}</span>
          </div>
          <GateDecisionCard graphId={graphId} node={node} client={client} className="rounded-tl-xl" />
        </div>
      </div>
    );
  }

  const { workerId, worker } = resolveBoundWorker(node, workerByKey);
  const active = worker !== null && worker.conversationId === openWorkerId;
  const isBlocked = node.status === "pending";
  const isSkipped = node.status === "skipped";
  const isRunning = node.status === "running";
  const gateChoice =
    node.kind === "gate" && node.status === "done"
      ? (node.decision?.choice ?? node.decision?.note ?? "Done")
      : null;

  const rightLabel =
    gateChoice !== null ? (
      <span className="max-w-28 shrink-0 truncate text-xs text-foreground">{gateChoice}</span>
    ) : workerId !== null ? (
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{workerId}</span>
    ) : isSkipped ? (
      <span className="shrink-0 text-xs text-muted-foreground">Skipped</span>
    ) : node.status === "attention" ? (
      <span className="shrink-0 text-xs text-caution">Needs attention</span>
    ) : null;

  const content = (
    <>
      <PeelGutter
        kind={gutterKind}
        gutterWidth={gutterWidth}
        dotX={dotX}
        tone={dotToneOf(node)}
        segments={segments}
      />
      <span className="flex min-h-8 min-w-0 flex-1 items-center justify-between gap-2">
        <span
          className={cn(
            "min-w-0 truncate text-minor",
            (isBlocked || isSkipped) && "text-muted-foreground",
            isSkipped && "opacity-60",
            isRunning && "status-shimmer text-foreground",
            !isBlocked && !isSkipped && !isRunning && "text-foreground",
          )}
        >
          {cleanPieceTitle(node.title)}
        </span>
        {rightLabel}
      </span>
    </>
  );

  if (worker !== null) {
    return (
      <button
        type="button"
        data-node-key={node.key}
        aria-current={active ? "true" : undefined}
        aria-label={node.title}
        title={node.title}
        onClick={() => onOpenWorker(worker.conversationId)}
        className={cn(
          "-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active ? "bg-jelly" : "hover:bg-jelly-hover",
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div data-node-key={node.key} title={node.title} className="flex min-h-8 pointer-coarse:min-h-11 items-center">
      {content}
    </div>
  );
}

interface DirectedEdge {
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * 传递约简（Hasse 图）：若已存在 u ->+ ... ->+ v 的更长有向路径且不存在反向环路，
 * 则去掉跨层冗余弦边 (u, v)，避免紧凑轨道额外分出无意义的旁路，同时 100% 保持全部真实依赖可达性。
 */
function reduceTransitiveEdges(keys: readonly string[], edges: readonly DirectedEdge[]): DirectedEdge[] {
  const keySet = new Set(keys);
  const adj = new Map<string, Set<string>>();
  for (const k of keys) adj.set(k, new Set());

  const uniqueEdges: DirectedEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.fromKey === e.toKey || !keySet.has(e.fromKey) || !keySet.has(e.toKey)) continue;
    const id = `${e.fromKey}->${e.toKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueEdges.push(e);
    adj.get(e.fromKey)!.add(e.toKey);
  }

  const canReach = (start: string, target: string, skipDirectFrom?: string, skipDirectTo?: string): boolean => {
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (cur === skipDirectFrom && nxt === skipDirectTo) continue;
        if (nxt === target) return true;
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return false;
  };

  for (const e of uniqueEdges) {
    if (canReach(e.fromKey, e.toKey, e.fromKey, e.toKey) && !canReach(e.toKey, e.fromKey)) {
      adj.get(e.fromKey)!.delete(e.toKey);
    }
  }

  return uniqueEdges.filter((e) => adj.get(e.fromKey)!.has(e.toKey));
}

/**
 * 链优先拓扑序（照 git log --graph --topo-order）：
 * 汇合之前尽量沿着刚解锁的子节点一路往下排，把同一条多步分支链紧凑排在一起；
 * 遇到多上游汇合屏障时再切去排另一条待汇合的分支链，避免跨链交错穿插。
 */
function orderComponentNodes(nodes: readonly TaskNode[], reducedEdges: readonly DirectedEdge[]): TaskNode[] {
  const indexByKey = new Map<string, number>();
  const nodeByKey = new Map<string, TaskNode>();
  nodes.forEach((n, idx) => {
    if (!nodeByKey.has(n.key)) {
      nodeByKey.set(n.key, n);
      indexByKey.set(n.key, idx);
    }
  });
  const unique = [...nodeByKey.values()];
  const compareDecl = (a: TaskNode, b: TaskNode): number => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (indexByKey.get(a.key) ?? 0) - (indexByKey.get(b.key) ?? 0);
  };

  const children = new Map<string, TaskNode[]>();
  const remInDeg = new Map<string, number>();
  for (const n of unique) {
    children.set(n.key, []);
    remInDeg.set(n.key, 0);
  }
  for (const e of reducedEdges) {
    children.get(e.fromKey)!.push(nodeByKey.get(e.toKey)!);
    remInDeg.set(e.toKey, (remInDeg.get(e.toKey) ?? 0) + 1);
  }
  for (const list of children.values()) list.sort(compareDecl);

  const canReachNode = (start: string, targets: ReadonlySet<string>): boolean => {
    if (targets.size === 0) return false;
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of children.get(cur) ?? []) {
        if (targets.has(nxt.key)) return true;
        if (!seen.has(nxt.key)) {
          seen.add(nxt.key);
          queue.push(nxt.key);
        }
      }
    }
    return false;
  };

  const visited = new Set<string>();
  const ordered: TaskNode[] = [];
  const chainStack: TaskNode[] = [];

  while (ordered.length < unique.length) {
    let picked: TaskNode | undefined;
    while (chainStack.length > 0) {
      const top = chainStack.pop()!;
      if (!visited.has(top.key)) {
        picked = top;
        break;
      }
    }

    if (picked === undefined) {
      const ready = unique.filter((n) => !visited.has(n.key) && (remInDeg.get(n.key) ?? 0) === 0).sort(compareDecl);
      if (ready.length > 0) {
        // 若已有前序分支停在汇合屏障前等待，优先挑能通向该汇合节点的就绪分支，尽早闭合占用的泳道
        const waitingMerges = new Set<string>();
        for (const doneNode of ordered) {
          for (const ch of children.get(doneNode.key) ?? []) {
            if (!visited.has(ch.key)) waitingMerges.add(ch.key);
          }
        }
        picked = ready.find((r) => canReachNode(r.key, waitingMerges)) ?? ready[0]!;
      } else {
        picked = unique.filter((n) => !visited.has(n.key)).sort(compareDecl)[0]!;
      }
    }

    visited.add(picked.key);
    ordered.push(picked);

    const unlocked: TaskNode[] = [];
    for (const ch of children.get(picked.key) ?? []) {
      const nextDeg = (remInDeg.get(ch.key) ?? 1) - 1;
      remInDeg.set(ch.key, nextDeg);
      if (nextDeg === 0 && !visited.has(ch.key)) unlocked.push(ch);
    }
    unlocked.sort(compareDecl);
    for (let i = unlocked.length - 1; i >= 0; i--) {
      chainStack.push(unlocked[i]!);
    }
  }

  return ordered;
}

interface TrackComponent {
  readonly key: string;
  readonly orderedNodes: readonly TaskNode[];
  readonly reducedEdges: readonly DirectedEdge[];
  readonly childrenByKey: ReadonlyMap<string, readonly string[]>;
  readonly walkedByKey: ReadonlyMap<string, boolean>;
}

function computeTrackComponents(graph: Pick<TaskGraph, "nodes" | "edges">): TrackComponent[] {
  return computeGraphComponents(graph).map((component) => {
    const rawKeys = [...new Set(component.nodes.map((n) => n.key))];
    const reducedEdges = reduceTransitiveEdges(rawKeys, component.edges);
    const orderedNodes = orderComponentNodes(component.nodes, reducedEdges);

    const parentsByKey = new Map<string, string[]>();
    const childrenByKey = new Map<string, string[]>();
    for (const n of orderedNodes) {
      parentsByKey.set(n.key, []);
      childrenByKey.set(n.key, []);
    }
    for (const e of reducedEdges) {
      parentsByKey.get(e.toKey)!.push(e.fromKey);
      childrenByKey.get(e.fromKey)!.push(e.toKey);
    }

    const walkedByKey = new Map<string, boolean>();
    for (const n of orderedNodes) {
      const parents = parentsByKey.get(n.key) ?? [];
      const allParentsWalked = parents.every((p) => walkedByKey.get(p) === true);
      walkedByKey.set(n.key, isNodeSettled(n) && allParentsWalked);
    }

    return {
      key: orderedNodes[0]!.key,
      orderedNodes,
      reducedEdges,
      childrenByKey,
      walkedByKey,
    };
  });
}

type DisplayItem =
  | { readonly itemKind: "coil"; readonly key: string; readonly count: number; readonly walked: true }
  | { readonly itemKind: "node" | "gate"; readonly key: string; readonly node: TaskNode; readonly walked: boolean }
  | { readonly itemKind: "next"; readonly key: string; readonly count: number; readonly walked: false };

interface RenderedTrackRow {
  readonly item: DisplayItem;
  readonly gutterKind: GutterKind;
  readonly dotX: number;
  readonly segments: readonly GutterSegment[];
  readonly exitLanes: readonly LaneExit[];
  readonly hasBelow: boolean;
}

function lowestFreeLane(lanes: readonly (string | null)[]): number {
  const idx = lanes.indexOf(null);
  return idx >= 0 ? idx : lanes.length;
}

/**
 * 源点独占多泳道布线：
 * 任意行边界处，每个尚未走完下游的已渲染节点独占一条平行泳道；
 * 仅当存在真实有向依赖 u -> w 时才从 u 的泳道连入 w 的圆点/刀口，确保画出的每条线段都 1:1 对应真实依赖。
 */
function layoutDisplayTrack(
  items: readonly DisplayItem[],
  rawDisplayEdges: readonly DirectedEdge[],
): { gutterWidth: number; rows: RenderedTrackRow[] } {
  const itemKeys = items.map((it) => it.key);
  const edges = reduceTransitiveEdges(itemKeys, rawDisplayEdges);

  const parentsMap = new Map<string, string[]>();
  const remOutDeg = new Map<string, number>();
  const styleByKey = new Map<string, "solid" | "dash">();
  for (const it of items) {
    parentsMap.set(it.key, []);
    remOutDeg.set(it.key, 0);
    styleByKey.set(it.key, it.walked ? "solid" : "dash");
  }
  for (const e of edges) {
    parentsMap.get(e.toKey)!.push(e.fromKey);
    remOutDeg.set(e.fromKey, (remOutDeg.get(e.fromKey) ?? 0) + 1);
  }

  type LogicalOp =
    | { kind: "thru"; lane: number; style: "solid" | "dash" }
    | { kind: "in"; fromLane: number; toLane: number; target: "dot" | "gate"; style: "solid" | "dash" }
    | { kind: "fork"; fromLane: number; toLane: number; style: "solid" | "dash" }
    | { kind: "out"; lane: number; source: "dot" | "gate" | "coil"; style: "solid" | "dash" };

  interface LogicalRow {
    item: DisplayItem;
    dotLane: number;
    ops: LogicalOp[];
    exits: Array<{ lane: number; style: "solid" | "dash" }>;
    bottomLaneCount: number;
  }

  const activeLanes: Array<string | null> = [];
  const setLane = (lane: number, key: string | null) => {
    while (activeLanes.length <= lane) activeLanes.push(null);
    activeLanes[lane] = key;
  };

  let maxLaneUsed = 0;
  const logicalRows: LogicalRow[] = [];

  for (const item of items) {
    const parents = parentsMap.get(item.key) ?? [];
    const parentSet = new Set(parents);
    const beforeLaneOf = new Map<string, number>();
    activeLanes.forEach((k, l) => {
      if (k !== null) beforeLaneOf.set(k, l);
    });

    for (const p of parents) {
      remOutDeg.set(p, (remOutDeg.get(p) ?? 1) - 1);
    }

    const termParents = parents
      .filter((p) => (remOutDeg.get(p) ?? 0) === 0)
      .sort((a, b) => (beforeLaneOf.get(a) ?? 0) - (beforeLaneOf.get(b) ?? 0));
    const contParents = parents
      .filter((p) => (remOutDeg.get(p) ?? 0) > 0)
      .sort((a, b) => (beforeLaneOf.get(a) ?? 0) - (beforeLaneOf.get(b) ?? 0));

    let dotLane: number;
    let singleContForkLane: number | null = null;

    if (termParents.length > 0) {
      dotLane = beforeLaneOf.get(termParents[0]!) ?? 0;
      for (const p of termParents) {
        const l = beforeLaneOf.get(p);
        if (l !== undefined) setLane(l, null);
      }
    } else if (contParents.length === 1) {
      const p = contParents[0]!;
      dotLane = beforeLaneOf.get(p) ?? 0;
      singleContForkLane = lowestFreeLane(activeLanes);
      setLane(dotLane, null);
      setLane(singleContForkLane, p);
    } else {
      dotLane = lowestFreeLane(activeLanes);
    }

    const ops: LogicalOp[] = [];

    for (const [k, l] of beforeLaneOf) {
      if (!parentSet.has(k)) {
        ops.push({ kind: "thru", lane: l, style: styleByKey.get(k) ?? "dash" });
      }
    }

    const targetKind = item.itemKind === "gate" ? "gate" : "dot";
    for (const p of parents) {
      const fromLane = beforeLaneOf.get(p) ?? 0;
      const pStyle = styleByKey.get(p) ?? "dash";
      ops.push({ kind: "in", fromLane, toLane: dotLane, target: targetKind, style: pStyle });
      if ((remOutDeg.get(p) ?? 0) > 0) {
        if (singleContForkLane !== null && fromLane === dotLane) {
          ops.push({ kind: "fork", fromLane: dotLane, toLane: singleContForkLane, style: pStyle });
        } else {
          ops.push({ kind: "thru", lane: fromLane, style: pStyle });
        }
      }
    }

    if ((remOutDeg.get(item.key) ?? 0) > 0) {
      setLane(dotLane, item.key);
      const outSource = item.itemKind === "coil" ? "coil" : item.itemKind === "gate" ? "gate" : "dot";
      ops.push({ kind: "out", lane: dotLane, source: outSource, style: styleByKey.get(item.key) ?? "dash" });
    }

    const exits: Array<{ lane: number; style: "solid" | "dash" }> = [];
    activeLanes.forEach((k, l) => {
      if (k !== null) {
        exits.push({ lane: l, style: styleByKey.get(k) ?? "dash" });
        if (l > maxLaneUsed) maxLaneUsed = l;
      }
    });
    if (dotLane > maxLaneUsed) maxLaneUsed = dotLane;

    logicalRows.push({
      item,
      dotLane,
      ops,
      exits,
      bottomLaneCount: exits.length,
    });
  }

  const { gutterWidth, laneX } = computeGutterGeometry(maxLaneUsed + 1);

  const rows: RenderedTrackRow[] = logicalRows.map((row, idx) => {
    const dotX = laneX(row.dotLane);
    const segments: GutterSegment[] = [];

    for (const op of row.ops) {
      if (op.kind === "thru") {
        const x = laneX(op.lane);
        segments.push({ style: op.style, d: `M${x} 0V${GUTTER_H}` });
      } else if (op.kind === "in") {
        const xFrom = laneX(op.fromLane);
        const xTo = laneX(op.toLane);
        if (op.target === "gate") {
          segments.push({
            style: op.style,
            d: xFrom === xTo ? `M${xTo} 0V${GATE_TOP_Y}` : `M${xFrom} 0C${xFrom} 4 ${xTo} 3 ${xTo} ${GATE_TOP_Y}`,
          });
        } else {
          segments.push({
            style: op.style,
            d: xFrom === xTo ? `M${xTo} 0V${GUTTER_CY}` : `M${xFrom} 0C${xFrom} 10 ${xTo} 6 ${xTo} ${GUTTER_CY}`,
          });
        }
      } else if (op.kind === "fork") {
        const xFrom = laneX(op.fromLane);
        const xTo = laneX(op.toLane);
        segments.push({
          style: op.style,
          d: `M${xFrom} 0C${xFrom} 15 ${xTo} 13 ${xTo} ${GUTTER_H}`,
        });
      } else if (op.kind === "out") {
        if (op.source === "coil") continue;
        const x = laneX(op.lane);
        const y0 = op.source === "gate" ? GATE_BOT_Y : GUTTER_CY;
        segments.push({ style: op.style, d: `M${x} ${y0}V${GUTTER_H}` });
      }
    }

    const gutterKind: GutterKind =
      row.item.itemKind === "coil"
        ? "coil"
        : row.item.itemKind === "gate"
          ? "gate"
          : row.dotLane > 0
            ? "parB"
            : row.bottomLaneCount >= 2
              ? "parA"
              : "station";

    return {
      item: row.item,
      gutterKind,
      dotX,
      segments,
      exitLanes: row.exits.map((e) => ({ x: laneX(e.lane), style: e.style })),
      hasBelow: idx < logicalRows.length - 1,
    };
  });

  return { gutterWidth, rows };
}

/** 判断已完成前缀 P = orderedNodes[0..k-1] 能否安全卷成一个 N done 而不把独立旁链混为一谈。 */
function canFoldDonePrefix(
  orderedNodes: readonly TaskNode[],
  k: number,
  childrenByKey: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (k < 2) return false;
  const prefixSet = new Set<string>();
  for (let i = 0; i < k; i++) prefixSet.add(orderedNodes[i]!.key);

  let commonTargetSignature: string | null = null;
  let exitNodeCount = 0;
  for (let i = 0; i < k; i++) {
    const u = orderedNodes[i]!.key;
    const outs = (childrenByKey.get(u) ?? []).filter((v) => !prefixSet.has(v)).toSorted();
    if (outs.length === 0) continue;
    exitNodeCount++;
    const sig = outs.join("\0");
    if (commonTargetSignature === null) {
      commonTargetSignature = sig;
    } else if (commonTargetSignature !== sig) {
      return false;
    }
  }
  return exitNodeCount <= 1 || commonTargetSignature !== null;
}

interface PeelRowContext {
  graphId: TaskGraphId;
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  client: HubClient;
  onOpenWorker: (id: ConversationId) => void;
}

/** 一个连通子图的果皮轨：已完成卷与 N next 折叠只在本子图内生效，首尾不与别的子图相连。 */
function PeelComponentTrack({ component, ctx }: { component: TrackComponent; ctx: PeelRowContext }) {
  const { orderedNodes, reducedEdges, childrenByKey, walkedByKey } = component;
  const { openWorkerId, workerByKey } = ctx;
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [nextExpanded, setNextExpanded] = useState(false);

  // 计算连续已完成的上游前缀（至少保留最后一项不折叠，刚拍板通过的 gate 留在前沿上方展示简称，且不把尚未汇合的独立旁链混进同一个卷）
  let rawPrefixEnd = 0;
  while (rawPrefixEnd < orderedNodes.length - 1 && isNodeSettled(orderedNodes[rawPrefixEnd]!)) {
    rawPrefixEnd++;
  }
  while (
    rawPrefixEnd > 0 &&
    orderedNodes[rawPrefixEnd - 1]!.kind === "gate" &&
    orderedNodes[rawPrefixEnd - 1]!.decision !== null
  ) {
    rawPrefixEnd--;
  }
  let prefixEnd = rawPrefixEnd;
  while (prefixEnd >= 2 && !canFoldDonePrefix(orderedNodes, prefixEnd, childrenByKey)) {
    prefixEnd--;
  }
  if (prefixEnd < 2) prefixEnd = 0;

  const prefixNodes = orderedNodes.slice(0, prefixEnd);
  const openInPrefix =
    openWorkerId !== null &&
    prefixNodes.some((n) => resolveBoundWorker(n, workerByKey).worker?.conversationId === openWorkerId);
  useEffect(() => {
    if (openInPrefix) setDoneExpanded(true);
  }, [openInPrefix]);

  const foldDone = prefixEnd >= 2 && !doneExpanded;
  const visibleStart = foldDone ? prefixEnd : 0;

  // 计算尾部连续未解锁（pending）且内部拓扑深度 >= 2 的下游链路（折叠为 N next）
  let suffixStart = orderedNodes.length;
  while (
    suffixStart - 1 > visibleStart &&
    suffixStart - 1 > 0 &&
    orderedNodes[suffixStart - 1]!.status === "pending"
  ) {
    suffixStart--;
  }
  const suffixNodes = orderedNodes.slice(suffixStart);
  const suffixSet = new Set(suffixNodes.map((n) => n.key));
  const suffixHasInternalChain =
    suffixNodes.length >= 2 && reducedEdges.some((e) => suffixSet.has(e.fromKey) && suffixSet.has(e.toKey));
  const foldNext = suffixHasInternalChain && !nextExpanded;
  const visibleEnd = foldNext ? suffixStart : orderedNodes.length;

  const { gutterWidth, rows } = useMemo(() => {
    const DONE_KEY = "__peel_done__";
    const NEXT_KEY = "__peel_next__";
    const items: DisplayItem[] = [];
    const mappedKey = new Map<string, string>();

    if (foldDone) {
      items.push({ itemKind: "coil", key: DONE_KEY, count: prefixEnd, walked: true });
      for (let i = 0; i < prefixEnd; i++) mappedKey.set(orderedNodes[i]!.key, DONE_KEY);
    }
    for (let i = visibleStart; i < visibleEnd; i++) {
      const node = orderedNodes[i]!;
      mappedKey.set(node.key, node.key);
      items.push({
        itemKind: node.kind === "gate" && node.status === "waiting_user" ? "gate" : "node",
        key: node.key,
        node,
        walked: walkedByKey.get(node.key) ?? false,
      });
    }
    if (foldNext) {
      items.push({ itemKind: "next", key: NEXT_KEY, count: suffixNodes.length, walked: false });
      for (let i = visibleEnd; i < orderedNodes.length; i++) mappedKey.set(orderedNodes[i]!.key, NEXT_KEY);
    }

    const projectedEdges: DirectedEdge[] = [];
    for (const e of reducedEdges) {
      const u = mappedKey.get(e.fromKey);
      const v = mappedKey.get(e.toKey);
      if (u !== undefined && v !== undefined && u !== v) {
        projectedEdges.push({ fromKey: u, toKey: v });
      }
    }

    return layoutDisplayTrack(items, projectedEdges);
  }, [foldDone, foldNext, orderedNodes, prefixEnd, reducedEdges, suffixNodes.length, visibleEnd, visibleStart, walkedByKey]);

  return (
    <div data-peel-component={component.key}>
      {rows.map((row) => {
        if (row.item.itemKind === "coil") {
          return (
            <button
              key={row.item.key}
              type="button"
              onClick={() => setDoneExpanded(true)}
              className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PeelGutter
                kind="coil"
                gutterWidth={gutterWidth}
                dotX={row.dotX}
                segments={row.segments}
              />
              <span>{row.item.count} done</span>
            </button>
          );
        }
        if (row.item.itemKind === "next") {
          return (
            <button
              key={row.item.key}
              type="button"
              onClick={() => setNextExpanded(true)}
              className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PeelGutter
                kind={row.gutterKind}
                gutterWidth={gutterWidth}
                dotX={row.dotX}
                tone="blocked"
                segments={row.segments}
              />
              <span>{row.item.count} next</span>
            </button>
          );
        }
        return (
          <PeelStageRow
            key={row.item.node.key}
            graphId={ctx.graphId}
            node={row.item.node}
            gutterKind={row.gutterKind}
            gutterWidth={gutterWidth}
            dotX={row.dotX}
            segments={row.segments}
            exitLanes={row.exitLanes}
            hasBelow={row.hasBelow}
            workerByKey={workerByKey}
            openWorkerId={openWorkerId}
            client={ctx.client}
            onOpenWorker={ctx.onOpenWorker}
          />
        );
      })}
    </div>
  );
}

/**
 * 一张任务图的果皮轨主体：先按弱连通分量拆成互不相连的子图（与放大全览弹窗的真实依赖一致），
 * 每个子图内部再按拓扑层排布；子图之间留一点呼吸间距，绝不画跨子图的竖向连线。
 */
function PeelTrackBody({
  graph,
  colorKey,
  workerByKey,
  openWorkerId,
  client,
  onOpenWorker,
}: {
  graph: TaskGraph;
  colorKey: number;
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  client: HubClient;
  onOpenWorker: (id: ConversationId) => void;
}) {
  const components = useMemo(() => computeTrackComponents(graph), [graph]);
  const ctx: PeelRowContext = { graphId: graph.id, workerByKey, openWorkerId, client, onOpenWorker };

  return (
    <div style={fruitTrackVars(colorKey)} className="space-y-1.5 pt-0.5 pb-1">
      {components.map((component) => (
        <PeelComponentTrack key={component.key} component={component} ctx={ctx} />
      ))}
    </div>
  );
}

/**
 * 单个项目的活跃任务流图列表（PeelTrackList）：
 * - waiting_user / attention 紧急任务排在最前并默认展开；
 * - 其余后台进行中任务在多任务并存时默认收成带 SliceWheelIcon 的单行标题，点击手风琴式展开/收起；
 * - 每个任务头右上角配 Zoom（Maximize2）按钮打开横向全览弹窗。
 */
export const PeelTrackList = memo(function PeelTrackList({
  graphs,
  workers,
  openWorkerId,
  colorKey = 0,
  onOpenWorker,
  onZoomGraph,
}: {
  graphs: readonly TaskGraph[];
  workers: readonly WorkerEntry[];
  openWorkerId: ConversationId | null;
  colorKey?: number;
  onOpenWorker: (id: ConversationId) => void;
  onZoomGraph: (graph: TaskGraph) => void;
}) {
  // 拍板走当前区域那台设备的接口（device-scope.tsx）：App 用 DeviceScope 包着当前设备的 hub.client，跨设备看远端项目经理时就是那台的
  const client = useClient();
  const sorted = useMemo(() => sortActiveGraphs(graphs), [graphs]);

  const workerByKey = useMemo(() => workersByWorkerId(workers), [workers]);

  const computeInitialOpen = (list: readonly TaskGraph[]): ReadonlySet<TaskGraphId> => {
    const urgent = list.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id);
    if (urgent.length > 0) return new Set(urgent);
    return list[0] ? new Set([list[0].id]) : new Set();
  };

  const [openIds, setOpenIds] = useState<ReadonlySet<TaskGraphId>>(() => computeInitialOpen(sorted));
  const seenIdsRef = useRef<Set<TaskGraphId>>(new Set(sorted.map((g) => g.id)));
  const prevUrgentRef = useRef<ReadonlySet<TaskGraphId>>(
    new Set(sorted.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id)),
  );

  useEffect(() => {
    const nowUrgent = new Set(sorted.filter((g) => taskGraphPriority(g) < 2).map((g) => g.id));
    const newlyUrgent: TaskGraphId[] = [];
    for (const id of nowUrgent) {
      if (!prevUrgentRef.current.has(id)) newlyUrgent.push(id);
    }
    prevUrgentRef.current = nowUrgent;
    const brandNew = sorted.filter((g) => !seenIdsRef.current.has(g.id)).map((g) => g.id);
    for (const g of sorted) seenIdsRef.current.add(g.id);

    setOpenIds((prev) => {
      const validIds = new Set(sorted.map((g) => g.id));
      const kept = new Set([...prev].filter((id) => validIds.has(id)));
      for (const id of newlyUrgent) kept.add(id);
      if (kept.size === 0 && brandNew.length > 0 && sorted[0] !== undefined) {
        kept.add(sorted[0].id);
      }
      return kept;
    });
  }, [sorted]);

  const toggleGraph = (id: TaskGraphId) => {
    setOpenIds((prev) => {
      if (prev.has(id)) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      // 手风琴切换：展开所选任务图并收起其他后台任务
      return new Set([id]);
    });
  };

  return (
    <div className="space-y-1">
      {sorted.map((graph) => {
        const open = openIds.has(graph.id);
        return (
          <div key={graph.id} data-graph-id={graph.id}>
            <div className="-mx-2.5 flex items-center gap-1 px-2.5">
              <button
                type="button"
                data-testid="peel-graph-toggle"
                aria-expanded={open}
                onClick={() => toggleGraph(graph.id)}
                className="flex min-h-9 pointer-coarse:min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl py-1.5 pr-1 text-left transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <SliceWheelIcon graph={graph} colorKey={colorKey} size={20} />
                <span className={cn("min-w-0 flex-1 truncate text-body", open && "font-semibold")}>
                  {graph.title}
                </span>
                {isTaskGraphReadyToFinish(graph) && (
                  <span className="shrink-0 text-xs text-muted-foreground">Ready to finish</span>
                )}
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                    open && "rotate-90",
                  )}
                  aria-hidden="true"
                />
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom"
                onClick={() => onZoomGraph(graph)}
                className="-mr-1.5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Maximize2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            {open && (
              <PeelTrackBody
                graph={graph}
                colorKey={colorKey}
                workerByKey={workerByKey}
                openWorkerId={openWorkerId}
                client={client}
                onOpenWorker={onOpenWorker}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});
