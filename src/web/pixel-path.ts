// 任务图的像素画法（docs/slime-cohesion-design.md）：右栏果皮轨和放大全览里，步骤之间用“果冻管道”连，步骤是“果冻珠子”，
// 和 12×12 的史莱姆一个画法：深色描边、果冻色芯、左上一道高光。走通的管子灌满项目经理的颜色，没走通的是空的浅灰管子。
// 不变量：输入坐标先对齐到 cell 的整数倍；输出是 SVG path 的 d，只有横竖线段，没有圆、斜线和贝塞尔；
// 同样的输入每次得到同一个字符串。调用方按层用 fill 或 stroke 上色，<svg> 上写 shape-rendering="crispEdges"。

export interface PixelPoint {
  x: number;
  y: number;
}

/** filled 是走通了（灌满果冻），empty 是没走通（空管子）。 */
export type TubeState = "filled" | "empty";

/** 一段管道的两层中线：先用 4 格宽的描边色画 center，再用 2 格宽的芯色画 center，filled 时再用 1 格宽的高光色画 highlight。 */
export interface TubePaths {
  center: string;
  highlight: string;
}

/** 步骤珠子（7×7 格）。等你拍板不在这里，用 GateMark。 */
export type StepBead = "done" | "running" | "waitingPm" | "pending" | "doneCoil" | "nextCoil";

/** 一颗珠子按颜色角色分的几层，空字符串表示这一层没有格子。 */
export interface BeadPaths {
  outline: string;
  fill: string;
  highlight: string;
  shade: string;
}

/**
 * 一条正交折线画成管道。
 * 前置：points 至少两个点，相邻两点横平或竖直（不是的先过 orthogonalRoute）。
 * 后置：center 依次连过 points；highlight 是 center 往左上各挪半格，竖段落在芯的左半、横段落在芯的上半。
 */
export function tubePaths(points: readonly PixelPoint[], cell: number): TubePaths {
  throw new Error("未实现");
}

/**
 * 把 dagre 给的任意折线改成正交折线：相邻两点之间先横后竖。
 * 后置：结果相邻两点横平或竖直；首尾两点和输入相同（对齐到格子后）；没有连续重复的点。
 */
export function orthogonalRoute(points: readonly PixelPoint[], cell: number): readonly PixelPoint[] {
  throw new Error("未实现");
}

/** 后置：管道终点的像素箭头，三级台阶的三角，外圈描边、里面一格芯，尖端落在 tip，朝 dir 指；高 9 格、宽 5 格（朝下时转过来）。 */
export function pixelArrowPaths(tip: PixelPoint, dir: "right" | "down", cell: number): Pick<BeadPaths, "outline" | "fill"> {
  throw new Error("未实现");
}

/**
 * 步骤珠子，中心落在 center（对齐到格子）。
 * 后置：done 是实心珠子，左上高光、右下暗面；running 是浅色珠子中间 3×3 一块芯；waitingPm 是琥珀色珠子；
 * pending 是灰描边的空珠子；doneCoil 是两道叠起来的实心横条（N done 折叠），nextCoil 是同样形状的空心横条（N next 折叠）。都在 7×7 格内。
 */
export function stepBeadPaths(bead: StepBead, center: PixelPoint, cell: number): BeadPaths {
  throw new Error("未实现");
}
