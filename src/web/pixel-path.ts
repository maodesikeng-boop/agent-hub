// 任务图的像素画法（docs/slime-cohesion-design.md）：右栏果皮轨的轨道和状态点、放大全览的连线和箭头，都画在同一套格子上，
// 和 12×12 的史莱姆、24 格的像素图标一个画法。
// 不变量：输入坐标先对齐到 cell 的整数倍；输出是一条 SVG path 的 d，只有横竖边（M/h/v/z 画出的小方块和长条），
// 没有圆、斜线和贝塞尔；同样的输入每次得到同一个字符串。调用方用 fill 上色，<svg> 上写 shape-rendering="crispEdges"。

export interface PixelPoint {
  x: number;
  y: number;
}

/** solid 是一格宽的实线；dotted 是一格见方的点，点和点之间空一格（点阵轨）。 */
export type PixelLineStyle = "solid" | "dotted";

/** 步骤状态的像素小图标（5×5 格）。等你拍板不在这里，用 GateMark。 */
export type StepGlyph = "done" | "running" | "waitingPm" | "pending" | "doneCoil" | "nextCoil";

/**
 * 果皮轨里一段竖直的轨道。
 * 前置：cell > 0，y1 <= y2。
 * 后置：中心线在 x，宽一格，从 y1 到 y2；y1 等于 y2 时返回空字符串。
 */
export function pixelRailPath(x: number, y1: number, y2: number, style: PixelLineStyle, cell: number): string {
  throw new Error("未实现");
}

/**
 * 一条正交折线画成一格宽的像素线：每个拐角削成一格台阶。
 * 前置：points 至少两个点，相邻两点横平或竖直（不是的先过 orthogonalRoute）。
 * 后置：线从第一个点画到最后一个点，不越过 points 的外包框；dotted 时拐角的台阶格也按点阵的节奏留空。
 */
export function pixelPolylinePath(points: readonly PixelPoint[], style: PixelLineStyle, cell: number): string {
  throw new Error("未实现");
}

/**
 * 把 dagre 给的任意折线改成正交折线：相邻两点之间先横后竖。
 * 后置：结果相邻两点横平或竖直；首尾两点和输入相同（对齐到格子后）；没有连续重复的点。
 */
export function orthogonalRoute(points: readonly PixelPoint[], cell: number): readonly PixelPoint[] {
  throw new Error("未实现");
}

/** 后置：终点箭头，三级台阶的实心三角，尖端落在 tip，朝 dir 指；高 5 格、宽 3 格（朝下时转过来）。 */
export function pixelArrowPath(tip: PixelPoint, dir: "right" | "down", cell: number): string {
  throw new Error("未实现");
}

/**
 * 步骤状态图标，中心落在 center（对齐到格子）。
 * 后置：done、waitingPm 是实心的圆角方块；running 是空心方框中间一格；pending 是空心方框；
 * doneCoil 是三道横杠（N done 折叠）；nextCoil 是竖排三个点（N next 折叠）。都在 5×5 格内。
 */
export function stepGlyphPath(glyph: StepGlyph, center: PixelPoint, cell: number): string {
  throw new Error("未实现");
}
