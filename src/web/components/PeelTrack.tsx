import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Loader2, Maximize2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationId, DeviceId, TaskGraph, TaskGraphId, TaskNode, WorkerId } from "../../shared/index.ts";
import { createClient, type HubClient } from "../client.ts";
import { useClient } from "../device-scope.tsx";
import { cleanPieceTitle, errorLine, errorText, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { sortActiveGraphs, taskGraphPriority, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { KnifeAvatar } from "./KnifeAvatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { computeGraphLayers, fruitTrackVars, SliceWheelIcon } from "./SliceWheelIcon.tsx";

type GutterKind = "station" | "parA" | "parMid" | "parB" | "coil" | "gate";
type LineStyle = "solid" | "dash" | "none";
type DotTone = "done" | "run" | "ready" | "warn" | "blocked";

const GUTTER_H = 32;
const GUTTER_CY = GUTTER_H / 2;
const LANE_MAIN_X = 11;
const LANE_PAR_X = 29;

const COIL_PATH_D = (() => {
  const pts: string[] = [];
  const turns = 1.6;
  const r0 = 7.6;
  const cyc = GUTTER_CY + 2;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const r = r0 - 5.8 * t;
    const a = Math.PI + t * turns * 2 * Math.PI;
    const x = Number((LANE_MAIN_X + r0 + r * Math.cos(a)).toFixed(2));
    const y = Number((cyc + r * Math.sin(a)).toFixed(2));
    pts.push(`${x} ${y}`);
  }
  return `M${LANE_MAIN_X} ${GUTTER_H}V${cyc}L${pts.join("L")}`;
})();

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
  tone = "done",
  inn = "solid",
  out = "solid",
  thru = inn,
}: {
  kind: GutterKind;
  tone?: DotTone;
  inn?: LineStyle;
  out?: LineStyle;
  thru?: LineStyle;
}) {
  return (
    <svg
      data-peel-gutter={kind}
      viewBox={`0 0 40 ${GUTTER_H}`}
      aria-hidden="true"
      className="block h-8 w-10 shrink-0 select-none"
    >
      {kind === "station" && (
        <>
          <TrackPath style={inn} d={`M${LANE_MAIN_X} 0V${GUTTER_CY}`} />
          <TrackPath style={out} d={`M${LANE_MAIN_X} ${GUTTER_CY}V${GUTTER_H}`} />
          <TrackDot x={LANE_MAIN_X} tone={tone} />
        </>
      )}
      {kind === "parA" && (
        <>
          <TrackPath style={inn} d={`M${LANE_MAIN_X} 0V${GUTTER_CY}`} />
          <TrackPath style={out} d={`M${LANE_MAIN_X} ${GUTTER_CY}V${GUTTER_H}`} />
          <TrackPath style={inn} d={`M${LANE_MAIN_X} 0C${LANE_MAIN_X} 15 ${LANE_PAR_X} 13 ${LANE_PAR_X} ${GUTTER_H}`} />
          <TrackDot x={LANE_MAIN_X} tone={tone} />
        </>
      )}
      {kind === "parMid" && (
        <>
          <TrackPath style={thru} d={`M${LANE_MAIN_X} 0V${GUTTER_H}`} />
          <TrackPath style={inn} d={`M${LANE_PAR_X} 0V${GUTTER_CY}`} />
          <TrackPath style={out} d={`M${LANE_PAR_X} ${GUTTER_CY}V${GUTTER_H}`} />
          <TrackDot x={LANE_PAR_X} tone={tone} />
        </>
      )}
      {kind === "parB" && (
        <>
          <TrackPath style={thru} d={`M${LANE_MAIN_X} 0V${GUTTER_H}`} />
          <TrackPath style={inn} d={`M${LANE_PAR_X} 0V${GUTTER_CY}`} />
          <TrackPath style={out} d={`M${LANE_PAR_X} ${GUTTER_CY}C${LANE_PAR_X} 30 ${LANE_MAIN_X} 22 ${LANE_MAIN_X} ${GUTTER_H}`} />
          <TrackDot x={LANE_PAR_X} tone={tone} />
        </>
      )}
      {kind === "coil" && (
        <path
          d={COIL_PATH_D}
          fill="none"
          stroke="var(--peel)"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {kind === "gate" && (
        <>
          <TrackPath style={inn} d={`M${LANE_MAIN_X} 0V${GUTTER_CY - 9}`} />
          <TrackPath style={out} d={`M${LANE_MAIN_X} ${GUTTER_CY + 11}V${GUTTER_H}`} />
        </>
      )}
    </svg>
  );
}

function isLayerCompleted(layer: readonly TaskNode[]): boolean {
  return layer.length > 0 && layer.every((n) => n.status === "done" || n.status === "skipped");
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

export function useResolvedClient(deviceId?: DeviceId | null): HubClient {
  const scopeClient = useClient();
  return useMemo(
    () => (deviceId !== undefined ? createClient(deviceId) : scopeClient),
    [deviceId, scopeClient],
  );
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
  inn,
  out,
  thru,
  hasBelow,
  workerByKey,
  openWorkerId,
  client,
  onOpenWorker,
}: {
  graphId: TaskGraphId;
  node: TaskNode;
  gutterKind: GutterKind;
  inn: LineStyle;
  out: LineStyle;
  thru: LineStyle;
  hasBelow: boolean;
  workerByKey: ReadonlyMap<WorkerId, WorkerEntry>;
  openWorkerId: ConversationId | null;
  client: HubClient;
  onOpenWorker: (id: ConversationId) => void;
}) {
  if (node.kind === "gate" && node.status === "waiting_user") {
    return (
      <div className="relative flex items-start">
        {hasBelow && (
          <span
            aria-hidden="true"
            style={{ left: "0.6875rem" }}
            className="pointer-events-none absolute top-8 bottom-0 border-l border-dashed border-line"
          />
        )}
        <div className="relative flex h-8 w-10 shrink-0 items-center">
          <PeelGutter kind="gate" inn={inn} out="none" />
          <KnifeAvatar size={30} className="pointer-events-none absolute -left-1 top-0" />
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
      <PeelGutter kind={gutterKind} tone={dotToneOf(node)} inn={inn} out={out} thru={thru} />
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
    <div title={node.title} className="flex min-h-8 pointer-coarse:min-h-11 items-center">
      {content}
    </div>
  );
}

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
  const layers = useMemo(() => computeGraphLayers(graph), [graph]);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [nextExpanded, setNextExpanded] = useState(false);

  // 计算连续已完成的上游层数（至少保留最后一层不折叠，且折叠节点数 >= 2 才卷成果皮卷）
  let prefixEnd = 0;
  while (prefixEnd < layers.length - 1 && isLayerCompleted(layers[prefixEnd]!)) {
    prefixEnd++;
  }
  // 若已完成前缀最末一层是刚拍板通过的 gate（带 decision），留在当前前沿上方展示所选简称（见 06-peel-track-states“拍板之后”）
  if (prefixEnd > 0 && layers[prefixEnd - 1]!.some((n) => n.kind === "gate" && n.decision !== null)) {
    prefixEnd--;
  }
  const prefixLayers = layers.slice(0, prefixEnd);
  const prefixDoneCount = prefixLayers.reduce((sum, l) => sum + l.length, 0);
  const openInPrefix =
    openWorkerId !== null &&
    prefixLayers.some((layer) =>
      layer.some((n) => resolveBoundWorker(n, workerByKey).worker?.conversationId === openWorkerId),
    );
  useEffect(() => {
    if (openInPrefix) setDoneExpanded(true);
  }, [openInPrefix]);

  const foldDone = prefixDoneCount >= 2 && !doneExpanded;
  const visibleStart = foldDone ? prefixEnd : 0;

  // 计算尾部连续未解锁（pending）的下游层数（>= 2 层且前面有已开始/已完成层时折叠为 N next）
  let suffixStart = layers.length;
  while (
    suffixStart - 1 > visibleStart &&
    suffixStart - 1 > 0 &&
    layers[suffixStart - 1]!.every((n) => n.status === "pending")
  ) {
    suffixStart--;
  }
  const suffixLayers = layers.slice(suffixStart);
  const suffixLayerCount = suffixLayers.length;
  const suffixNodeCount = suffixLayers.reduce((sum, l) => sum + l.length, 0);
  const foldNext = suffixLayerCount >= 2 && suffixNodeCount >= 2 && !nextExpanded;
  const visibleEnd = foldNext ? suffixStart : layers.length;

  const shownLayers = layers.slice(visibleStart, visibleEnd);

  return (
    <div style={fruitTrackVars(colorKey)} className="pt-0.5 pb-1">
      {foldDone && (
        <button
          type="button"
          onClick={() => setDoneExpanded(true)}
          className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <PeelGutter kind="coil" out="solid" />
          <span>{prefixDoneCount} done</span>
        </button>
      )}
      {shownLayers.map((layer, idx) => {
        const globalIdx = visibleStart + idx;
        const prevCompleted = globalIdx === 0 ? false : isLayerCompleted(layers[globalIdx - 1]!);
        const currCompleted = isLayerCompleted(layer);
        const hasBelow = globalIdx < layers.length - 1;
        const inn: LineStyle = globalIdx === 0 && !foldDone ? "none" : prevCompleted ? "solid" : "dash";
        const out: LineStyle = !hasBelow ? "none" : currCompleted ? "solid" : "dash";

        if (layer.length === 1) {
          const node = layer[0]!;
          return (
            <PeelStageRow
              key={node.key}
              graphId={graph.id}
              node={node}
              gutterKind="station"
              inn={inn}
              out={out}
              thru={inn}
              hasBelow={hasBelow}
              workerByKey={workerByKey}
              openWorkerId={openWorkerId}
              client={client}
              onOpenWorker={onOpenWorker}
            />
          );
        }

        return layer.map((node, pIdx) => {
          const isFirst = pIdx === 0;
          const isLast = pIdx === layer.length - 1;
          const gutterKind: GutterKind = isFirst ? "parA" : isLast ? "parB" : "parMid";
          const nodeDone = node.status === "done" || node.status === "skipped";
          const branchOut: LineStyle = nodeDone && currCompleted ? "solid" : "dash";
          return (
            <PeelStageRow
              key={node.key}
              graphId={graph.id}
              node={node}
              gutterKind={gutterKind}
              inn={inn}
              out={isFirst ? (hasBelow ? out : "dash") : branchOut}
              thru={hasBelow ? out : "none"}
              hasBelow={hasBelow || !isLast}
              workerByKey={workerByKey}
              openWorkerId={openWorkerId}
              client={client}
              onOpenWorker={onOpenWorker}
            />
          );
        });
      })}
      {foldNext && (
        <button
          type="button"
          onClick={() => setNextExpanded(true)}
          className="-mx-2.5 flex min-h-8 pointer-coarse:min-h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center rounded-xl px-2.5 text-left text-minor text-muted-foreground transition-colors outline-none hover:bg-jelly-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <PeelGutter
            kind="station"
            tone="blocked"
            inn={visibleEnd > 0 && isLayerCompleted(layers[visibleEnd - 1]!) ? "solid" : "dash"}
            out="none"
          />
          <span>{suffixNodeCount} next</span>
        </button>
      )}
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
  deviceId,
  onOpenWorker,
  onZoomGraph,
}: {
  graphs: readonly TaskGraph[];
  workers: readonly WorkerEntry[];
  openWorkerId: ConversationId | null;
  colorKey?: number;
  deviceId?: DeviceId | null;
  onOpenWorker: (id: ConversationId) => void;
  onZoomGraph: (graph: TaskGraph) => void;
}) {
  const client = useResolvedClient(deviceId);
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
