import type { CompletedWorkItem, TaskEdge, TaskGraph, TaskNodeKey } from "../shared/index.ts";
import type { WorkStatus } from "./work-status.ts";

// Invariant: layout is a pure function of the graph shape, the step titles, and measured text widths, so the same inputs
// give the same layout object and the horizontal-or-vertical choice never depends on what is currently rendered.

export interface FlowStep {
  key: TaskNodeKey;
  title: string;
  status: WorkStatus;
}

export interface GraphFlow {
  /** Steps grouped by dependency depth, left to right; steps in one layer can run in parallel. */
  layers: readonly (readonly FlowStep[])[];
  edges: readonly TaskEdge[];
}

export interface PlacedStep extends FlowStep {
  x: number;
  y: number;
  width: number;
}

export interface FlowLink {
  /** SVG path in the canvas's px space: a straight segment between two single-step layers, a cubic curve otherwise. */
  d: string;
  shape: "line" | "curve";
}

export interface HorizontalLayout {
  /** Width the canvas needs, paper padding included. */
  width: number;
  height: number;
  steps: readonly PlacedStep[];
  links: readonly FlowLink[];
}

export interface VerticalRow extends FlowStep {
  /** 0 on the rail; 1 for a step that runs in parallel with others in its layer and branches off the rail. */
  depth: 0 | 1;
  /** The rail continues above and below this row's icon. */
  railAbove: boolean;
  railBelow: boolean;
}

export type GraphOrientation = "horizontal" | "vertical";

/** Width of one step label in px for the given emphasis (running and waiting steps use weight 500). */
export type MeasureStepText = (title: string, emphasis: boolean) => number;

/**
 * Postcondition: every node appears in exactly one layer, a step's layer is one past the deepest of its predecessors,
 * steps inside a layer keep sortOrder, and the same graph object returns the same GraphFlow.
 */
export function graphFlowOf(_graph: Pick<TaskGraph, "nodes" | "edges">): GraphFlow {
  throw new Error("Not implemented");
}

/**
 * Postcondition: as graphFlowOf for a finished graph; every step is "done" for a done graph, and steps of a cancelled
 * graph that never finished are "cancelled".
 */
export function completedFlowOf(_item: Extract<CompletedWorkItem, { kind: "graph" }>): GraphFlow {
  throw new Error("Not implemented");
}

/**
 * Precondition: measure returns non-negative widths.
 * Postcondition: steps are 26px boxes that hug their label; each layer is a column centered on the tallest column; a
 * straight 1.35px line joins two single-step layers and smooth curves fork into and join out of parallel layers, every
 * link meeting a box at its vertical center. width covers every box plus the paper padding.
 */
export function horizontalLayoutOf(_flow: GraphFlow, _measure: MeasureStepText): HorizontalLayout {
  throw new Error("Not implemented");
}

/**
 * Postcondition: one 26px row per step in layer order; single-step layers sit on the rail (depth 0) and steps of a
 * parallel layer are indented (depth 1); the rail runs from the first row's icon to the last row's icon.
 */
export function verticalRowsOf(_flow: GraphFlow): readonly VerticalRow[] {
  throw new Error("Not implemented");
}

/** Postcondition: "horizontal" exactly when requiredPx <= availablePx; "vertical" otherwise, including availablePx <= 0. */
export function orientationOf(_requiredPx: number, _availablePx: number): GraphOrientation {
  throw new Error("Not implemented");
}
