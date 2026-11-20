import type { TaskGraph, TaskNode } from "../shared/index.ts";
import { pixelArtPaths, type JellyColor, type SlimePath } from "../shared/slimes.ts";
import { computeGraphComponents, computeGraphLayers } from "./task-graph-layout.ts";

export const TASK_PROGRESS_GRID = 10;

type LeafState = "done" | "running" | "user" | "pm" | "bud";

const STEM = "#7a8a5a";
const STEM_DASHED = "#c9d1bd";
const SOIL = "#c9b28a";
const BUD = "#e4e8dc";
const CAUTION = "#dba10b";
const LEAF_CHAR: Readonly<Record<LeafState, string>> = { done: "D", running: "R", user: "U", pm: "P", bud: "B" };
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
  const rowOf = (i: number) => 8 - Math.max(1, Math.round(((i + 1) * 7) / n));
  const reached = layers.findLastIndex((states) => states.some((s) => s !== "bud"));
  const solidFrom = reached < 0 ? TASK_PROGRESS_GRID - 1 : rowOf(reached);
  for (let y = 1; y < 9; y++) grid[y]![4] = y >= solidFrom ? "t" : y % 2 === 1 ? "d" : ".";
  const leaves = Array.from({ length: TASK_PROGRESS_GRID }, (): { left: LeafState[]; right: LeafState[] } => ({ left: [], right: [] }));
  layers.forEach((states, i) => {
    const { left, right } = leaves[rowOf(i)]!;
    if (states.length === 1) {
      (i % 2 === 0 ? left : right).push(states[0]!);
    } else {
      const split = Math.ceil(states.length / 2);
      left.push(merge(states.slice(0, split)));
      right.push(merge(states.slice(split)));
    }
  });
  leaves.forEach(({ left, right }, y) => {
    for (const [dir, states] of [[-1, left], [1, right]] as const) {
      if (states.length === 0) continue;
      const state = merge(states);
      const ch = LEAF_CHAR[state];
      grid[y]![4 + dir] = ch;
      if (state === "bud") continue;
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
