import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  DEFAULT_AGENT_VENDOR,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  applyCapabilitiesPatch,
  defaultCapabilityPolicy,
  vendorLabel,
  type CapabilityInventory,
} from "../shared/index.ts";
import {
  capabilitiesQueryKey,
  capabilityCustomized,
  capabilityProjectOptions,
  capabilitySections,
  capabilityTotals,
  filterCapabilitySections,
  patchedView,
  resetView,
  rowsPatches,
} from "./capabilities-model.ts";
import { makeCapabilitiesView, makeCapabilityInventory, makePm } from "./test-utils.ts";

const vendor = DEFAULT_AGENT_VENDOR;
const other = AGENT_VENDORS.find((v) => v !== vendor)!;
const defaultsView = makeCapabilitiesView({ kind: "default" });
const routerView = makeCapabilitiesView({ kind: "router" });
const pmView = makeCapabilitiesView({ kind: "pm", pmId: 1 });

const shape = (view: Parameters<typeof capabilitySections>[0], lead: Parameters<typeof capabilitySections>[1] = null) =>
  capabilitySections(view, lead).map((s) => [s.label, s.secondary, s.units.map((u) => `${u.label}${u.single ? "" : `(${u.rows.map((r) => `${r.kind}:${r.name}`).join(",")})`}`)]);

describe("范围：Project defaults、总助、各项目", () => {
  it("项目选择器只列没归档的项目经理，带史莱姆和厂商；同一份 pms 返回同一个数组", () => {
    const pms = [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "旧项目", archivedAt: 1_000 }), makePm({ id: 3, name: "小美", vendor: other })];
    const options = capabilityProjectOptions(pms);
    expect(options.map((o) => [o.pmId, o.label, o.vendor])).toEqual([
      [1, "小林", vendor],
      [3, "小美", other],
    ]);
    expect(capabilityProjectOptions(pms)).toBe(options);
    expect(capabilityProjectOptions([...pms])).not.toBe(options);
  });

  it("查询键按范围分开：Project defaults、总助和各项目互不串缓存", () => {
    expect(capabilitiesQueryKey({ kind: "default" })).toEqual(["capabilities", "default"]);
    expect(capabilitiesQueryKey({ kind: "router" })).toEqual(["capabilities", "router"]);
    expect(capabilitiesQueryKey({ kind: "pm", pmId: 7 })).toEqual(["capabilities", "pm:7"]);
  });
});

describe("按项目和插件归拢：谁能用一眼看清", () => {
  it("分区依次是 This project、Shared、各家专属；插件的 MCP 和技能合成一行，独立 MCP 单独露出", () => {
    expect(shape(pmView)).toEqual([
      ["This project", false, ["Skills(skill:frontend-rules)"]],
      ["Shared", false, ["linear", "node_repl", "playwright", "Skills(skill:unslop,skill:verify)"]],
      [vendorLabel(vendor), false, ["design(mcp:figma,skill:critique)", "Apps(connector:Gmail)"]],
      [vendorLabel(other), false, ["sheets(skill:build)"]],
    ]);
  });

  it("看具体项目时它的厂商专属区排在 Shared 后面，别家的专属区收起", () => {
    expect(shape(pmView, other).map(([label, secondary]) => [label, secondary])).toEqual([
      ["This project", false],
      ["Shared", false],
      [vendorLabel(other), false],
      [vendorLabel(vendor), true],
    ]);
  });

  it("共用区里只有部分厂商能用的，标出是哪几家；全都能用的不标", () => {
    const shared = capabilitySections(defaultsView).find((s) => s.id === "shared")!;
    const audience = Object.fromEntries(shared.units.map((u) => [u.label, u.audience]));
    expect(audience).toEqual({ linear: null, node_repl: [vendor, other], playwright: null, Skills: null });
  });

  it("两家共用同一插件的技能放进 Shared，单家的 MCP 留在那家；不会把共用的标成一家独有", () => {
    const base = makeCapabilityInventory();
    const inventory: CapabilityInventory = {
      ...base,
      items: [
        ...base.items,
        { key: "skill:slack:summarize", kind: "skill", name: "slack:summarize", description: null, groupId: `skill:plugin:${vendor}:slack`, vendors: [vendor, other] },
        { key: "mcp:plugin:slack:slack", kind: "mcp", name: "plugin:slack:slack", description: null, groupId: `mcp:plugin:${vendor}:slack`, vendors: [vendor] },
      ],
      groups: [
        ...base.groups,
        { id: `skill:plugin:${vendor}:slack`, kind: "skill", label: "slack", source: { kind: "plugin", vendor, plugin: "slack@official" }, itemKeys: ["skill:slack:summarize"] },
        { id: `mcp:plugin:${vendor}:slack`, kind: "mcp", label: "slack", source: { kind: "plugin", vendor, plugin: "slack@official" }, itemKeys: ["mcp:plugin:slack:slack"] },
      ],
    };
    const sections = capabilitySections(makeCapabilitiesView({ kind: "default" }, { inventory }));
    const unitIn = (id: string, label: string) => sections.find((s) => s.id === id)!.units.find((u) => u.label === label)!;
    expect(unitIn("shared", "slack").rows.map((r) => r.name)).toEqual(["summarize"]);
    expect(unitIn("shared", "slack").audience).toEqual([vendor, other]);
    expect(unitIn(`vendor:${vendor}`, "slack").rows.map((r) => [r.kind, r.name])).toEqual([["mcp", "slack"]]);
  });

  it("开关状态和计数照生效选择算：Project defaults 全开、总助全关", () => {
    expect(capabilityTotals(capabilitySections(defaultsView))).toEqual({ enabled: 10, total: 10, pinned: 0 });
    expect(capabilityTotals(capabilitySections(routerView))).toEqual({ enabled: 0, total: 10, pinned: 0 });
    const view = makeCapabilitiesView({ kind: "router" }, { policy: applyCapabilitiesPatch(defaultCapabilityPolicy("router"), { set: { "mcp:plugin:design:figma": true } }) });
    const design = capabilitySections(view).flatMap((s) => s.units).find((u) => u.label === "design")!;
    expect(design).toMatchObject({ enabled: 1, pinned: 0 });
  });

  it("项目的特例：拨过的项和它所在的插件行都标出来，计数跟着变", () => {
    const view = patchedView(pmView, { set: { "skill:design:critique": false, "mcp:playwright": false } });
    const sections = capabilitySections(view);
    expect(capabilityTotals(sections)).toEqual({ enabled: 8, total: 10, pinned: 2 });
    const design = sections.flatMap((s) => s.units).find((u) => u.label === "design")!;
    expect(design.rows.map((r) => [r.name, r.enabled, r.pinned])).toEqual([
      ["figma", true, false],
      ["critique", false, true],
    ]);
    expect(capabilityCustomized(view)).toBe(true);
    expect(capabilityCustomized(resetView(view))).toBe(false);
    expect(capabilityTotals(capabilitySections(resetView(view)))).toEqual({ enabled: 10, total: 10, pinned: 0 });
  });

  it("拨回和 Project defaults 一样的值就不再算特例", () => {
    const defaults = applyCapabilitiesPatch(defaultCapabilityPolicy("default"), { set: { "mcp:linear": false } });
    const view = makeCapabilitiesView({ kind: "pm", pmId: 1 }, { defaults });
    const on = patchedView(view, { set: { "mcp:linear": true } });
    expect(on.inheritance?.layer.overrides).toEqual({ "mcp:linear": true });
    const back = patchedView(on, { set: { "mcp:linear": false } });
    expect(capabilityCustomized(back)).toBe(false);
  });

  it("同一份视图返回同一个引用；换了视图重算，清单没变时布局复用", () => {
    const first = capabilitySections(pmView, vendor);
    expect(capabilitySections(pmView, vendor)).toBe(first);
    expect(capabilitySections(pmView, other)).not.toBe(first);
    const toggled = patchedView(pmView, { set: { "mcp:linear": false } });
    expect(capabilitySections(toggled, vendor)).not.toBe(first);
  });

  it("清单里找不到的条目不显示；没有条目的分区不出现", () => {
    const empty = makeCapabilityInventory({ items: [], groups: [{ id: "mcp:global", kind: "mcp", label: "Global", source: { kind: "global" }, itemKeys: ["mcp:gone"] }] });
    expect(capabilitySections(makeCapabilitiesView({ kind: "default" }, { inventory: empty }))).toEqual([]);
  });
});

describe("搜索", () => {
  const sections = capabilitySections(pmView);

  it("空白查询原样返回同一个数组", () => {
    expect(filterCapabilitySections(sections, "  ")).toBe(sections);
  });

  it("按名字、描述、键匹配；插件名命中保留整行；没命中的分区整个去掉", () => {
    const byName = filterCapabilitySections(sections, "PLAY");
    expect(byName.map((s) => s.label)).toEqual(["Shared"]);
    expect(byName[0]!.units.map((u) => u.label)).toEqual(["playwright"]);
    expect(byName[0]).toMatchObject({ total: 1, enabled: 1 });
    expect(filterCapabilitySections(sections, "smoke check")[0]!.units[0]!.rows.map((r) => r.key)).toEqual(["skill:verify"]);
    const design = filterCapabilitySections(sections, "design");
    expect(design.flatMap((s) => s.units.map((u) => [u.label, u.rows.length]))).toEqual([["design", 2]]);
    expect(filterCapabilitySections(sections, "nothing-matches")).toEqual([]);
  });
});

describe("开关请求体", () => {
  it("整行开关只发状态要变的那几项；都已是目标状态就不发", () => {
    const view = makeCapabilitiesView({ kind: "router" }, { policy: applyCapabilitiesPatch(defaultCapabilityPolicy("router"), { set: { "mcp:plugin:design:figma": true } }) });
    const design = capabilitySections(view).flatMap((s) => s.units).find((u) => u.label === "design")!;
    expect(rowsPatches(design.rows, true)).toEqual([{ set: { "skill:design:critique": true } }]);
    expect(rowsPatches(design.rows.filter((r) => r.enabled), true)).toEqual([]);
  });

  it("超过单次上限时分批发", () => {
    const rows = Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS + 3 }, (_, i) => ({ key: `skill:s${i}`, kind: "skill" as const, name: `s${i}`, description: null, enabled: false, pinned: false, audience: null }));
    const patches = rowsPatches(rows, true);
    expect(patches.map((p) => Object.keys(p.set).length)).toEqual([PM_CAPABILITY_PATCH_MAX_KEYS, 3]);
  });
});
