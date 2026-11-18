import type { ReactNode } from "react";
import type { TaskGraph } from "../../shared/index.ts";
import type { JellyColorId } from "../../shared/slimes.ts";

/**
 * 右栏任务标题、放大全览左上的任务进度图标（docs/slime-cohesion-design.md）：按 taskProgressPaths 画的像素小图。
 * color 是所属项目经理现在的颜色；size 是标准档像素数，写成 rem。读屏不念（aria-hidden）。
 */
export function TaskProgressIcon({
  graph,
  color,
  size = 20,
  className,
}: {
  graph: Pick<TaskGraph, "nodes" | "edges">;
  color: JellyColorId;
  size?: number;
  className?: string;
}): ReactNode {
  throw new Error("未实现");
}
