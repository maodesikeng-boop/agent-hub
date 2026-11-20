import { memo } from "react";
import type { TaskGraph } from "../../shared/index.ts";
import { jellyColorOf, type JellyColorId } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { TASK_PROGRESS_GRID, taskProgressPaths } from "../task-progress.ts";
import { PixelPaths } from "./Avatar.tsx";

export const TaskProgressIcon = memo(function TaskProgressIcon({
  graph,
  color,
  size = 20,
  className,
}: {
  graph: Pick<TaskGraph, "nodes" | "edges">;
  color: JellyColorId;
  size?: number;
  className?: string;
}) {
  const rem = `${size / 16}rem`;
  return (
    <svg
      data-slot="task-progress"
      aria-hidden="true"
      viewBox={`0 0 ${TASK_PROGRESS_GRID} ${TASK_PROGRESS_GRID}`}
      shapeRendering="crispEdges"
      style={{ width: rem, height: rem }}
      className={cn("shrink-0 select-none", className)}
    >
      {graph.nodes.length > 0 && <PixelPaths paths={taskProgressPaths(graph, jellyColorOf(color))} />}
    </svg>
  );
});
