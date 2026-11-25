import { memo, useMemo, useState } from "react";
import type * as React from "react";
import type { TaskNodeKey } from "../../shared/index.ts";
import { horizontalLayoutOf, verticalRowsOf, type FlowStep, type GraphFlow, type VerticalRow } from "../graph-flow.ts";
import { cn } from "../lib/utils.ts";
import { WORK_GRAPH_PX } from "../limits.ts";
import { useGraphOrientation, useStepTextMeasure } from "../useGraphOrientation.ts";
import type { WorkStatus } from "../work-status.ts";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export interface GraphCanvasProps {
  flow: GraphFlow;
  /** auto: horizontal when it fits the paper, vertical otherwise; horizontal: always wide; vertical: always the list. */
  orientation: "auto" | "horizontal" | "vertical";
  /** The canvas sits on warm paper (Active / dialog) or directly on the panel (Completed expansion). */
  paper: boolean;
  onOpenStep?: (key: TaskNodeKey) => void;
  /** When set, only steps returning true render as clickable buttons. */
  stepInteractive?: (key: TaskNodeKey) => boolean;
}

const STATUS_ACCESSIBLE_LABEL: Readonly<Record<WorkStatus, string>> = {
  done: "done",
  running: "running",
  waiting: "waiting on you",
  pending: "not started",
  cancelled: "cancelled",
};

function stepAccessibleName(step: FlowStep): string {
  return `${step.title}, ${STATUS_ACCESSIBLE_LABEL[step.status]}`;
}

function HorizontalGraph({
  flow,
  layout,
  onOpenStep,
  stepInteractive,
}: {
  flow: GraphFlow;
  layout: ReturnType<typeof horizontalLayoutOf>;
  onOpenStep?: (key: TaskNodeKey) => void;
  stepInteractive?: (key: TaskNodeKey) => boolean;
}) {
  const parallelKeys = useMemo(() => {
    const set = new Set<TaskNodeKey>();
    for (const layer of flow.layers) {
      if (layer.length > 1) {
        for (const step of layer) set.add(step.key);
      }
    }
    return set;
  }, [flow]);

  return (
    <div
      data-orientation="horizontal"
      className="relative"
      style={{ width: layout.width, height: layout.height }}
    >
      <svg
        aria-hidden="true"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="pointer-events-none absolute inset-0"
      >
        {layout.links.map((link, index) => (
          <path
            key={index}
            d={link.d}
            fill="none"
            stroke="#d8d0c6"
            strokeWidth={WORK_GRAPH_PX.stroke}
            data-link-shape={link.shape}
          />
        ))}
      </svg>
      {layout.steps.map((step) => {
        const clickable = onOpenStep !== undefined && (stepInteractive === undefined || stepInteractive(step.key));
        const style: React.CSSProperties = {
          left: step.x,
          top: step.y,
          width: step.width,
          height: WORK_GRAPH_PX.node,
        };
        const content = (
          <>
            <WorkStatusIcon status={step.status} />
            <span className="min-w-0 truncate" title={step.title}>
              {step.title}
            </span>
          </>
        );
        if (clickable) {
          return (
            <button
              key={step.key}
              type="button"
              data-step-key={step.key}
              data-status={step.status}
              aria-label={stepAccessibleName(step)}
              title={step.title}
              style={style}
              onClick={() => onOpenStep(step.key)}
              className={cn("work-step-box work-step-box-interactive", !parallelKeys.has(step.key) && "touch-target")}
            >
              {content}
            </button>
          );
        }
        return (
          <div
            key={step.key}
            data-step-key={step.key}
            data-status={step.status}
            title={step.title}
            style={style}
            className="work-step-box"
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

function VerticalStepRow({
  row,
  paper,
  onOpenStep,
  stepInteractive,
}: {
  row: VerticalRow;
  paper: boolean;
  onOpenStep?: (key: TaskNodeKey) => void;
  stepInteractive?: (key: TaskNodeKey) => boolean;
}) {
  const clickable = onOpenStep !== undefined && (stepInteractive === undefined || stepInteractive(row.key));
  const railColor = paper ? "#d8d0c6" : "#ddd6cc";
  const body = (
    <>
      {row.railAbove && (
        <span aria-hidden="true" className="work-vrail-seg work-vrail-top" style={{ backgroundColor: railColor }} />
      )}
      {row.railBelow && (
        <span aria-hidden="true" className="work-vrail-seg work-vrail-bottom" style={{ backgroundColor: railColor }} />
      )}
      {row.depth === 1 && (
        <svg aria-hidden="true" width="18" height="26" viewBox="0 0 18 26" className="work-velbow">
          <path d="M7 0 V6 C7 13 11.5 13 18 13" fill="none" stroke={railColor} strokeWidth={WORK_GRAPH_PX.stroke} />
        </svg>
      )}
      <WorkStatusIcon status={row.status} className={paper ? "work-vicon-paper" : "work-vicon-plain"} />
      <span className="min-w-0 truncate" title={row.title}>
        {row.title}
      </span>
    </>
  );

  const rowClass = cn(
    "work-vrow min-h-6.5 pointer-coarse:min-h-11",
    row.depth === 1 && "work-vrow-parallel",
    clickable && (paper ? "work-vrow-interactive-paper" : "work-vrow-interactive-plain"),
  );

  if (clickable) {
    return (
      <button
        type="button"
        data-step-key={row.key}
        data-status={row.status}
        data-depth={row.depth}
        data-rail-below={row.railBelow ? "true" : undefined}
        aria-label={stepAccessibleName(row)}
        title={row.title}
        onClick={() => onOpenStep(row.key)}
        className={rowClass}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      data-step-key={row.key}
      data-status={row.status}
      data-depth={row.depth}
      data-rail-below={row.railBelow ? "true" : undefined}
      title={row.title}
      className={rowClass}
    >
      {body}
    </div>
  );
}

export const GraphCanvas = memo(function GraphCanvas({
  flow,
  orientation,
  paper,
  onOpenStep,
  stepInteractive,
}: GraphCanvasProps): React.ReactElement {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const measure = useStepTextMeasure(box);
  const horizontal = useMemo(
    () => (orientation !== "vertical" ? horizontalLayoutOf(flow, measure) : null),
    [flow, measure, orientation],
  );
  const autoOrientation = useGraphOrientation(orientation === "auto" ? box : null, horizontal?.width ?? 0);
  const resolved = orientation === "vertical" ? "vertical" : orientation === "horizontal" ? "horizontal" : autoOrientation;
  const rows = useMemo(() => (resolved === "vertical" ? verticalRowsOf(flow) : null), [flow, resolved]);

  return (
    <div
      ref={setBox}
      data-graph-canvas
      data-orientation={resolved}
      className={cn(paper ? "work-graph-paper" : "min-w-0", orientation === "horizontal" && "w-fit min-w-full", "text-minor")}
    >
      {resolved === "horizontal" && horizontal !== null ? (
        <HorizontalGraph flow={flow} layout={horizontal} onOpenStep={onOpenStep} stepInteractive={stepInteractive} />
      ) : (
        <div data-orientation="vertical" className={cn("work-vlist", paper ? "work-vlist-paper" : "work-vlist-plain")}>
          {(rows ?? []).map((row) => (
            <VerticalStepRow
              key={row.key}
              row={row}
              paper={paper}
              onOpenStep={onOpenStep}
              stepInteractive={stepInteractive}
            />
          ))}
        </div>
      )}
    </div>
  );
});
