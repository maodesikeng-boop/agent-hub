import { describe, expect, it } from "vitest";
import { orthogonalRoute, pixelArrowPaths, stepBeadPaths, tubePaths, type PixelPoint, type StepBead } from "./pixel-path.ts";

/** 把只含 M/H/V/h/v/Z 的路径拆成线段端点，顺带检查没有曲线命令。 */
function pointsOf(d: string): PixelPoint[] {
  expect(d).not.toMatch(/[CcQqAaSsTtLl]/);
  const pts: PixelPoint[] = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([MHVhvZ])\s*(-?[\d.]+)?(?:\s+(-?[\d.]+))?/g)) {
    const [, cmd, a, b] = m;
    if (cmd === "M") (x = Number(a)), (y = Number(b));
    else if (cmd === "H") x = Number(a);
    else if (cmd === "V") y = Number(a);
    else if (cmd === "h") x += Number(a);
    else if (cmd === "v") y += Number(a);
    else continue;
    pts.push({ x, y });
  }
  return pts;
}

/** 矩形路径（M x y h w v h h -w Z）覆盖的格子左上角集合。 */
function cellsOf(d: string, cell: number): Set<string> {
  const cells = new Set<string>();
  for (const m of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h-?[\d.]+Z/g)) {
    const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    for (let cx = x; cx < x + w - 1e-9; cx += cell) for (let cy = y; cy < y + h - 1e-9; cy += cell) cells.add(`${Math.round(cx * 100) / 100},${Math.round(cy * 100) / 100}`);
  }
  return cells;
}

describe("tubePaths", () => {
  it("center 依次连过每个点，只有横竖线段，没有 C、Q、A 曲线命令", () => {
    const pts = [
      { x: 11, y: -2 },
      { x: 11, y: 6 },
      { x: 29, y: 6 },
      { x: 29, y: 34 },
    ];
    const { center } = tubePaths(pts, 2);
    expect(center).toBe("M11 -2V6H29V34");
    expect(pointsOf(center)).toEqual(pts);
  });

  it("highlight 是 center 往左上各挪半格：竖段在芯的左半，横段在芯的上半", () => {
    const { highlight } = tubePaths(
      [
        { x: 10, y: 0 },
        { x: 10, y: 20 },
        { x: 40, y: 20 },
      ],
      4,
    );
    expect(pointsOf(highlight)).toEqual([
      { x: 8, y: -2 },
      { x: 8, y: 18 },
      { x: 38, y: 18 },
    ]);
  });

  it("少于两个点、或相邻两点不横平也不竖直时抛错", () => {
    expect(() => tubePaths([{ x: 0, y: 0 }], 2)).toThrow();
    expect(() =>
      tubePaths(
        [
          { x: 0, y: 0 },
          { x: 4, y: 6 },
        ],
        2,
      ),
    ).toThrow(/neither horizontal nor vertical/);
  });
});

describe("orthogonalRoute", () => {
  it("相邻两点之间先横后竖，结果相邻两点横平或竖直", () => {
    const route = orthogonalRoute(
      [
        { x: 0, y: 0 },
        { x: 20, y: 12 },
        { x: 40, y: 4 },
      ],
      2,
    );
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 12 },
      { x: 40, y: 12 },
      { x: 40, y: 4 },
    ]);
    for (let i = 1; i < route.length; i++) expect(route[i]!.x === route[i - 1]!.x || route[i]!.y === route[i - 1]!.y).toBe(true);
  });

  it("首尾两点对齐到格子后和输入相同，没有连续重复的点", () => {
    const route = orthogonalRoute(
      [
        { x: 0.9, y: 3.1 },
        { x: 1.2, y: 3 },
        { x: 9, y: 3 },
        { x: 9, y: 3 },
      ],
      2,
    );
    expect(route[0]).toEqual({ x: 0, y: 4 });
    expect(route.at(-1)).toEqual({ x: 10, y: 4 });
    for (let i = 1; i < route.length; i++) expect(route[i]).not.toEqual(route[i - 1]);
  });
});

describe("pixelArrowPaths", () => {
  it("朝右的箭头尖端落在 tip，高 9 格、宽 5 格，外圈描边、里面是芯", () => {
    const { outline, fill } = pixelArrowPaths({ x: 100, y: 50 }, "right", 2);
    const out = cellsOf(outline, 2);
    const core = cellsOf(fill, 2);
    const xs = [...out, ...core].map((c) => Number(c.split(",")[0]));
    const ys = [...out, ...core].map((c) => Number(c.split(",")[1]));
    expect(Math.max(...xs) + 2).toBe(100);
    expect(Math.min(...xs)).toBe(90);
    expect([Math.min(...ys), Math.max(...ys) + 2]).toEqual([41, 59]);
    expect(out.has("98,49")).toBe(true);
    expect(core.size).toBe(1 + 2 + 3 + 2 + 1);
    for (const c of core) expect(out.has(c)).toBe(false);
  });

  it("朝下的箭头是朝右的转过来", () => {
    const right = pixelArrowPaths({ x: 0, y: 0 }, "right", 1);
    const down = pixelArrowPaths({ x: 0, y: 0 }, "down", 1);
    const flip = (cells: Set<string>) => new Set([...cells].map((c) => c.split(",").reverse().join(",")));
    expect(cellsOf(down.outline, 1)).toEqual(flip(cellsOf(right.outline, 1)));
    expect(cellsOf(down.fill, 1)).toEqual(flip(cellsOf(right.fill, 1)));
  });
});

describe("stepBeadPaths", () => {
  const BEADS: StepBead[] = ["done", "running", "waitingPm", "pending", "doneCoil", "nextCoil"];
  const all = (bead: StepBead, center: PixelPoint, cell: number) => {
    const p = stepBeadPaths(bead, center, cell);
    return new Set([...cellsOf(p.outline, cell), ...cellsOf(p.fill, cell), ...cellsOf(p.highlight, cell), ...cellsOf(p.shade, cell)]);
  };

  it("每种珠子都画在以 center 为中心的 7×7 格内，四角各缺一格", () => {
    for (const bead of BEADS) {
      const cells = all(bead, { x: 11, y: 16 }, 2);
      for (const c of cells) {
        const [x, y] = c.split(",").map(Number) as [number, number];
        expect(x).toBeGreaterThanOrEqual(4);
        expect(x + 2).toBeLessThanOrEqual(18);
        expect(y).toBeGreaterThanOrEqual(9);
        expect(y + 2).toBeLessThanOrEqual(23);
      }
      for (const corner of ["4,9", "16,9", "4,21", "16,21"]) expect(cells.has(corner), `${bead} ${corner}`).toBe(false);
    }
  });

  it("done 有高光和暗面，running 中间 3×3 是芯，pending 只有描边和芯", () => {
    const done = stepBeadPaths("done", { x: 0, y: 0 }, 1);
    expect(done.highlight).not.toBe("");
    expect(done.shade).not.toBe("");
    const running = stepBeadPaths("running", { x: 3.5, y: 3.5 }, 1);
    expect(cellsOf(running.fill, 1)).toEqual(new Set(["2,2", "3,2", "4,2", "2,3", "3,3", "4,3", "2,4", "3,4", "4,4"]));
    const pending = stepBeadPaths("pending", { x: 0, y: 0 }, 1);
    expect([pending.highlight, pending.shade]).toEqual(["", ""]);
    expect(stepBeadPaths("waitingPm", { x: 0, y: 0 }, 1)).toEqual(done);
  });

  it("doneCoil 两道实心横条，nextCoil 同样形状", () => {
    const coil = stepBeadPaths("doneCoil", { x: 3.5, y: 3.5 }, 1);
    expect(cellsOf(coil.fill, 1)).toEqual(new Set(["1,1", "2,1", "3,1", "4,1", "5,1", "1,5", "2,5", "3,5", "4,5", "5,5"]));
    expect(stepBeadPaths("nextCoil", { x: 3.5, y: 3.5 }, 1)).toEqual(coil);
  });

  it("同样的输入两次得到同样的结果", () => {
    for (const bead of BEADS) expect(stepBeadPaths(bead, { x: 29, y: 16 }, 2)).toEqual(stepBeadPaths(bead, { x: 29, y: 16 }, 2));
  });
});
