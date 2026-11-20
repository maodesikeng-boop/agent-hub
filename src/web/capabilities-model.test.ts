import { describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  DEFAULT_AGENT_VENDOR,
  PM_CAPABILITY_PATCH_MAX_KEYS,
  applyCapabilitiesPatch,
  defaultCapabilityPolicy,
  vendorLabel,
  vendorSpec,
} from "../shared/index.ts";
import {
  CAPABILITY_KIND_ORDER,
  capabilitiesQueryKey,
  capabilityScopeOptions,
  capabilitySections,
  capabilityTotals,
  enforcementRows,
  filterCapabilitySections,
  kindPatches,
  rowsPatches,
} from "./capabilities-model.ts";
import { makeCapabilitiesView, makeCapabilityInventory, makePm } from "./test-utils.ts";

const inventory = makeCapabilityInventory();
const routerPolicy = defaultCapabilityPolicy("router");
const pmPolicy = defaultCapabilityPolicy("pm");

describe("能力页的范围条：总助在最前，只列没归档的项目经理", () => {
  it("总助固定第一，归档的项目经理不出现；同一份 pms 返回同一个数组", () => {
    const pms = [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "旧项目", archivedAt: 1_000 }), makePm({ id: 3, name: "小美" })];
    const options = capabilityScopeOptions(pms);
    expect(options.map((o) => o.key)).toEqual(["router", "pm:1", "pm:3"]);
    expect(options[0]).toMatchObject({ label: "Router", look: null, scope: { kind: "router" } });
    expect(options[1]).toMatchObject({ label: "小林", scope: { kind: "pm", pmId: 1 } });
    expect(capabilityScopeOptions(pms)).toBe(options);
    expect(capabilityScopeOptions([...pms])).not.toBe(options);
  });

  it("查询键按范围分开：总助和各项目经理互不串缓存", () => {
    expect(capabilitiesQueryKey({ kind: "router" })).toEqual(["capabilities", "router"]);
    expect(capabilitiesQueryKey({ kind: "pm", pmId: 7 })).toEqual(["capabilities", "pm:7"]);
  });
});

describe("按种类和来源分组", () => {
  it("种类固定 MCP、技能、连接器；组内项目在前、全局其次、插件再后；插件 MCP 去掉 plugin:<名>: 前缀", () => {
    const sections = capabilitySections(inventory, pmPolicy);
    expect(sections.map((s) => s.kind)).toEqual(CAPABILITY_KIND_ORDER);
    const [mcp, skill, connector] = sections;
    expect(mcp!.groups.map((g) => [g.label, g.detail])).toEqual([
      ["Global", null],
      ["design", `${vendorLabel(DEFAULT_AGENT_VENDOR)} plugin`],
    ]);
    expect(mcp!.groups[1]!.rows.map((r) => [r.key, r.name])).toEqual([["mcp:plugin:design:figma", "figma"]]);
    expect(skill!.groups.map((g) => [g.label, g.detail])).toEqual([
      ["demo", "Project"],
      ["Global", null],
    ]);
    expect(connector!.groups.map((g) => g.rows.map((r) => r.name))).toEqual([["Gmail"]]);
  });

  it("开关状态照策略算：总助默认全关，项目经理默认全开；单项覆盖只改那一项", () => {
    expect(capabilityTotals(capabilitySections(inventory, routerPolicy))).toEqual({ enabled: 0, total: 7 });
    expect(capabilityTotals(capabilitySections(inventory, pmPolicy))).toEqual({ enabled: 7, total: 7 });
    const custom = applyCapabilitiesPatch(routerPolicy, { set: { "mcp:playwright": true } });
    const [mcp] = capabilitySections(inventory, custom);
    expect(mcp!.enabled).toBe(1);
    expect(mcp!.groups[0]!.rows.find((r) => r.key === "mcp:playwright")!.enabled).toBe(true);
    expect(mcp!.groups[0]!.enabled).toBe(1);
  });

  it("清单和策略都没变就返回同一个引用；策略换了重算", () => {
    const first = capabilitySections(inventory, pmPolicy);
    expect(capabilitySections(inventory, pmPolicy)).toBe(first);
    const next = applyCapabilitiesPatch(pmPolicy, { base: { mcp: "none" } });
    expect(capabilitySections(inventory, next)).not.toBe(first);
    expect(capabilitySections(makeCapabilityInventory(), pmPolicy)).not.toBe(first);
  });

  it("清单里没有条目的组不显示，空种类保留（界面写“没找到”）", () => {
    const empty = makeCapabilityInventory({ items: [], groups: [{ id: "mcp:global", kind: "mcp", label: "Global", source: { kind: "global" }, itemKeys: ["mcp:gone"] }] });
    const sections = capabilitySections(empty, pmPolicy);
    expect(sections.map((s) => [s.kind, s.groups.length, s.total])).toEqual([
      ["mcp", 0, 0],
      ["skill", 0, 0],
      ["connector", 0, 0],
    ]);
  });
});

describe("搜索", () => {
  const sections = capabilitySections(inventory, pmPolicy);

  it("空白查询原样返回同一个数组", () => {
    expect(filterCapabilitySections(sections, "  ")).toBe(sections);
  });

  it("按名字、描述、键匹配；组名命中保留整组；没命中的种类整个去掉", () => {
    const byName = filterCapabilitySections(sections, "PLAY");
    expect(byName.map((s) => s.kind)).toEqual(["mcp"]);
    expect(byName[0]!.groups[0]!.rows.map((r) => r.key)).toEqual(["mcp:playwright"]);
    expect(byName[0]).toMatchObject({ total: 1, enabled: 1 });
    expect(filterCapabilitySections(sections, "smoke check")[0]!.groups[0]!.rows.map((r) => r.key)).toEqual(["skill:verify"]);
    expect(filterCapabilitySections(sections, "design")[0]!.groups.map((g) => g.label)).toEqual(["design"]);
    expect(filterCapabilitySections(sections, "nothing-matches")).toEqual([]);
  });
});

describe("开关请求体", () => {
  it("整类全开/全关：改这一类的 base，并清掉这一类已有的单项覆盖，别的类不碰", () => {
    const policy = applyCapabilitiesPatch(pmPolicy, { set: { "mcp:playwright": false, "skill:verify": false } });
    expect(kindPatches(policy, "mcp", false)).toEqual([{ base: { mcp: "none" }, set: { "mcp:playwright": null } }]);
    expect(kindPatches(pmPolicy, "skill", true)).toEqual([{ base: { skill: "all" } }]);
    expect(kindPatches(policy, "mcp", false).reduce(applyCapabilitiesPatch, policy).overrides).toEqual({ "skill:verify": false });
  });

  it("覆盖项超过单次上限时分批发，第一批带 base", () => {
    const keys = Array.from({ length: PM_CAPABILITY_PATCH_MAX_KEYS + 3 }, (_, i) => `skill:s${i}`);
    const policy = { base: pmPolicy.base, overrides: Object.fromEntries(keys.map((k) => [k, false])) };
    const patches = kindPatches(policy, "skill", true);
    expect(patches).toHaveLength(2);
    expect(patches[0]!.base).toEqual({ skill: "all" });
    expect(Object.keys(patches[0]!.set!)).toHaveLength(PM_CAPABILITY_PATCH_MAX_KEYS);
    expect(Object.keys(patches[1]!.set!)).toHaveLength(3);
  });

  it("整组开关只发状态要变的那几项；都已是目标状态就不发", () => {
    const [mcp] = capabilitySections(inventory, applyCapabilitiesPatch(routerPolicy, { set: { "mcp:linear": true } }));
    const rows = mcp!.groups[0]!.rows;
    expect(rowsPatches(rows, true)).toEqual([{ set: { "mcp:playwright": true } }]);
    expect(rowsPatches(rows.filter((r) => r.key === "mcp:linear"), true)).toEqual([]);
  });
});

describe("各家隔离粒度", () => {
  it("每家一行，跟 vendorSpec 声明一致；插件粒度只在和本类不同时单独标出；同一份数据返回同一个数组", () => {
    const view = makeCapabilitiesView({ kind: "router" });
    const rows = enforcementRows(view);
    expect(rows.map((r) => r.vendor)).toEqual([...AGENT_VENDORS]);
    for (const row of rows) {
      const spec = vendorSpec(row.vendor).capabilities;
      for (const kind of CAPABILITY_KIND_ORDER) {
        expect(row.cells[kind].isolation).toBe(spec.isolation[kind]);
        const plugin = spec.pluginIsolation?.[kind];
        expect(row.cells[kind].plugin).toBe(plugin !== undefined && plugin !== spec.isolation[kind] ? plugin : null);
      }
    }
    expect(enforcementRows(view)).toBe(rows);
  });
});
