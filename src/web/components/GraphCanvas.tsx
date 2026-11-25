import type * as React from "react";
import type { GraphFlow } from "../graph-flow.ts";
import type { TaskNodeKey } from "../../shared/index.ts";

export interface GraphCanvasProps {
  flow: GraphFlow;
  /** auto: horizontal when it fits the paper, vertical otherwise; vertical: always the list (Completed rows). */
  orientation: "auto" | "vertical";
  /** The canvas sits on warm paper (Active) or directly on the panel (Completed expansion). */
  paper: boolean;
  onOpenStep?: (key: TaskNodeKey) => void;
}

/**
 * Postcondition: draws the flow horizontally (26px hugging boxes, 1.35px lines and curves) when orientation is auto and
 * horizontalLayoutOf(flow).width fits the paper's content box, and as the vertical list (one 26px row per step on a thin
 * rail, parallel steps indented) otherwise. A step with onOpenStep is a button named by its title and status.
 */
export function GraphCanvas(_props: GraphCanvasProps): React.ReactElement {
  throw new Error("Not implemented");
}
