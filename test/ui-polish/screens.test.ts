import { describe, expect, it } from "vitest";
import { JUDGE_MAX_CONCURRENT, VIEWPORTS } from "./limits.ts";
import { PATCH_NAMES } from "./patches.ts";
import { SCREEN_AREAS, SCREEN_INVENTORY, SCREEN_STEPS, batchShots, expandShots, inventoryMarkdown, judgeWaves, type ScreenSpec, type Shot } from "./screens.ts";

const fake = (id: string, viewports: ScreenSpec["viewports"] = ["desktop"]): ScreenSpec => ({
  id,
  area: SCREEN_AREAS.find((a) => id.startsWith(`${a}.`))!,
  title: id,
  viewports,
  state: "normal",
  scenario: "standard",
  how: "",
});
const shotsOf = (n: number, prefix = "chat"): Shot[] => expandShots(Array.from({ length: n }, (_, i) => fake(`${prefix}.s${i}`)));

describe("界面清单", () => {
  it("id 不重复，每个 id 以它所属的区域开头", () => {
    const ids = SCREEN_INVENTORY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of SCREEN_INVENTORY) expect(spec.id.startsWith(`${spec.area}.`)).toBe(true);
  });

  it("每个界面至少有一个视口，视口名都在 VIEWPORTS 里", () => {
    for (const spec of SCREEN_INVENTORY) {
      expect(spec.viewports.length).toBeGreaterThan(0);
      for (const v of spec.viewports) expect(Object.keys(VIEWPORTS)).toContain(v);
    }
  });

  it("清单里每个界面在 SCREEN_STEPS 里都有到达步骤", () => {
    const missing = SCREEN_INVENTORY.filter((s) => SCREEN_STEPS[s.id] === undefined).map((s) => s.id);
    expect(missing).toEqual([]);
    const extra = Object.keys(SCREEN_STEPS).filter((id) => !SCREEN_INVENTORY.some((s) => s.id === id));
    expect(extra).toEqual([]);
  });

  it("到达步骤里引的补丁名都在 PATCH_NAMES 里", () => {
    for (const steps of Object.values(SCREEN_STEPS)) {
      for (const step of steps ?? []) if ("patch" in step) expect(PATCH_NAMES).toContain(step.patch);
    }
  });

  it("写了 focus 的界面都有 crop 步骤，没写的没有", () => {
    for (const spec of SCREEN_INVENTORY) {
      const crops = (SCREEN_STEPS[spec.id] ?? []).filter((s) => "crop" in s);
      expect(crops.length, spec.id).toBe(spec.focus === undefined ? 0 : 1);
    }
  });

  it("每个区域都有 normal 以外的状态（空、出错、超长、在忙至少一种）", () => {
    for (const area of SCREEN_AREAS) {
      expect(SCREEN_INVENTORY.some((s) => s.area === area && s.state !== "normal"), area).toBe(true);
    }
  });
});

describe("expandShots", () => {
  it("每个界面按它的每个视口各出一张，key 是 <id>@<视口> 且不重复", () => {
    const shots = expandShots(SCREEN_INVENTORY);
    expect(shots.length).toBe(SCREEN_INVENTORY.reduce((n, s) => n + s.viewports.length, 0));
    expect(new Set(shots.map((s) => s.key)).size).toBe(shots.length);
    expect(shots[0]!.key).toBe(`${SCREEN_INVENTORY[0]!.id}@${SCREEN_INVENTORY[0]!.viewports[0]}`);
  });

  it("only 给区域名时只留这个区域的界面", () => {
    const shots = expandShots(SCREEN_INVENTORY, ["quota"]);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((s) => s.screen.area === "quota")).toBe(true);
  });

  it("only 里有清单里没有的 id 时抛 RangeError", () => {
    expect(() => expandShots(SCREEN_INVENTORY, ["chat.nope"])).toThrow(RangeError);
  });
});

describe("batchShots", () => {
  it("每张图恰好在一批里，每批不超过 batchSize 张", () => {
    const shots = shotsOf(30);
    const sentinels = shotsOf(3, "shell");
    const batches = batchShots(shots, sentinels, 1, 14);
    expect(batches.every((b) => b.length <= 14)).toBe(true);
    const keys = batches.flat().map((s) => s.key);
    expect(keys.sort()).toEqual([...shots, ...sentinels].map((s) => s.key).sort());
  });

  it("batchSize 是 0 或小数时抛 RangeError", () => {
    expect(() => batchShots(shotsOf(3), [], 1, 0)).toThrow(RangeError);
    expect(() => batchShots(shotsOf(3), [], 1, 1.5)).toThrow(RangeError);
  });

  it("哨兵图平均分到各批", () => {
    const sentinels = shotsOf(3, "shell");
    const batches = batchShots(shotsOf(40), sentinels, 1, 14);
    const per = batches.map((b) => b.filter((s) => s.key.startsWith("shell.")).length);
    expect(Math.max(...per) - Math.min(...per)).toBeLessThanOrEqual(1);
  });

  it("哨兵图不和同一界面同一视口的图分在一批", () => {
    const shots = shotsOf(40);
    const sentinels = [shots[0]!, shots[0]!, shots[0]!].map((s, i) => ({ ...s, key: `sentinel-${i}` }));
    const batches = batchShots(shots, sentinels, 1, 14);
    for (const batch of batches) {
      const same = batch.filter((s) => s.screen.id === shots[0]!.screen.id && s.viewport === shots[0]!.viewport);
      expect(same.length).toBeLessThanOrEqual(1);
    }
  });

  it("seed 相同分法相同，seed 不同批内顺序不同", () => {
    const shots = shotsOf(28);
    const keys = (seed: number) => batchShots(shots, [], seed, 28).map((b) => b.map((s) => s.key));
    expect(keys(7)).toEqual(keys(7));
    expect(keys(7)).not.toEqual(keys(8));
    expect(keys(7)[0]!.slice().sort()).toEqual(keys(8)[0]!.slice().sort());
  });
});

describe("judgeWaves", () => {
  it("5 批、两家评委排成两个波次：前 3 批一波，后 2 批一波，每波不超过 JUDGE_MAX_CONCURRENT 个 Worker", () => {
    const waves = judgeWaves(5, 2);
    expect(waves).toEqual([[0, 1, 2], [3, 4]]);
    for (const wave of waves) expect(wave.length * 2).toBeLessThanOrEqual(JUDGE_MAX_CONCURRENT);
  });

  it("每批恰好在一个波次里，顺序不变", () => {
    expect(judgeWaves(10, 2).flat()).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });
});

describe("inventoryMarkdown", () => {
  it("按区域分组，最后一行写界面数和图数，和清单数出来的一致", () => {
    const md = inventoryMarkdown(SCREEN_INVENTORY);
    const shots = SCREEN_INVENTORY.reduce((n, s) => n + s.viewports.length, 0);
    expect(md.trimEnd().split("\n").at(-1)).toBe(`合计：${SCREEN_INVENTORY.length} 个界面，${shots} 张图。`);
    expect(md).toContain("## 额度");
    expect(md.indexOf("## 整页状态")).toBeLessThan(md.indexOf("## 额度"));
  });
});
