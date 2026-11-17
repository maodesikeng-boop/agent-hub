import { describe, expect, it } from "vitest";
import {
  applyCapabilitiesPatch,
  capabilityEnabled,
  capabilityKey,
  defaultPmCapabilityPolicy,
  resolveSessionCapabilities,
  type CapabilityGroup,
  type CapabilityInventory,
  type CapabilityItem,
  type PmCapabilityPolicy,
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
    const policy: PmCapabilityPolicy = {
      pmId: 1,
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
    const policy: PmCapabilityPolicy = {
      pmId: 1,
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
    const input: PmCapabilityPolicy = Object.freeze({ pmId: 2, base: baseObj, overrides: overridesObj });

    const next = applyCapabilitiesPatch(input, { base: { mcp: "none" }, set: { "skill:b": false } });
    expect(next).not.toBe(input);
    expect(input).toEqual({
      pmId: 2,
      base: { skill: "all", mcp: "all", connector: "all" },
      overrides: { "skill:a": false },
    });
    expect(next).toEqual({
      pmId: 2,
      base: { skill: "all", mcp: "none", connector: "all" },
      overrides: { "skill:a": false, "skill:b": false },
    });
  });

  it("值和 base 相同的项从 overrides 去掉", () => {
    const first = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), {
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
    const policy: PmCapabilityPolicy = {
      pmId: 1,
      base: { skill: "none", mcp: "all", connector: "all" },
      overrides: { "skill:aws-auth": true, "mcp:codegraph": false },
    };
    const next = applyCapabilitiesPatch(policy, { set: { "skill:aws-auth": null } });
    expect(next.overrides).toEqual({ "mcp:codegraph": false });
    expect(capabilityEnabled(next, "skill:aws-auth")).toBe(false);
  });

  it("改 base 时去掉和新 base 相同的已有单独设置", () => {
    const policy: PmCapabilityPolicy = {
      pmId: 1,
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
    expect(resolveSessionCapabilities(defaultPmCapabilityPolicy(1), inv, "claude")).toBeNull();
  });

  it("只算这家能看到的项", () => {
    const inv = makeInventory([
      { key: "skill:claude-only", kind: "skill", name: "claude-only", description: null, groupId: "g", vendors: ["claude"], dir: "/s/claude-only" },
      { key: "skill:shared", kind: "skill", name: "shared", description: null, groupId: "g", vendors: ["claude", "codex"], dir: "/s/shared" },
    ]);
    const policy = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), { set: { "skill:claude-only": false } });
    expect(resolveSessionCapabilities(policy, inv, "codex")).toBeNull();
    const claudeCaps = resolveSessionCapabilities(policy, inv, "claude");
    expect(claudeCaps?.deny.skills).toEqual(["claude-only"]);
  });

  it("连接器只算这家自己账号上的", () => {
    const inv = makeInventory([
      { key: "connector:claude:claude.ai Gmail", kind: "connector", name: "Gmail", description: null, groupId: "cc", vendors: ["claude"] },
      { key: "connector:codex:connector_gmail", kind: "connector", name: "Gmail", description: null, groupId: "cx", vendors: ["codex"] },
    ]);
    const policy = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), {
      set: {
        "connector:claude:claude.ai Gmail": false,
        "connector:codex:connector_gmail": false,
      },
    });
    expect(resolveSessionCapabilities(policy, inv, "claude")?.deny.connectors).toEqual(["claude.ai Gmail"]);
    expect(resolveSessionCapabilities(policy, inv, "codex")?.deny.connectors).toEqual(["connector_gmail"]);
  });

  it("插件里的项全关时进 deny.plugins，不再逐项列", () => {
    const items: CapabilityItem[] = [
      { key: "skill:sales:call-prep", kind: "skill", name: "sales:call-prep", description: null, groupId: "p-skill", vendors: ["claude"], dir: "/p/call-prep" },
      { key: "mcp:plugin:sales:crm", kind: "mcp", name: "plugin:sales:crm", description: null, groupId: "p-mcp", vendors: ["claude"] },
      { key: "skill:global-one", kind: "skill", name: "global-one", description: null, groupId: "g-skill", vendors: ["claude"], dir: "/g/global-one" },
    ];
    const groups: CapabilityGroup[] = [
      {
        id: "p-skill",
        kind: "skill",
        label: "sales",
        source: { kind: "plugin", vendor: "claude", plugin: "sales@synced" },
        itemKeys: ["skill:sales:call-prep"],
      },
      {
        id: "p-mcp",
        kind: "mcp",
        label: "sales",
        source: { kind: "plugin", vendor: "claude", plugin: "sales@synced" },
        itemKeys: ["mcp:plugin:sales:crm"],
      },
    ];
    const inv = makeInventory(items, groups);

    const allPluginOff = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), {
      set: {
        "skill:sales:call-prep": false,
        "mcp:plugin:sales:crm": false,
      },
    });
    const resolvedAllOff = resolveSessionCapabilities(allPluginOff, inv, "claude");
    expect(resolvedAllOff?.deny.plugins).toEqual(["sales@synced"]);
    expect(resolvedAllOff?.deny.skills).toEqual([]);
    expect(resolvedAllOff?.deny.mcp).toEqual([]);

    const partialOff = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), {
      set: { "skill:sales:call-prep": false },
    });
    const resolvedPartial = resolveSessionCapabilities(partialOff, inv, "claude");
    expect(resolvedPartial?.deny.plugins).toEqual([]);
    expect(resolvedPartial?.deny.skills).toEqual(["sales:call-prep"]);
  });

  it("allow.skills 是开着的技能及其目录", () => {
    const inv = makeInventory([
      { key: "skill:b", kind: "skill", name: "b", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/b" },
      { key: "skill:a", kind: "skill", name: "a", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/a" },
      { key: "skill:off", kind: "skill", name: "off", description: null, groupId: "g", vendors: ["pi"], dir: "/skills/off" },
    ]);
    const policy = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), { set: { "skill:off": false } });
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
    const policy = applyCapabilitiesPatch(defaultPmCapabilityPolicy(1), {
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
