import { graphlib } from "@dagrejs/dagre";
import { memo, useMemo, type CSSProperties } from "react";
import type { TaskGraph, TaskNode } from "../../shared/index.ts";
import { paletteOf } from "../lib/palette.ts";
import { cn } from "../lib/utils.ts";

/** 果皮轨与切面轮共用的水果衍生色变量（统一从 paletteOf(colorKey) 派生，不散落硬编码色值）。 */
export function fruitTrackVars(colorKey: number): CSSProperties {
  const { blob, accent } = paletteOf(colorKey);
  return {
    "--peel": blob,
    "--pulp": `color-mix(in srgb, ${blob} 78%, var(--background))`,
    "--pulp-soft": `color-mix(in srgb, ${blob} 38%, var(--background))`,
    "--pulp-pale": `color-mix(in srgb, ${blob} 22%, var(--background))`,
    "--warn-pulp": "color-mix(in srgb, var(--caution) 40%, var(--background))",
    "--ghost": `color-mix(in srgb, ${accent} 5%, transparent)`,
    "--ghost-line": `color-mix(in srgb, ${accent} 24%, var(--border))`,
    "--cut": "var(--color-surface-chat)",
  } as CSSProperties;
}

type GraphShape = Pick<TaskGraph, "nodes" | "edges">;

const compareNodeOrder = (a: TaskNode, b: TaskNode) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);

/** 按正向最长拓扑路径将任务图节点划分为有序层级，同层按 sortOrder 与 key 稳定排序。 */
export function computeGraphLayers(graph: GraphShape): TaskNode[][] {
  if (graph.nodes.length === 0) return [];
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();

  for (const node of graph.nodes) {
    inDegree.set(node.key, 0);
    adj.set(node.key, []);
    rank.set(node.key, 0);
  }
  for (const edge of graph.edges) {
    if (edge.fromKey === edge.toKey || !inDegree.has(edge.fromKey) || !inDegree.has(edge.toKey)) continue;
    adj.get(edge.fromKey)!.push(edge.toKey);
    inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((inDegree.get(node.key) ?? 0) === 0) queue.push(node.key);
  }
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    const uRank = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      const nextRank = uRank + 1;
      if (nextRank > (rank.get(v) ?? 0)) rank.set(v, nextRank);
      const deg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, deg);
      if (deg === 0) queue.push(v);
    }
  }

  const byRank = new Map<number, TaskNode[]>();
  for (const node of graph.nodes) {
    const r = rank.get(node.key) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(node);
    else byRank.set(r, [node]);
  }

  return [...byRank.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, list]) => list.toSorted(compareNodeOrder));
}

/**
 * 按无向连通性（弱连通分量，@dagrejs/dagre 自带的 graphlib.alg.components，O(V + E)）把任务图拆成互不相连的子图，
 * 子图按各自最靠前节点的 sortOrder（再按 key）稳定排序；每个子图只带自己内部的边。
 * 互不依赖的独立事项不能被拍扁到同一组拓扑层里假装首尾相连。
 */
export function computeGraphComponents(graph: GraphShape): GraphShape[] {
  if (graph.nodes.length === 0) return [];
  const g = new graphlib.Graph();
  for (const node of graph.nodes) g.setNode(node.key);
  for (const edge of graph.edges) {
    if (edge.fromKey !== edge.toKey && g.hasNode(edge.fromKey) && g.hasNode(edge.toKey)) g.setEdge(edge.fromKey, edge.toKey);
  }
  const componentOf = new Map<string, number>();
  // dagre 自带类型里 graph-lib 是无扩展名相对导入，nodenext 下解析成 any，这里在边界处钉住返回类型
  const keyGroups: string[][] = graphlib.alg.components(g);
  keyGroups.forEach((keys, idx) => {
    for (const key of keys) componentOf.set(key, idx);
  });
  const groups = new Map<number, { first: TaskNode; nodes: TaskNode[]; edges: TaskGraph["edges"][number][] }>();
  for (const node of graph.nodes) {
    const idx = componentOf.get(node.key)!;
    const group = groups.get(idx);
    if (!group) groups.set(idx, { first: node, nodes: [node], edges: [] });
    else {
      group.nodes.push(node);
      if (compareNodeOrder(node, group.first) < 0) group.first = node;
    }
  }
  for (const edge of graph.edges) {
    const idx = componentOf.get(edge.fromKey);
    if (idx !== undefined && idx === componentOf.get(edge.toKey)) groups.get(idx)!.edges.push(edge);
  }
  return [...groups.values()]
    .toSorted((a, b) => compareNodeOrder(a.first, b.first))
    .map(({ nodes, edges }) => ({ nodes, edges }));
}

const round2 = (n: number) => Number(n.toFixed(2));

function polar(r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [round2(r * Math.cos(rad)), round2(r * Math.sin(rad))];
}

function sectorPath(r: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.9) return `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}Z`;
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M0 0L${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}Z`;
}

function arcPath(r: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.9) return `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}`;
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * 任务级小切面进度轮图标（docs/ui-standard.md 第 12.1 条）：
 * 按当前项目经理水果色，将多阶段任务切分成对应瓣数的横切面；同一连通子图同层相邻并行阶段刀口只切到果肉外半圈（果心相连）。
 * 尺寸以 rem 输出，跟随界面四档缩放。
 */
export const SliceWheelIcon = memo(function SliceWheelIcon({
  graph,
  colorKey = 0,
  size = 20,
  className,
}: {
  graph: GraphShape;
  colorKey?: number;
  size?: number;
  className?: string;
}) {
  // 先按连通子图分组再分层：只有同一子图同一并行层的相邻瓣才果心相连，不同子图之间刀口切到底
  const petals = useMemo(
    () =>
      computeGraphComponents(graph).flatMap((component, compIdx) =>
        computeGraphLayers(component).flatMap((layer, layerIdx) =>
          layer.map((node) => ({
            node,
            parallelGroup: layer.length > 1 ? `${compIdx}:${layerIdx}` : null,
          })),
        ),
      ),
    [graph],
  );

  const rem = `${size / 16}rem`;
  const R = size / 2;
  const peelW = Math.max(1.6, size * 0.06);
  const cutW = size >= 30 ? 1.8 : 1.4;
  const tiny = size < 18;
  const pop = tiny ? 0 : size * 0.08;
  const count = petals.length;
  const span = count > 0 ? 360 / count : 360;

  return (
    <span
      data-slot="slice-wheel"
      aria-hidden="true"
      style={{ width: rem, height: rem, ...fruitTrackVars(colorKey) }}
      className={cn("inline-flex shrink-0 select-none", className)}
    >
      <svg viewBox={`${-R} ${-R} ${size} ${size}`} className="size-full overflow-visible">
        {count === 0 ? (
          <>
            <circle r={R} fill="var(--ghost)" />
            <circle r={R - 0.6} fill="none" stroke="var(--ghost-line)" strokeWidth="1.2" />
          </>
        ) : (
          petals.map(({ node }, i) => {
            const a0 = i * span;
            const a1 = a0 + span;
            const mid = a0 + span / 2;
            const st = node.status;
            const isGhost = st === "pending" || st === "skipped";
            const isWait = st === "waiting_user";
            const isWarn = st === "attention";
            const isRun = st === "running" || st === "ready";
            const [dx, dy] = isWait && pop > 0 ? polar(pop, mid) : [0, 0];
            const peelFill = isWait ? "var(--primary)" : isWarn ? "var(--caution)" : "var(--peel)";
            const pulpFill = isRun
              ? "var(--pulp-soft)"
              : isWarn
                ? "var(--warn-pulp)"
                : isWait && tiny
                  ? "var(--primary)"
                  : "var(--pulp)";
            return (
              <g
                key={node.key}
                data-petal-status={st}
                transform={dx !== 0 || dy !== 0 ? `translate(${dx} ${dy})` : undefined}
              >
                {isGhost ? (
                  <>
                    <path d={sectorPath(R, a0, a1)} fill="var(--ghost)" />
                    <path d={arcPath(R - 0.6, a0, a1)} fill="none" stroke="var(--ghost-line)" strokeWidth="1.2" />
                  </>
                ) : (
                  <>
                    <path d={sectorPath(R, a0, a1)} fill={peelFill} />
                    <path d={sectorPath(R - peelW, a0, a1)} fill={pulpFill} />
                    {isRun && !tiny && (
                      <path d={sectorPath((R - peelW) * 0.6, a0, a1)} fill="var(--pulp)" />
                    )}
                  </>
                )}
              </g>
            );
          })
        )}
        {count > 1 &&
          petals.map((curr, i) => {
            const next = petals[(i + 1) % count]!;
            const angle = (i + 1) * span;
            const joined = curr.parallelGroup !== null && curr.parallelGroup === next.parallelGroup;
            const [xa, ya] = polar(joined ? R * 0.56 : 0, angle);
            const [xb, yb] = polar(R + 1, angle);
            return (
              <path
                key={`cut-${curr.node.key}`}
                data-cut-joined={joined ? "true" : undefined}
                d={`M${xa} ${ya}L${xb} ${yb}`}
                stroke="var(--cut)"
                strokeWidth={cutW}
                strokeLinecap={joined ? "round" : "butt"}
              />
            );
          })}
      </svg>
    </span>
  );
});
