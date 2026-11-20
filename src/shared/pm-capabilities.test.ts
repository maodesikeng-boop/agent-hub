import { describe, expect, it } from "vitest";
import {
  applyCapabilitiesPatch,
  capabilityEnabled,
  capabilityKey,
  blockedWorkerCapabilities,
  defaultCapabilityPolicy,
  parseWorkerCapabilitiesJson,
  resolveSessionCapabilities,
  workerCapabilitiesJson,
  workerCapabilitiesOf,
  workerCapabilityPolicy,
  type CapabilityGroup,
  type CapabilityInventory,
  type CapabilityItem,
  type CapabilityPolicy,
} from "./pm-capabilities.ts";

function makeInventory(
  items: readonly CapabilityItem[],
  groups: readonly CapabilityGroup[] = [],
): CapabilityInventory {
  return {
    scannedAt: 1_000,
    items,
    groups,
    truncated: false,
  };
}

describe("capabilityEnabled", () => {
  it("有单独设置时用单独设置", () => {
    const policy: CapabilityPolicy = {
      base: { skill: "all", mcp: "none", connector: "all" },
      overrides: {
        "skill:aws-auth": false,
        "mcp:codegraph": true,
      },
    };
    expect(capabilityEnabled(policy, "skill:aws-auth")).toBe(false);
    expect(capabilityEnabled(policy, "mcp:codegraph")).toBe(true);
  });

  it("没有单独设置时按这一类的 base", () => {
    const policy: CapabilityPolicy = {
      base: { skill: "all", mcp: "none", connector: "none" },
      overrides: {},
    };
    expect(capabilityEnabled(policy, "skill:aws-auth")).toBe(true);
    expect(capabilityEnabled(policy, "mcp:codegraph")).toBe(false);
    expect(capabilityEnabled(policy, "connector:claude:claude.ai Gmail")).toBe(false);
  });
});

describe("applyCapabilitiesPatch", () => {
  it("不改入参，返回新 policy", () => {
    const baseObj = Object.freeze({ skill: "all" as const, mcp: "all" as const, connector: "all" as const });
    const overridesObj = Object.freeze({ "skill:a": false });
    const input: CapabilityPolicy = Object.freeze({ base: baseObj, overrides: overridesObj });

    const next = applyCapabilitiesPatch(input, { base: { mcp: "none" }, set: { "skill:b": false } });
    expect(next).not.toBe(input);
    expect(input).toEqual({
      base: { skill: "all", mcp: "all", connector: "all" },
      overrides: { "skill:a": false },
    });
    expect(next).toEqual({
      base: { skill: "all", mcp: "none", connector: "all" },
      overrides: { "skill:a": false, "skill:b": false },
    });
  });

  it("值和 base 相同的项从 overrides 去掉", () => {
    const first = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
      set: { "skill:aws-auth": false, "mcp:codegraph": false },
    });
    expect(first.overrides).toEqual({ "skill:aws-auth": false, "mcp:codegraph": false });

    const toggledBack = applyCapabilitiesPatch(first, {
      set: { "skill:aws-auth": true },
    });
    expect(toggledBack.overrides).toEqual({ "mcp:codegraph": false });
    expect("skill:aws-auth" in toggledBack.overrides).toBe(false);
  });

  it("set 给 null 去掉这一项的单独设置", () => {
    const policy: CapabilityPolicy = {
      base: { skill: "none", mcp: "all", connector: "all" },
      overrides: { "skill:aws-auth": true, "mcp:codegraph": false },
    };
    const next = applyCapabilitiesPatch(policy, { set: { "skill:aws-auth": null } });
    expect(next.overrides).toEqual({ "mcp:codegraph": false });
    expect(capabilityEnabled(next, "skill:aws-auth")).toBe(false);
  });

  it("改 base 时去掉和新 base 相同的已有单独设置", () => {
    const policy: CapabilityPolicy = {
      base: { skill: "all", mcp: "all", connector: "all" },
      overrides: { "skill:a": false, "skill:b": false, "mcp:codegraph": false },
    };
    const next = applyCapabilitiesPatch(policy, {
      base: { skill: "none" },
      set: { "skill:keep-on": true },
    });
    expect(next.base.skill).toBe("none");
    expect(next.overrides).toEqual({ "skill:keep-on": true, "mcp:codegraph": false });
  });
});

describe("resolveSessionCapabilities", () => {
  it("三类都是 all 且没有关掉的项时返回 null", () => {
    const inv = makeInventory([
      { key: "skill:aws-auth", kind: "skill", name: "aws-auth", description: "auth", groupId: "g", vendors: ["claude", "codex"], dir: "/s/aws-auth" },
      { key: "mcp:codegraph", kind: "mcp", name: "codegraph", description: null, groupId: "m", vendors: ["claude", "codex"] },
      { key: "connector:claude:claude.ai Gmail", kind: "connector", name: "Gmail", description: null, groupId: "c", vendors: ["claude"] },
    ]);
    expect(resolveSessionCapabilities(defaultCapabilityPolicy("pm"), inv, "claude")).toBeNull();
  });

  it("只算这家能看到的项", () => {
    const inv = makeInventory([
      { key: "skill:claude-only", kind: "skill", name: "claude-only", description: null, groupId: "g", vendors: ["claude"], dir: "/s/claude-only" },
      { key: "skill:shared", kind: "skill", name: "shared", description: null, groupId: "g", vendors: ["claude", "codex"], dir: "/s/shared" },
    ]);
    const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), { set: { "skill:claude-only": false } });
    expect(resolveSessionCapabilities(policy, inv, "codex")).toBeNull();
    const claudeCaps = resolveSessionCapabilities(policy, inv, "claude");
    expect(claudeCaps?.deny.skills).toEqual(["claude-only"]);
  });

  it("连接器只算这家自己账号上的", () => {
    const inv = makeInventory([
      { key: "connector:claude:claude.ai Gmail", kind: "connector", name: "Gmail", description: null, groupId: "cc", vendors: ["claude"] },
      { key: "connector:codex:connector_gmail", kind: "connector", name: "Gmail", description: null, groupId: "cx", vendors: ["codex"] },
    ]);
    const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
      set: {
        "connector:claude:claude.ai Gmail": false,
        "connector:codex:connector_gmail": false,
      },
    });
    expect(resolveSessionCapabilities(policy, inv, "claude")?.deny.connectors).toEqual(["claude.ai Gmail"]);
    expect(resolveSessionCapabilities(policy, inv, "codex")?.deny.connectors).toEqual(["connector_gmail"]);
  });

  it("插件里这家看到的项全关时进 deny.plugins，逐项照样列，pluginOf 记着插件编号", () => {
    const items: CapabilityItem[] = [
      { key: "skill:sales:call-prep", kind: "skill", name: "sales:call-prep", description: null, groupId: "p-skill", vendors: ["claude"], dir: "/p/call-prep", plugins: { claude: "sales@synced" } },
      { key: "mcp:plugin:sales:crm", kind: "mcp", name: "plugin:sales:crm", description: null, groupId: "p-mcp", vendors: ["claude"], plugins: { claude: "sales@synced" } },
      { key: "skill:global-one", kind: "skill", name: "global-one", description: null, groupId: "g-skill", vendors: ["claude"], dir: "/g/global-one" },
    ];
    const inv = makeInventory(items);

    const allPluginOff = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
      set: {
        "skill:sales:call-prep": false,
        "mcp:plugin:sales:crm": false,
      },
    });
    const resolvedAllOff = resolveSessionCapabilities(allPluginOff, inv, "claude");
    expect(resolvedAllOff?.deny.plugins).toEqual(["sales@synced"]);
    expect(resolvedAllOff?.deny.skills).toEqual(["sales:call-prep"]);
    expect(resolvedAllOff?.deny.mcp).toEqual(["plugin:sales:crm"]);
    expect(resolvedAllOff?.deny.pluginOf).toEqual({
      skills: { "sales:call-prep": "sales@synced" },
      mcp: { "plugin:sales:crm": "sales@synced" },
    });

    const partialOff = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
      set: { "skill:sales:call-prep": false },
    });
    const resolvedPartial = resolveSessionCapabilities(partialOff, inv, "claude");
    expect(resolvedPartial?.deny.plugins).toEqual([]);
    expect(resolvedPartial?.deny.skills).toEqual(["sales:call-prep"]);
    expect(resolvedPartial?.deny.pluginOf.skills).toEqual({ "sales:call-prep": "sales@synced" });
  });

  it("插件归属按厂商算，不看分组：同名技能归在 claude 的插件组里，codex 的插件只算 codex 自己从插件拿到的项", () => {
    const items: CapabilityItem[] = [
      { key: "skill:slack:slack-api", kind: "skill", name: "slack:slack-api", description: null, groupId: "skill:plugin:claude:slack@claude-plugins-official", vendors: ["claude", "codex"], dir: "/c/slack-api", plugins: { claude: "slack@claude-plugins-official", codex: "slack@claude-plugins-official" } },
      { key: "mcp:slack", kind: "mcp", name: "slack", description: null, groupId: "mcp:plugin:codex:slack@claude-plugins-official", vendors: ["codex"], plugins: { codex: "slack@claude-plugins-official" } },
      { key: "mcp:codegraph", kind: "mcp", name: "codegraph", description: null, groupId: "mcp:global", vendors: ["claude", "codex"] },
    ];
    const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), { set: { "mcp:slack": false } });
    const codex = resolveSessionCapabilities(policy, makeInventory(items), "codex");
    expect(codex?.deny.plugins).toEqual([]);
    expect(codex?.deny.mcp).toEqual(["slack"]);
    expect(codex?.deny.pluginOf).toEqual({ skills: {}, mcp: { slack: "slack@claude-plugins-official" } });
    expect(resolveSessionCapabilities(policy, makeInventory(items), "claude")).toBeNull();
  });

  it("allow.skills 是开着的技能及其目录", () => {
    const inv = makeInventory([
      { key: "skill:b", kind: "skill", name: "b", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/b" },
      { key: "skill:a", kind: "skill", name: "a", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/a" },
      { key: "skill:off", kind: "skill", name: "off", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/off" },
    ]);
    const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), { set: { "skill:off": false } });
    const caps = resolveSessionCapabilities(policy, inv, "pi");
    expect(caps?.allow.skills).toEqual([
      { name: "a", dir: "/skills/a" },
      { name: "b", dir: "/skills/b" },
    ]);
  });

  it("deny、allow 按名字排序，同样的输入结果逐字相同", () => {
    const itemsA: CapabilityItem[] = [
      { key: "skill:z-off", kind: "skill", name: "z-off", description: null, groupId: "g", vendors: ["claude"], dir: "/s/z" },
      { key: "skill:a-off", kind: "skill", name: "a-off", description: null, groupId: "g", vendors: ["claude"], dir: "/s/a" },
      { key: "skill:m-on", kind: "skill", name: "m-on", description: null, groupId: "g", vendors: ["claude"], dir: "/s/m" },
      { key: "skill:b-on", kind: "skill", name: "b-on", description: null, groupId: "g", vendors: ["claude"], dir: "/s/b" },
      { key: "mcp:z-mcp", kind: "mcp", name: "z-mcp", description: null, groupId: "m", vendors: ["claude"] },
      { key: "mcp:a-mcp", kind: "mcp", name: "a-mcp", description: null, groupId: "m", vendors: ["claude"] },
      { key: "mcp:keep-mcp", kind: "mcp", name: "keep-mcp", description: null, groupId: "m", vendors: ["claude"] },
      { key: "connector:claude:z-conn", kind: "connector", name: "Z", description: null, groupId: "c", vendors: ["claude"] },
      { key: "connector:claude:a-conn", kind: "connector", name: "A", description: null, groupId: "c", vendors: ["claude"] },
    ];
    const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
      set: {
        "skill:z-off": false,
        "skill:a-off": false,
        "mcp:z-mcp": false,
        "mcp:a-mcp": false,
        "connector:claude:z-conn": false,
        "connector:claude:a-conn": false,
      },
    });
    const res1 = resolveSessionCapabilities(policy, makeInventory(itemsA), "claude");
    const res2 = resolveSessionCapabilities(policy, makeInventory([...itemsA].reverse()), "claude");
    expect(res1).toEqual({
      deny: {
        skills: ["a-off", "z-off"],
        mcp: ["a-mcp", "z-mcp"],
        connectors: ["a-conn", "z-conn"],
        plugins: [],
        pluginOf: { skills: {}, mcp: {} },
      },
      allow: {
        skills: [
          { name: "b-on", dir: "/s/b" },
          { name: "m-on", dir: "/s/m" },
        ],
        mcp: ["keep-mcp"],
      },
    });
    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
  });
});

describe("capabilityKey", () => {
  it("连接器的键带厂商编号，技能和 MCP 不带", () => {
    expect(capabilityKey("skill", "aws-auth", "claude")).toBe("skill:aws-auth");
    expect(capabilityKey("mcp", "codegraph", "codex")).toBe("mcp:codegraph");
    expect(capabilityKey("connector", "connector_openai_chatgpt_pets", "codex")).toBe(
      "connector:codex:connector_openai_chatgpt_pets",
    );
    expect(() => capabilityKey("connector", "x")).toThrow();
  });
});

describe("总助与 Worker 三档", () => {
  it("总助默认三类全关，项目经理默认全开", () => {
    expect(defaultCapabilityPolicy("router")).toEqual({ base: { skill: "none", mcp: "none", connector: "none" }, overrides: {} });
    expect(defaultCapabilityPolicy("pm")).toEqual({ base: { skill: "all", mcp: "all", connector: "all" }, overrides: {} });
  });

  it("workerCapabilitiesOf：校验档位与点名，custom 去重排序", () => {
    expect(workerCapabilitiesOf(undefined, undefined)).toEqual({ mode: "inherit" });
    expect(workerCapabilitiesOf("none", undefined)).toEqual({ mode: "none" });
    expect(workerCapabilitiesOf("custom", ["mcp:b", "skill:a", "mcp:b"])).toEqual({ mode: "custom", allow: ["mcp:b", "skill:a"] });
    expect(workerCapabilitiesOf("custom", ["connector:claude:gmail"])).toEqual({ mode: "custom", allow: ["connector:claude:gmail"] });
    for (const [mode, allow] of [
      ["custom", undefined],
      ["custom", []],
      ["custom", ["nope"]],
      ["custom", [42]],
      ["none", ["mcp:x"]],
      [undefined, ["mcp:x"]],
      ["full", undefined],
      ["custom", Array.from({ length: 65 }, (_, i) => `mcp:m${i}`)],
    ] as const) {
      expect(workerCapabilitiesOf(mode, allow)).toHaveProperty("error");
    }
  });

  it("存取 JSON：继承不落行；读到坏行收窄成 none，绝不放宽", () => {
    expect(workerCapabilitiesJson({ mode: "inherit" })).toBeNull();
    const custom = { mode: "custom", allow: ["mcp:x"] } as const;
    expect(parseWorkerCapabilitiesJson(workerCapabilitiesJson(custom))).toEqual(custom);
    expect(parseWorkerCapabilitiesJson(null)).toEqual({ mode: "inherit" });
    for (const bad of ["{", "null", "{\"mode\":\"custom\"}", "{\"allow\":[\"mcp:x\"]}"]) {
      expect(parseWorkerCapabilitiesJson(bad).mode).not.toBe("inherit");
    }
  });

  it("workerCapabilityPolicy：inherit 原样返回项目策略，none 全关，custom 只开点名且项目里开着的", () => {
    const project = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), { set: { "mcp:off": false } });
    expect(workerCapabilityPolicy(project, { mode: "inherit" })).toBe(project);
    const none = workerCapabilityPolicy(project, { mode: "none" });
    expect(capabilityEnabled(none, "mcp:on")).toBe(false);
    expect(capabilityEnabled(none, "skill:any")).toBe(false);
    const custom = workerCapabilityPolicy(project, { mode: "custom", allow: ["mcp:off", "mcp:on"] });
    expect(capabilityEnabled(custom, "mcp:on")).toBe(true);
    expect(capabilityEnabled(custom, "mcp:off")).toBe(false);
    expect(capabilityEnabled(custom, "mcp:other")).toBe(false);
    expect(blockedWorkerCapabilities(project, { mode: "custom", allow: ["mcp:off", "mcp:on"] })).toEqual(["mcp:off"]);
    const routerLike = workerCapabilityPolicy(defaultCapabilityPolicy("router"), { mode: "custom", allow: ["mcp:on"] });
    expect(capabilityEnabled(routerLike, "mcp:on")).toBe(false);
  });
});
