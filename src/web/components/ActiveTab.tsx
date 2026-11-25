import { memo, useCallback, useMemo } from "react";
import type * as React from "react";
import type { ConversationId, Message, MessageId, TaskGraph, TaskNodeKey } from "../../shared/index.ts";
import { cleanPieceTitle } from "../format.ts";
import { graphFlowOf } from "../graph-flow.ts";
import type { WorkerEntry } from "../selectors.ts";
import { ChevronRight, Maximize2 } from "../ui/icons.ts";
import { stepTargetOf, type ActiveWork } from "../work-panel-model.ts";
import { graphProgressOf, workerWorkStatusOf, type WorkStatus } from "../work-status.ts";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export interface ActiveTabProps {
  work: ActiveWork;
  /** Every Worker of the PM, so steps can resolve their bound Worker. */
  workers: readonly WorkerEntry[];
  /** Pending asks of the PM, so blocker/gate steps without gateAskMessageId can locate their chat card. */
  asks?: readonly Message[];
  onOpenWorker: (id: ConversationId) => void;
  onOpenAsk: (id: MessageId) => void;
  /** The expand icon on a graph section. */
  onExpandGraph: (graph: TaskGraph) => void;
}

const WORKER_STATUS_LABEL: Readonly<Record<WorkStatus, string>> = {
  done: "done",
  running: "running",
  waiting: "waiting on you",
  pending: "not started",
  cancelled: "cancelled",
};

const GraphSection = memo(function GraphSection({
  graph,
  workers,
  asks,
  onOpenWorker,
  onOpenAsk,
  onExpandGraph,
}: {
  graph: TaskGraph;
  workers: readonly WorkerEntry[];
  asks?: readonly Message[];
  onOpenWorker: (id: ConversationId) => void;
  onOpenAsk: (id: MessageId) => void;
  onExpandGraph: (graph: TaskGraph) => void;
}) {
  const flow = useMemo(() => graphFlowOf(graph), [graph]);
  const progress = useMemo(() => graphProgressOf(graph), [graph]);
  const targetByKey = useMemo(() => {
    const map = new Map<TaskNodeKey, ReturnType<typeof stepTargetOf>>();
    for (const node of graph.nodes) map.set(node.key, stepTargetOf(node, workers, asks, graph.id));
    return map;
  }, [graph.id, graph.nodes, workers, asks]);

  const stepInteractive = useCallback((key: TaskNodeKey) => {
    const target = targetByKey.get(key);
    return target !== undefined && target.kind !== "none";
  }, [targetByKey]);

  const handleOpenStep = useCallback(
    (key: TaskNodeKey) => {
      const target = targetByKey.get(key);
      if (target === undefined || target.kind === "none") return;
      if (target.kind === "worker") onOpenWorker(target.conversationId);
      else onOpenAsk(target.messageId);
    },
    [targetByKey, onOpenWorker, onOpenAsk],
  );

  return (
    <section aria-label={graph.title} className="work-panel-section">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="work-graph-title min-w-0 truncate text-minor font-medium" title={graph.title}>
          {graph.title}
        </h2>
        <div className="work-graph-meta flex shrink-0 items-center gap-2.5 text-xs tabular-nums">
          <span>
            {progress.done}/{progress.total}
          </span>
          <button
            type="button"
            aria-label={`Expand ${graph.title}`}
            title={`Expand ${graph.title}`}
            onClick={() => onExpandGraph(graph)}
            className="work-expand-btn touch-target"
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <GraphCanvas flow={flow} orientation="auto" paper onOpenStep={handleOpenStep} stepInteractive={stepInteractive} />
    </section>
  );
});

export const ActiveTab = memo(function ActiveTab({
  work,
  workers,
  asks,
  onOpenWorker,
  onOpenAsk,
  onExpandGraph,
}: ActiveTabProps): React.ReactElement {
  if (work.graphs.length === 0 && work.workers.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 py-8 text-minor work-panel-muted">
        Nothing running
      </div>
    );
  }

  return (
    <div className="right-rail-scroll work-panel-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [contain:layout_style]">
      {work.graphs.map((graph) => (
        <GraphSection
          key={graph.id}
          graph={graph}
          workers={workers}
          {...(asks !== undefined ? { asks } : {})}
          onOpenWorker={onOpenWorker}
          onOpenAsk={onOpenAsk}
          onExpandGraph={onExpandGraph}
        />
      ))}
      {work.workers.length > 0 && (
        <section aria-label="Workers" className="work-panel-section work-panel-section-workers">
          <div className="work-section-heading mb-2 flex items-center justify-between text-xs font-medium">
            <span>Workers</span>
            <span className="tabular-nums">{work.workers.length}</span>
          </div>
          <ul>
            {work.workers.map((worker) => {
              const title = cleanPieceTitle(worker.title);
              const status = workerWorkStatusOf(worker);
              return (
                <li key={worker.conversationId}>
                  <button
                    type="button"
                    aria-label={`${title}, ${WORKER_STATUS_LABEL[status]}`}
                    title={worker.title}
                    onClick={() => onOpenWorker(worker.conversationId)}
                    className="work-worker-row h-6.5 pointer-coarse:min-h-11"
                  >
                    <WorkStatusIcon status={status} />
                    <span className="min-w-0 flex-1 truncate text-left text-minor font-medium" title={worker.title}>
                      {title}
                    </span>
                    <ChevronRight className="work-row-chevron size-3.5 shrink-0" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
});
