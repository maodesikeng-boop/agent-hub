export interface PixelPoint {
  x: number;
  y: number;
}

export type TubeState = "filled" | "empty";

export const TUBE_WIDTH_CELLS = { outline: 4, core: 2, highlight: 1 } as const;

export interface TubePaths {
  center: string;
  highlight: string;
}

export type StepBead = "done" | "running" | "waitingPm" | "pending" | "doneCoil" | "nextCoil";

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

export function tubePaths(points: readonly PixelPoint[], cell: number): TubePaths {
  if (points.length < 2) throw new Error("A pipe needs at least two points");
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x !== b.x && a.y !== b.y) throw new Error(`Pipe segment ${i} is neither horizontal nor vertical: (${a.x}, ${a.y}) → (${b.x}, ${b.y})`);
  }
  return { center: polyline(points, 0, 0), highlight: polyline(points, -cell / 2, -cell / 2) };
}

const snap = (v: number, cell: number) => round(Math.round(v / cell) * cell);

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

export const BEAD_CELLS = 7;

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
