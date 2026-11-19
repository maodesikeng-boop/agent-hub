// 任务图的像素画法（docs/slime-cohesion-design.md）：右栏果皮轨和放大全览里，步骤之间用“果冻管道”连，步骤是“果冻珠子”，
// 和 12×12 的史莱姆一个画法：深色描边、果冻色芯、左上一道高光。走通的管子灌满项目经理的颜色，没走通的是空的浅灰管子。
// 不变量：输出是 SVG path 的 d，只有横竖线段，没有圆、斜线和贝塞尔；同样的输入每次得到同一个字符串。
// 调用方按层用 fill 或 stroke 上色，<svg> 上写 shape-rendering="crispEdges"。管道三层的线宽是 TUBE_WIDTH_CELLS 乘格子边长。

export interface PixelPoint {
  x: number;
  y: number;
}

/** filled 是走通了（灌满果冻），empty 是没走通（空管子）。 */
export type TubeState = "filled" | "empty";

/** 管道三层的宽度（格）：描边、芯、高光。 */
export const TUBE_WIDTH_CELLS = { outline: 4, core: 2, highlight: 1 } as const;

/** 一段管道的两层中线：先用 4 格宽的描边色画 center，再用 2 格宽的芯色画 center，filled 时再用 1 格宽的高光色画 highlight。 */
export interface TubePaths {
  center: string;
  highlight: string;
}

/** 步骤珠子（7×7 格）。等你拍板不在这里，用 GateMark。 */
export type StepBead = "done" | "running" | "waitingPm" | "pending" | "doneCoil" | "nextCoil";

/**
 * 一颗珠子按颜色角色分的几层，空字符串表示这一层没有格子。
 * done、waitingPm：highlight 是左上的高光，shade 是右下的暗面；running：highlight 是左上一圈白，shade 是右下一圈浅色；
 * pending、doneCoil、nextCoil 只有 outline 和 fill。
 */
export interface BeadPaths {
  outline: string;
  fill: string;
  highlight: string;
  shade: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function polyline(points: readonly PixelPoint[], dx: number, dy: number): string {
  let d = `M${round(points[0]!.x + dx)} ${round(points[0]!.y + dy)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const p = points[i]!;
    d += p.y === prev.y ? `H${round(p.x + dx)}` : `V${round(p.y + dy)}`;
  }
  return d;
}

/**
 * 一条正交折线画成管道。
 * 前置：points 至少两个点，相邻两点横平或竖直（不是的先过 orthogonalRoute）。
 * 后置：center 依次连过 points；highlight 是 center 往左上各挪半格，竖段落在芯的左半、横段落在芯的上半。
 */
export function tubePaths(points: readonly PixelPoint[], cell: number): TubePaths {
  if (points.length < 2) throw new Error("管道至少要两个点");
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x !== b.x && a.y !== b.y) throw new Error(`管道的第 ${i} 段不横平也不竖直：(${a.x}, ${a.y}) → (${b.x}, ${b.y})`);
  }
  return { center: polyline(points, 0, 0), highlight: polyline(points, -cell / 2, -cell / 2) };
}

const snap = (v: number, cell: number) => round(Math.round(v / cell) * cell);

/**
 * 把任意折线改成正交折线：坐标对齐到格子，相邻两点不横平也不竖直时在中间插一个拐点，先横后竖。
 * 后置：结果相邻两点横平或竖直；首尾两点和输入相同（对齐到格子后）；没有连续重复的点。
 */
export function orthogonalRoute(points: readonly PixelPoint[], cell: number): readonly PixelPoint[] {
  const out: PixelPoint[] = [];
  const push = (p: PixelPoint) => {
    const last = out.at(-1);
    if (last === undefined || last.x !== p.x || last.y !== p.y) out.push(p);
  };
  for (const raw of points) {
    const p = { x: snap(raw.x, cell), y: snap(raw.y, cell) };
    const last = out.at(-1);
    if (last !== undefined && last.x !== p.x && last.y !== p.y) push({ x: p.x, y: last.y });
    push(p);
  }
  return out;
}

/** 一组格子按行合并成矩形：每行连续的一段画一个 M…h…v…h…Z。 */
function cellsPath(rows: readonly string[], chars: string, x0: number, y0: number, cell: number, transpose = false): string {
  let d = "";
  rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!chars.includes(row[c]!)) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < row.length && chars.includes(row[end + 1]!)) end++;
      const len = (end - c + 1) * cell;
      d += transpose
        ? `M${round(x0 + r * cell)} ${round(y0 + c * cell)}h${cell}v${len}h${-cell}Z`
        : `M${round(x0 + c * cell)} ${round(y0 + r * cell)}h${len}v${cell}h${-len}Z`;
      c = end + 1;
    }
  });
  return d;
}

const ARROW = ["O....", "OO...", "OfO..", "OffO.", "OfffO", "OffO.", "OfO..", "OO...", "O...."] as const;

/** 后置：管道终点的像素箭头，三级台阶的三角，外圈描边、里面是芯，尖端落在 tip，朝 dir 指；高 9 格、宽 5 格（朝下时转过来）。 */
export function pixelArrowPaths(tip: PixelPoint, dir: "right" | "down", cell: number): Pick<BeadPaths, "outline" | "fill"> {
  const h = ARROW.length;
  const w = ARROW[0].length;
  if (dir === "right") {
    const x0 = tip.x - w * cell;
    const y0 = tip.y - (h * cell) / 2;
    return { outline: cellsPath(ARROW, "O", x0, y0, cell), fill: cellsPath(ARROW, "f", x0, y0, cell) };
  }
  const x0 = tip.x - (h * cell) / 2;
  const y0 = tip.y - w * cell;
  return { outline: cellsPath(ARROW, "O", x0, y0, cell, true), fill: cellsPath(ARROW, "f", x0, y0, cell, true) };
}

const BEADS: Readonly<Record<StepBead, readonly string[]>> = {
  done: [".OOOOO.", "OhhfffO", "OhffffO", "OfffffO", "OffffsO", "OfffssO", ".OOOOO."],
  running: [".OOOOO.", "OhhhhsO", "OhfffsO", "OhfffsO", "OhfffsO", "OsssssO", ".OOOOO."],
  waitingPm: [".OOOOO.", "OhhfffO", "OhffffO", "OfffffO", "OffffsO", "OfffssO", ".OOOOO."],
  pending: [".OOOOO.", "OfffffO", "OfffffO", "OfffffO", "OfffffO", "OfffffO", ".OOOOO."],
  doneCoil: [".OOOOO.", "OfffffO", ".OOOOO.", ".......", ".OOOOO.", "OfffffO", ".OOOOO."],
  nextCoil: [".OOOOO.", "OfffffO", ".OOOOO.", ".......", ".OOOOO.", "OfffffO", ".OOOOO."],
};

/** 珠子的边长（格）。 */
export const BEAD_CELLS = 7;

/**
 * 步骤珠子，中心落在 center。
 * 后置：done 是实心珠子，左上高光、右下暗面；running 是浅色珠子中间 3×3 一块芯；waitingPm 和 done 同形（调用方上琥珀色）；
 * pending 是空珠子（调用方上灰描边、白芯）；doneCoil 是两道叠起来的实心横条（N done 折叠），nextCoil 是同样形状（调用方上 pending 的颜色）。
 * 都在以 center 为中心的 7×7 格内，四角各缺一格。
 */
export function stepBeadPaths(bead: StepBead, center: PixelPoint, cell: number): BeadPaths {
  const rows = BEADS[bead];
  const x0 = center.x - (BEAD_CELLS * cell) / 2;
  const y0 = center.y - (BEAD_CELLS * cell) / 2;
  return {
    outline: cellsPath(rows, "O", x0, y0, cell),
    fill: cellsPath(rows, "f", x0, y0, cell),
    highlight: cellsPath(rows, "h", x0, y0, cell),
    shade: cellsPath(rows, "s", x0, y0, cell),
  };
}
