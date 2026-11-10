import { describe, expect, it } from "vitest";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog } from "../shared/index.ts";
import { WORKER_PICK_CACHE_MAX } from "../shared/limits.ts";
import { WORKER_PICK_DEFAULT, workerPickRows } from "./worker-pick.ts";

const catalog = (vendor: AgentVendor, over: Partial<ModelCatalog> = {}): ModelCatalog => ({ ...bundledModelCatalog(vendor), ...over });

// 三家：一家能用、一家没登录、一家没装（名字只在测试里写，代码里不写死任何厂商、模型）
const CATALOGS: readonly ModelCatalog[] = [
  catalog("claude", {
    label: "Claude Code",
    availability: "available",
    models: [
      { id: "opus", label: "Opus", description: "Most capable", efforts: ["low", "high"] },
      { id: "haiku", label: "Haiku", description: null, efforts: ["low"] },
      { id: "sonnet", label: "Sonnet", description: "Balanced", efforts: [] },
    ],
    defaultModel: "Opus",
    defaultEfforts: ["low", "medium", "high"],
    efforts: ["low", "medium", "high"],
  }),
  catalog("agy", { label: "Antigravity", availability: "signed_out" }),
  catalog("codex", { label: "Codex", availability: "not_installed" }),
];

const labels = (rows: ReturnType<typeof workerPickRows>) => rows?.items.map((i) => i.label);

describe("workerPickRows：第 0 级厂商", () => {
  it("没装的不列；没登录的列出来但不能选，说明位写 Not signed in；能用的说明位是空的", () => {
    const rows = workerPickRows(CATALOGS, [], "");
    expect(rows?.level).toBe("vendor");
    expect(rows?.items).toEqual([
      { id: "worker:vendor:claude", label: "Claude Code", detail: "", insert: "claude" },
      { id: "worker:vendor:agy", label: "Antigravity", detail: "Not signed in", insert: "agy", disabled: true },
    ]);
  });

  it("按 id 或显示名筛：开头命中排前，其次包含，最后说明里有", () => {
    expect(labels(workerPickRows(CATALOGS, [], "anti"))).toEqual(["Antigravity"]);
    expect(labels(workerPickRows(CATALOGS, [], "cl"))).toEqual(["Claude Code"]);
    expect(labels(workerPickRows(CATALOGS, [], "signed"))).toEqual(["Antigravity"]);
    expect(labels(workerPickRows(CATALOGS, [], "zzz"))).toEqual([]);
  });

  it("厂商顺序照名单，不按别的排", () => {
    const swapped = [CATALOGS[1]!, CATALOGS[0]!];
    expect(labels(workerPickRows(swapped, [], ""))).toEqual(["Antigravity", "Claude Code"]);
  });
});

describe("workerPickRows：第 1 级模型", () => {
  it("第一行 Default（说明写实际用的模型），其后是这家名单里的模型和厂商给的说明，插入的是模型 id", () => {
    const rows = workerPickRows(CATALOGS, ["claude"], "");
    expect(rows?.level).toBe("model");
    expect(rows?.items).toEqual([
      { id: "worker:model:default", label: "Default", detail: "Opus (default)", insert: WORKER_PICK_DEFAULT },
      { id: "worker:model:opus", label: "Opus", detail: "Most capable", insert: "opus" },
      { id: "worker:model:haiku", label: "Haiku", detail: "", insert: "haiku" },
      { id: "worker:model:sonnet", label: "Sonnet", detail: "Balanced", insert: "sonnet" },
    ]);
  });

  it("筛选：opus 只剩 Opus 和说明里提到它的 Default", () => {
    expect(labels(workerPickRows(CATALOGS, ["claude"], "opus"))).toEqual(["Opus", "Default"]);
    expect(labels(workerPickRows(CATALOGS, ["claude"], "def"))).toEqual(["Default"]);
  });

  it("厂商不认识、没登录、没装：没有这一级（不弹）", () => {
    expect(workerPickRows(CATALOGS, ["nope"], "")).toBeNull();
    expect(workerPickRows(CATALOGS, ["agy"], "")).toBeNull();
    expect(workerPickRows(CATALOGS, ["codex"], "")).toBeNull();
  });
});

describe("workerPickRows：第 2 级思考程度", () => {
  it("只列这个模型支持的档位（effortsFor），第一行 Default", () => {
    const rows = workerPickRows(CATALOGS, ["claude", "opus"], "");
    expect(rows?.level).toBe("effort");
    expect(rows?.items).toEqual([
      { id: "worker:effort:default", label: "Default", detail: "", insert: WORKER_PICK_DEFAULT },
      { id: "worker:effort:low", label: "low", detail: "", insert: "low" },
      { id: "worker:effort:high", label: "high", detail: "", insert: "high" },
    ]);
  });

  it("模型选 Default：用默认模型支持的档位", () => {
    expect(labels(workerPickRows(CATALOGS, ["claude", WORKER_PICK_DEFAULT], ""))).toEqual(["Default", "low", "medium", "high"]);
  });

  it("只有一档或没有档位：跳过这一级", () => {
    expect(workerPickRows(CATALOGS, ["claude", "haiku"], "")).toBeNull();
    expect(workerPickRows(CATALOGS, ["claude", "sonnet"], "")).toBeNull();
  });

  it("模型不在名单里：没有这一级", () => {
    expect(workerPickRows(CATALOGS, ["claude", "gpt-x"], "")).toBeNull();
  });

  it("筛选", () => {
    expect(labels(workerPickRows(CATALOGS, ["claude", "opus"], "hi"))).toEqual(["high"]);
    expect(labels(workerPickRows(CATALOGS, ["claude", "opus"], "zzz"))).toEqual([]);
  });

  it("三级都选完：没有下一级", () => {
    expect(workerPickRows(CATALOGS, ["claude", "opus", "high"], "")).toBeNull();
  });
});

describe("workerPickRows：引用稳定（WeakMap 按 catalogs 数组缓存）", () => {
  it("同一份名单、同一级、同一查询返回同一个对象；换一份名单重新算", () => {
    const a = workerPickRows(CATALOGS, ["claude"], "o");
    expect(workerPickRows(CATALOGS, ["claude"], "o")).toBe(a);
    expect(workerPickRows(CATALOGS, ["claude"], "op")).not.toBe(a);
    const copy = [...CATALOGS];
    const b = workerPickRows(copy, ["claude"], "o");
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it("一份名单下缓存的条数有上限（一直换筛选词也不无限涨），超了重新算、结果不变", () => {
    const list = [...CATALOGS];
    const first = workerPickRows(list, [], "c");
    for (let i = 0; i < WORKER_PICK_CACHE_MAX + 5; i++) workerPickRows(list, [], `q${i}`);
    const again = workerPickRows(list, [], "c");
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
  });
});
