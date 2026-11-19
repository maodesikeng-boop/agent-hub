import type { TaskGraph, TaskNode } from "../shared/index.ts";
import { pixelArtPaths, type JellyColor, type SlimePath } from "../shared/slimes.ts";
import { computeGraphComponents, computeGraphLayers } from "./task-graph-layout.ts";

/** 进度图标的边长（格）。 */
export const TASK_PROGRESS_GRID = 10;

type LeafState = "done" | "running" | "user" | "pm" | "bud";

// 茎、虚线茎、土和没长出来的芽：和项目经理颜色无关的像素稿颜色
const STEM = "#7a8a5a";
const STEM_DASHED = "#c9d1bd";
const SOIL = "#c9b28a";
const BUD = "#e4e8dc";
const CAUTION = "#dba10b";
/** 字符 → 状态，同一种状态的叶子并成一条路径。 */
const LEAF_CHAR: Readonly<Record<LeafState, string>> = { done: "D", running: "R", user: "U", pm: "P", bud: "B" };
/** 多个状态并到一片叶子上时谁优先：等你拍板 > 等项目经理 > 在干 > 做完 > 没长出来。 */
const PRIORITY: readonly LeafState[] = ["user", "pm", "running", "done", "bud"];

function leafStateOf(node: TaskNode): LeafState {
  if (node.status === "done") return node.skipped ? "bud" : "done";
  if (node.status === "running") return "running";
  if (node.status === "waiting") return node.waitingFor === "user" ? "user" : "pm";
  return "bud";
}

const merge = (states: readonly LeafState[]): LeafState => PRIORITY.find((s) => states.includes(s)) ?? "bud";

const mixWhite = (hex: string, t: number) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + 255 * t).toString(16).padStart(2, "0")).join("")}`;

const cache = new WeakMap<object, Map<string, readonly SlimePath[]>>();

/**
 * 前置：graph 至少有一步。
 * 后置：嫩芽生长的样子，一根茎、一节一层，叶子左右交替往上长；颜色看状态：做完（done）主色 blob，在干（running）主色掺 55% 白，
 * 等你拍板（waiting + user）强调色 accent，等项目经理（waiting + pm）琥珀色，没轮到和跳过只有茎上的一个小芽。
 * 同一连通子图同层并行的步骤长在同一节的左右两边（两边各取最要紧的状态）。节再多也画在同一个 10×10 格里，不越界；
 * 同一张图、同一种颜色每次返回同一个数组。
 */
export function taskProgressPaths(graph: Pick<TaskGraph, "nodes" | "edges">, color: JellyColor): readonly SlimePath[] {
  let byColor = cache.get(graph);
  if (byColor === undefined) {
    byColor = new Map();
    cache.set(graph, byColor);
  }
  const hit = byColor.get(color.id);
  if (hit !== undefined) return hit;

  const layers = computeGraphComponents(graph).flatMap((component) => computeGraphLayers(component).map((layer) => layer.map(leafStateOf)));
  const grid = Array.from({ length: TASK_PROGRESS_GRID }, () => Array<string>(TASK_PROGRESS_GRID).fill("."));
  for (let x = 2; x < 8; x++) grid[9]![x] = "g";
  const n = layers.length;
  // 第 i 节在第几行：从下（第 7 行）往上排到第 1 行，节多了几节挤在同一行
  const rowOf = (i: number) => 8 - Math.max(1, Math.round(((i + 1) * 7) / n));
  const reached = layers.findLastIndex((states) => states.some((s) => s !== "bud"));
  const solidFrom = rowOf(Math.max(0, reached));
  for (let y = 1; y < 9; y++) grid[y]![4] = y >= solidFrom ? "t" : y % 2 === 1 ? "d" : ".";
  layers.forEach((states, i) => {
    const y = rowOf(i);
    const sides: Array<["left" | "right", LeafState]> =
      states.length === 1
        ? [[i % 2 === 0 ? "left" : "right", states[0]!]]
        : [
            ["left", merge(states.slice(0, Math.ceil(states.length / 2)))],
            ["right", merge(states.slice(Math.ceil(states.length / 2)))],
          ];
    for (const [side, state] of sides) {
      const dir = side === "left" ? -1 : 1;
      const ch = LEAF_CHAR[state];
      if (state === "bud") {
        grid[y]![4 + dir] = ch;
        continue;
      }
      grid[y]![4 + dir] = ch;
      grid[y]![4 + 2 * dir] = ch;
      grid[y - 1]![4 + 2 * dir] = ch;
      grid[y - 1]![4 + 3 * dir] = ch;
    }
  });
  const paths = pixelArtPaths(
    grid.map((row) => row.join("")),
    {
      g: SOIL,
      t: STEM,
      d: STEM_DASHED,
      [LEAF_CHAR.bud]: BUD,
      [LEAF_CHAR.done]: color.blob,
      [LEAF_CHAR.running]: mixWhite(color.blob, 0.55),
      [LEAF_CHAR.pm]: CAUTION,
      [LEAF_CHAR.user]: color.accent,
    },
  );
  byColor.set(color.id, paths);
  return paths;
}
