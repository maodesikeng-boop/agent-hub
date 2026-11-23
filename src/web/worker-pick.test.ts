import { describe, expect, it } from "vitest";
import { bundledModelCatalog, pickableVendorCatalogs, type AgentVendor, type ModelCatalog } from "../shared/index.ts";
import { WORKER_PICK_CACHE_MAX } from "../shared/limits.ts";
import { WORKER_PICK_DEFAULT, workerPickFromArgs, workerPickLabels, workerPickRows } from "./worker-pick.ts";

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

describe("pickableVendorCatalogs：全站统一的可用厂商筛选", () => {
  it("只留可用厂商（available / unknown）；未安装、未登录都不列；保留当前已选且引用按 catalogs WeakMap 稳定", () => {
    const first = pickableVendorCatalogs(CATALOGS);
    expect(first.map((c) => c.vendor)).toEqual(["claude"]);
    expect(pickableVendorCatalogs(CATALOGS)).toBe(first);

    const keepingSignedOut = pickableVendorCatalogs(CATALOGS, "agy");
    expect(keepingSignedOut.map((c) => c.vendor)).toEqual(["claude", "agy"]);
    expect(pickableVendorCatalogs(CATALOGS, "agy")).toBe(keepingSignedOut);

    const keepingMissing = pickableVendorCatalogs(CATALOGS, "codex");
    expect(keepingMissing.map((c) => c.vendor)).toEqual(["claude", "codex"]);

    const unknownVendor = pickableVendorCatalogs(CATALOGS, "mystery-vendor" as AgentVendor);
    expect(unknownVendor.map((c) => c.vendor)).toEqual(["claude"]);
  });
});

describe("workerPickRows：第 0 级厂商", () => {
  it("只列可用厂商，未安装与未登录都不列，说明位是空的", () => {
    const rows = workerPickRows(CATALOGS, [], "");
    expect(rows?.level).toBe("vendor");
    expect(rows?.items).toEqual([
      { id: "worker:vendor:claude", label: "Claude Code", detail: "", insert: "claude" },
    ]);
  });

  it("按 id 或显示名筛：开头命中排前，未登录厂商不会被筛出来", () => {
    const twoReady = [CATALOGS[0]!, catalog("agy", { label: "Antigravity", availability: "available" }), CATALOGS[2]!];
    expect(labels(workerPickRows(twoReady, [], "anti"))).toEqual(["Antigravity"]);
    expect(labels(workerPickRows(twoReady, [], "cl"))).toEqual(["Claude Code"]);
    expect(labels(workerPickRows(CATALOGS, [], "anti"))).toEqual([]);
    expect(labels(workerPickRows(CATALOGS, [], "zzz"))).toEqual([]);
  });

  it("厂商顺序照名单，不按别的排", () => {
    const readyAgy = catalog("agy", { label: "Antigravity", availability: "available" });
    const swapped = [readyAgy, CATALOGS[0]!];
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
      { id: "worker:effort:low", label: "Low", detail: "", insert: "low" },
      { id: "worker:effort:high", label: "High", detail: "", insert: "high" },
    ]);
  });

  it("模型选 Default：用默认模型支持的档位", () => {
    expect(labels(workerPickRows(CATALOGS, ["claude", WORKER_PICK_DEFAULT], ""))).toEqual(["Default", "Low", "Medium", "High"]);
  });

  it("只有一档或没有档位：跳过这一级", () => {
    expect(workerPickRows(CATALOGS, ["claude", "haiku"], "")).toBeNull();
    expect(workerPickRows(CATALOGS, ["claude", "sonnet"], "")).toBeNull();
  });

  it("模型不在名单里：没有这一级", () => {
    expect(workerPickRows(CATALOGS, ["claude", "gpt-x"], "")).toBeNull();
  });

  it("筛选", () => {
    expect(labels(workerPickRows(CATALOGS, ["claude", "opus"], "hi"))).toEqual(["High"]);
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

describe("workerPickFromArgs", () => {
  it("文字里的 id 换成 WorkerPick：default 和没选到的级是 null；第一级不是认识的厂商返回 null", () => {
    expect(workerPickFromArgs(["claude", "opus", "high"])).toEqual({ vendor: "claude", model: "opus", effort: "high" });
    expect(workerPickFromArgs(["claude", "opus", "Extra"], CATALOGS)).toEqual({ vendor: "claude", model: "opus", effort: "xhigh" });
    expect(workerPickFromArgs(["claude", WORKER_PICK_DEFAULT, WORKER_PICK_DEFAULT])).toEqual({ vendor: "claude", model: null, effort: null });
    expect(workerPickFromArgs(["claude", "haiku"])).toEqual({ vendor: "claude", model: "haiku", effort: null });
    expect(workerPickFromArgs(["nope", "x"])).toBeNull();
  });
});

describe("workerPickLabels", () => {
  it("厂商名、模型显示名、档位显示名；Default 的项不显示", () => {
    expect(workerPickLabels({ vendor: "claude", model: "opus", effort: "high" }, CATALOGS)).toEqual(["Claude Code", "Opus", "High"]);
    expect(workerPickLabels({ vendor: "claude", model: null, effort: "xhigh" }, CATALOGS)).toEqual(["Claude Code", "Extra"]);
    expect(workerPickLabels({ vendor: "claude", model: null, effort: null }, CATALOGS)).toEqual(["Claude Code"]);
  });

  it("名单里没有的模型原样显示；名单里没有这家用打包的名字", () => {
    expect(workerPickLabels({ vendor: "claude", model: "my-model", effort: null }, CATALOGS)).toEqual(["Claude Code", "my-model"]);
    expect(workerPickLabels({ vendor: "codex", model: "x1", effort: null }, [])).toEqual([bundledModelCatalog("codex").label, "x1"]);
  });
});
