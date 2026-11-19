import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PM_FRUITS, pmFruitOf, type PmFruit } from "./fruits.ts";
import {
  contrastRatio,
  defaultLookOf,
  EXTRA_JELLY_COLOR_IDS,
  gateBellPaths,
  GATE_BELL_GRID,
  isJellyColorId,
  isPmFruit,
  JELLY_COLOR_IDS,
  jellyColorOf,
  lookKey,
  opticalLiftOf,
  parseLookKey,
  pickNewPmLook,
  resolvePmLook,
  routerBellPaths,
  routerBellSvg,
  SLIME_GRID,
  slimeBitmap,
  slimePaths,
  slimeSvg,
  type JellyColorId,
  type SlimeLook,
  type SlimePath,
} from "./slimes.ts";

// 加换色之前 assets/avatars/ 下提交的文件（scripts/render-avatars.ts 生成，已删）：主形象 SVG 文本、飞书群头像解码后 RGB 的 sha256 前 16 位。
const LEGACY_SVG: Record<PmFruit, string> = {
  grapefruit: "706156910f02d2c7",
  orange: "b6be15c14051b579",
  kiwi: "66af50772dbdca72",
  strawberry: "8b39a50b309becae",
  lime: "6f6b0a05db4b870d",
  lemon: "491f15874d991e00",
  pomelo: "1c50458220321ee2",
  bell_pepper: "f7bcff3b585d832a",
  blueberry: "a7a796a59e423f45",
  peach: "6fa0ce858710258f",
  watermelon: "12ae0ca18b439b24",
  grape: "65f8c4a99e88b980",
  pineapple: "6bc29edfa6f93995",
  cherry: "4a9aab4dd020cefc",
  melon: "a60361ce847281a5",
  dragon_fruit: "094f3e41272e99d1",
  pear: "29d32f1d5dc141df",
  mangosteen: "63d2bc3975e95506",
  persimmon: "0e004636cc893535",
  coconut: "08c3823b481d49b4",
};

const sha16 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);
const own = (fruit: PmFruit): SlimeLook => ({ fruit, color: fruit });
const allLooks = (): SlimeLook[] => PM_FRUITS.flatMap((fruit) => JELLY_COLOR_IDS.map((color) => ({ fruit, color })));

/** 路径里所有格子坐标（只有 M、H、V、Z）。 */
function coordsOf(paths: readonly SlimePath[]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const { d } of paths) {
    expect(d).toMatch(/^[MHVZ\d .-]+$/);
    let cx = 0;
    for (const m of d.matchAll(/([MHV])([-\d.]+)(?: ([-\d.]+))?/g)) {
      if (m[1] === "M") {
        cx = Number(m[2]);
        x.push(cx);
        y.push(Number(m[3]));
      } else if (m[1] === "H") x.push(Number(m[2]));
      else y.push(Number(m[2]));
    }
  }
  return { x, y };
}

describe("颜色名录", () => {
  it("isJellyColorId：名录里的 id 为真，别的字符串、数字、null 为假", () => {
    for (const id of JELLY_COLOR_IDS) expect(isJellyColorId(id)).toBe(true);
    for (const bad of ["", "Sky", "blue", "orange ", 3, null, undefined, {}]) expect(isJellyColorId(bad)).toBe(false);
    expect(isPmFruit("sky")).toBe(false);
    expect(isPmFruit("kiwi")).toBe(true);
  });

  it("jellyColorOf：每种颜色的 accent 对白色 ≥ 4.5:1，悬停变深（brightness-90）之后仍 ≥ 4.5:1", () => {
    const darken = (hex: string) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.9).toString(16).padStart(2, "0")).join("")}`;
    for (const id of JELLY_COLOR_IDS) {
      const c = jellyColorOf(id);
      expect(contrastRatio(c.accent, c.accentForeground), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darken(c.accent), c.accentForeground), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("jellyColorOf：每种颜色掺 --mix-bubble-me 的用户气泡底配前景色字 ≥ 4.5:1，果冻底上的次要文字 ≥ 4.5:1", () => {
    const mix = (hex: string, p: number, base: string) =>
      `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * p + parseInt(base.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, "0")).join("")}`;
    for (const id of JELLY_COLOR_IDS) {
      const { accent } = jellyColorOf(id);
      expect(contrastRatio("#18181b", mix(accent, 0.12, "#ffffff")), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#5f5f69", mix(accent, 0.1, mix("#18181b", 0.03, "#f6f6f7"))), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("jellyColorOf：同一个 id 两次返回同一个对象；名字、主色、强调色都不重复", () => {
    for (const id of JELLY_COLOR_IDS) expect(jellyColorOf(id)).toBe(jellyColorOf(id));
    for (const key of ["label", "accent"] as const) expect(new Set(JELLY_COLOR_IDS.map((id) => jellyColorOf(id)[key])).size, key).toBe(JELLY_COLOR_IDS.length);
  });

  it("前 20 种颜色的 id 和 PM_FRUITS 一一对应，顺序相同；后面是 4 种新颜色", () => {
    expect(JELLY_COLOR_IDS.slice(0, PM_FRUITS.length)).toEqual([...PM_FRUITS]);
    expect(JELLY_COLOR_IDS.slice(PM_FRUITS.length)).toEqual([...EXTRA_JELLY_COLOR_IDS]);
    expect(JELLY_COLOR_IDS).toHaveLength(24);
  });
});

describe("项目经理的形象", () => {
  it("defaultLookOf：造型是 pmFruitOf(编号)，颜色是这个造型的原色", () => {
    for (const id of [0, 1, 7, 19, 20, 41]) expect(defaultLookOf(id)).toEqual({ fruit: pmFruitOf(id), color: pmFruitOf(id) });
  });

  it("resolvePmLook：avatarFruit、avatarColor 缺了或是 null 时各自退回默认", () => {
    expect(resolvePmLook({ id: 2 })).toEqual(defaultLookOf(2));
    expect(resolvePmLook({ id: 2, avatarFruit: null, avatarColor: null })).toBe(defaultLookOf(2));
    expect(resolvePmLook({ id: 2, avatarFruit: "persimmon", avatarColor: null })).toEqual({ fruit: "persimmon", color: "persimmon" });
  });

  it("resolvePmLook：只换颜色时造型仍是按编号默认的那只", () => {
    expect(resolvePmLook({ id: 3, avatarFruit: null, avatarColor: "sky" })).toEqual({ fruit: pmFruitOf(3), color: "sky" });
  });

  it("resolvePmLook：不在名录里的造型或颜色（新版本设备传来的）退回默认，不抛错", () => {
    const pm = { id: 4, avatarFruit: "durian", avatarColor: "neon" } as unknown as Parameters<typeof resolvePmLook>[0];
    expect(resolvePmLook(pm)).toBe(defaultLookOf(4));
  });

  it("resolvePmLook：同样的造型和颜色两次返回同一个对象", () => {
    const a = resolvePmLook({ id: 1, avatarFruit: "kiwi", avatarColor: "teal" });
    const b = resolvePmLook({ id: 9, avatarFruit: "kiwi", avatarColor: "teal" });
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("pickNewPmLook：取名录里第一个没被占的造型，配它的原色", () => {
    expect(pickNewPmLook([], 7)).toEqual(own(PM_FRUITS[0]!));
    const taken = [own("grapefruit"), { fruit: "orange", color: "sky" } as const, own("lime")];
    expect(pickNewPmLook(taken, 7)).toEqual(own("kiwi"));
  });

  it("pickNewPmLook：20 种造型都被占了退回 defaultLookOf(编号)", () => {
    expect(pickNewPmLook(PM_FRUITS.map(own), 13)).toBe(defaultLookOf(13));
  });

  it("lookKey 和 parseLookKey 互逆；造型或颜色不在名录里 parseLookKey 返回 null", () => {
    for (const look of allLooks()) expect(parseLookKey(lookKey(look))).toEqual(look);
    expect(lookKey({ fruit: "persimmon", color: "sky" })).toBe("persimmon:sky");
    for (const bad of ["", "persimmon", "persimmon:", "durian:sky", "persimmon:neon", "persimmon:sky:x"]) expect(parseLookKey(bad)).toBeNull();
  });
});

describe("画史莱姆", () => {
  it("slimePaths：原色画出来的主形象和加换色之前的 20 只逐字节相同（SVG 文本）", () => {
    for (const fruit of PM_FRUITS) expect(sha16(slimeSvg(own(fruit), "main")), fruit).toBe(LEGACY_SVG[fruit]);
  });

  it("slimePaths(piece)：同一种颜色下 20 个造型画出来完全一样，换颜色才不同", () => {
    for (const color of JELLY_COLOR_IDS) {
      const first = slimePaths({ fruit: PM_FRUITS[0]!, color }, "piece");
      for (const fruit of PM_FRUITS) expect(slimePaths({ fruit, color }, "piece")).toBe(first);
    }
    expect(slimePaths(own("orange"), "piece")).not.toEqual(slimePaths({ fruit: "orange", color: "sky" }, "piece"));
  });

  it("slimePaths(piece)：只有描边、身体、暗面、浅色和眼睛五种颜色，占的格子上下居中", () => {
    for (const color of JELLY_COLOR_IDS) {
      const c = jellyColorOf(color);
      const allowed = new Set([c.roles.outline, c.roles.body, c.roles.shade, c.roles.light, "#3a1e14"]);
      const paths = slimePaths({ fruit: "orange", color }, "piece");
      for (const p of paths) expect(allowed.has(p.fill), `${color} ${p.fill}`).toBe(true);
      const { y } = coordsOf(paths);
      expect(Math.min(...y) + Math.max(...y)).toBe(SLIME_GRID);
    }
  });

  it("slimePaths：换颜色只换描边、身体、暗面、浅色、腮红、花纹，眼睛、叶子、喙、牙不变", () => {
    const fixed = (look: SlimeLook) => {
      const roles = new Set(Object.values(jellyColorOf(look.color).roles));
      return slimePaths(look, "main").filter((p) => !roles.has(p.fill));
    };
    for (const fruit of PM_FRUITS) {
      const base = fixed(own(fruit));
      for (const color of EXTRA_JELLY_COLOR_IDS) expect(fixed({ fruit, color }), `${fruit} × ${color}`).toEqual(base);
    }
    expect(slimePaths({ fruit: "orange", color: "sky" }, "main").map((p) => p.fill)).toContain(jellyColorOf("sky").roles.outline);
  });

  it("slimePaths：所有造型 × 所有颜色、主形象和 Piece 分身，坐标都在 12×12 格内，没有 NaN", () => {
    for (const look of allLooks()) {
      for (const kind of ["main", "piece"] as const) {
        const { x, y } = coordsOf(slimePaths(look, kind));
        for (const v of [...x, ...y]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(SLIME_GRID);
        }
      }
    }
  });

  it("slimePaths：同样的输入两次返回同一个数组", () => {
    const look: SlimeLook = { fruit: "pear", color: "sakura" };
    expect(slimePaths(look, "main")).toBe(slimePaths({ ...look }, "main"));
    expect(Object.isFrozen(slimePaths(look, "main"))).toBe(true);
  });

  it("opticalLiftOf：主形象在 0 到 2 格之间，上移后身体上下中点落在画布中线；Piece 分身是 0", () => {
    for (const fruit of PM_FRUITS) {
      const lift = opticalLiftOf(fruit, "main");
      expect(lift, fruit).toBeGreaterThan(0);
      expect(lift, fruit).toBeLessThanOrEqual(2);
      expect(opticalLiftOf(fruit, "piece")).toBe(0);
    }
    // 兔耳、樱桃梗、菠萝叶不算身体：和没有耳朵的小鸡一样挪 1.5 格；本来就高的白柚小狗、青柠青蛙、青梨长颈鹿挪 1 格
    expect(opticalLiftOf("strawberry", "main")).toBe(opticalLiftOf("lemon", "main"));
    expect(opticalLiftOf("pineapple", "main")).toBe(1.5);
    expect(["pomelo", "lime", "pear"].map((f) => opticalLiftOf(f as PmFruit, "main"))).toEqual([1, 1, 1]);
  });

  it("slimeSvg：viewBox 12×12、crispEdges、透明底，没有 id、渐变、滤镜和位图", () => {
    for (const look of [own("kiwi"), { fruit: "coconut", color: "graphite" } as const]) {
      for (const kind of ["main", "piece"] as const) {
        const svg = slimeSvg(look, kind);
        expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 12 12" shape-rendering="crispEdges">(<path d="[MHVZ\d ]+" fill="#[0-9a-f]{6}"\/>)+<\/svg>\n$/);
        expect(svg).not.toMatch(/id=|Gradient|filter|<image|<rect/);
      }
    }
  });

  it("slimeBitmap：边长是格子数的整数倍、最接近目标边长，底色是这个颜色的 backdrop，圆形裁切后像素角离圆边至少 padCells 格", () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    for (const look of [own("strawberry"), own("cherry"), { fruit: "melon", color: "sky" } as const]) {
      const { size, rgb } = slimeBitmap(look, 1024, 0.75);
      expect(rgb).toHaveLength(size * size * 3);
      expect(Math.abs(size - 1024)).toBeLessThanOrEqual(32);
      const backdrop = jellyColorOf(look.color).backdrop;
      const hexAt = (x: number, y: number) => {
        const i = (y * size + x) * 3;
        return `#${[...rgb.slice(i, i + 3)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      };
      expect(hexAt(0, 0)).toBe(backdrop);
      // 每格是整数个像素：一行里同色连续段的长度都是格子边长的倍数，它们的最大公约数就是格子边长
      let cell = 0;
      let far = 0;
      const half = size / 2;
      for (let y = 0; y < size; y++) {
        let runStart = 0;
        for (let x = 1; x <= size; x++) {
          if (x === size || hexAt(x, y) !== hexAt(runStart, y)) {
            if (hexAt(runStart, y) !== backdrop) {
              cell = gcd(cell, x - runStart);
              // 这一段离圆心最远的像素角
              for (const px of [runStart, x]) far = Math.max(far, Math.hypot(px - half, y - half), Math.hypot(px - half, y + 1 - half));
            }
            runStart = x;
          }
        }
      }
      expect(cell).toBeGreaterThan(1);
      expect(size % cell).toBe(0);
      expect(half - far).toBeGreaterThanOrEqual(0.75 * cell);
    }
  });

  it("slimeBitmap：原色和加换色之前的群头像像素逐个相同；同样的输入两次得到逐字节相同的 rgb，换颜色后不同", () => {
    const a = slimeBitmap(own("orange"), 1024, 0.75);
    expect(`${a.size}:${sha16(a.rgb)}`).toBe("1026:5eecdd06afce0f8c");
    expect(sha16(slimeBitmap(own("orange"), 1024, 0.75).rgb)).toBe(sha16(a.rgb));
    expect(sha16(slimeBitmap({ fruit: "orange", color: "sky" }, 1024, 0.75).rgb)).not.toBe(sha16(a.rgb));
  });
});

describe("总助嫩芽铃和拍板小铃", () => {
  it("嫩芽铃 12×12、拍板小铃 6×6，只有横竖线段；每次返回同一个数组", () => {
    for (const [paths, grid] of [
      [routerBellPaths(), SLIME_GRID],
      [gateBellPaths(), GATE_BELL_GRID],
    ] as const) {
      const { x, y } = coordsOf(paths);
      expect(Math.max(...x, ...y)).toBeLessThanOrEqual(grid);
      expect(Math.min(...x, ...y)).toBe(0);
    }
    expect(routerBellPaths()).toBe(routerBellPaths());
    expect(GATE_BELL_GRID).toBe(6);
    expect(routerBellSvg()).toMatch(/^<svg [^>]*viewBox="0 0 12 12" shape-rendering="crispEdges">/);
  });

  it("嫩芽铃不跟任何项目经理的颜色走：和 24 种果冻色的描边都不同", () => {
    const outline = routerBellPaths()[0]!.fill;
    for (const id of JELLY_COLOR_IDS as readonly JellyColorId[]) expect(jellyColorOf(id).roles.outline).not.toBe(outline);
  });
});
