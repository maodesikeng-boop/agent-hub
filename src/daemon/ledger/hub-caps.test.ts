import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatHubCapabilities, type HubCapsArgs, type HubCapsData } from "../../shared/hub-caps.ts";
import { HUB_CAPS_LIST_MAX } from "../../shared/limits.ts";
import { defaultCapabilityPolicy, type CapabilityInventory } from "../../shared/pm-capabilities.ts";
import { validateNoOuterSandboxRequest } from "../../shared/sandbox-approval.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/index.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function sampleInventory(extraCount = 0): CapabilityInventory {
  const items: CapabilityInventory["items"][number][] = [
    {
      key: "mcp:cua_repl",
      kind: "mcp",
      name: "cua_repl",
      description: "Desktop GUI control",
      groupId: "mcp:plugin:codex:computer-use@openai-bundled",
      vendors: ["codex"],
      plugins: { codex: "computer-use@openai-bundled" },
    },
    {
      key: "mcp:peekaboo",
      kind: "mcp",
      name: "peekaboo",
      description: "Screen capture",
      groupId: "mcp:global",
      vendors: ["claude", "codex"],
    },
    {
      key: "skill:verify",
      kind: "skill",
      name: "verify",
      description: "Smoke check",
      groupId: "skill:project:demo",
      vendors: [...AGENT_VENDORS],
    },
  ];
  for (let i = 0; i < extraCount; i++) {
    items.push({
      key: `skill:bulk-${String(i).padStart(3, "0")}`,
      kind: "skill",
      name: `bulk-${i}`,
      description: null,
      groupId: "skill:global",
      vendors: ["claude"],
    });
  }
  return { scannedAt: 10_000, items, groups: [], truncated: false };
}

let db: Db;
let root: string;
let dataHome: string;
let folder: string;
let ledger: SqliteLedger;
let pmId: number;
let sessionId: number;

function makeLedger(): SqliteLedger {
  return createLedger(db, {
    now: () => 20_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    workerPlatform: "darwin",
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
}

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "hub-caps-audit-")));
  dataHome = join(root, ".agent-hub");
  folder = join(root, "proj");
  mkdirSync(folder, { recursive: true });
  ledger = makeLedger();
  const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", folder, vendor: "codex" });
  pmId = created.pm.id;
  sessionId = created.sessionId;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("S4: read-only hub caps formatter, filtering, policy freshness, and bounds", () => {
  it("lists effective enabled/disabled state, filters by kind and vendor, and marks Computer Use keys", () => {
    const policy = {
      ...defaultCapabilityPolicy("pm"),
      overrides: { "mcp:peekaboo": false },
    };
    const inv = sampleInventory();
    const allArgs: HubCapsArgs = {};
    const all: { text: string; data: HubCapsData } = formatHubCapabilities(policy, inv, allArgs, "darwin");
    expect(all.data.items.find((i) => i.key === "mcp:peekaboo")?.enabled).toBe(false);
    expect(all.data.items.find((i) => i.key === "mcp:cua_repl")?.computerUseEligible).toBe(true);
    expect(all.text).toContain("mcp:cua_repl");
    expect(all.text).toContain("支持 --no-outer-sandbox");
    expect(all.text).toContain("mcp:peekaboo");
    expect(all.text).toContain("关闭");

    const mcpOnly = formatHubCapabilities(policy, inv, { kind: "mcp" }, "darwin");
    expect(mcpOnly.data.items.every((i) => i.kind === "mcp")).toBe(true);

    const claudeOnly = formatHubCapabilities(policy, inv, { vendor: "claude" }, "darwin");
    expect(claudeOnly.data.items.every((i) => i.vendors.includes("claude"))).toBe(true);
    expect(claudeOnly.data.items.some((i) => i.key === "mcp:cua_repl")).toBe(false);
  });

  it("caps large capability inventories at HUB_CAPS_LIST_MAX with an overflow hint", () => {
    const result = formatHubCapabilities(defaultCapabilityPolicy("pm"), sampleInventory(HUB_CAPS_LIST_MAX + 50), {}, "darwin");
    expect(result.data.items).toHaveLength(HUB_CAPS_LIST_MAX);
    expect(result.data.truncated).toBe(true);
    expect(result.text).toContain("另有");
    expect(result.text).toContain("--kind");
  });
});

describe("S5: hub graph show displays step execution flags without growing slim snapshots", () => {
  it("shows non-default caps, readonly, noOuterSandbox, and maxTime in graph show and survives restart", () => {
    const created = ledger.hubCall(sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "Cap visibility graph",
        steps: [
          { key: "inspect", title: "Inspect", readonly: true, caps: "none", maxTime: "45m" },
          {
            key: "gui",
            title: "Drive GUI",
            caps: "custom",
            allow: ["mcp:cua_repl"],
            noOuterSandbox: true,
          },
        ],
      }),
    });
    const graphId = created.data.graph.id;

    // Reopen ledger on the same SQLite database to verify persistence across restart.
    const reopened = makeLedger();
    const shown = reopened.hubCall(sessionId, "graph.show", { graphId });
    expect(shown.text).toContain("只读");
    expect(shown.text).toContain("none");
    expect(shown.text).toContain("45m");
    expect(shown.text).toContain("mcp:cua_repl");
    expect(shown.text).toContain("外层沙箱");

    const guiNode = shown.data.graph.nodes.find((n) => n.key === "gui");
    expect(guiNode?.capabilities).toEqual({ mode: "custom", allow: ["mcp:cua_repl"] });
    expect(guiNode?.noOuterSandbox).toBe(true);

    // Slim WebSocket snapshots omit detailed step capabilities and noOuterSandbox.
    const snapGraph = reopened.snapshot().activeTaskGraphs.find((g) => g.id === graphId);
    const snapGui = snapGraph?.nodes.find((n) => n.key === "gui");
    expect(snapGui?.capabilities).toBeUndefined();
    expect(snapGui?.noOuterSandbox).toBeUndefined();
  });

  it("handles corrupt step capability JSON safely as none without crashing", () => {
    const graphId = ledger.hubCall(sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "Dirty cap", steps: [{ key: "s1", title: "S1", caps: "none" }] }),
    }).data.graph.id;
    const stepId = db.get<{ id: number }>("SELECT id FROM task_graph_steps WHERE graph_id = ? AND node_key = 's1'", graphId)!.id;
    db.run("UPDATE task_graph_step_capabilities SET capabilities_json = '{broken' WHERE step_id = ?", stepId);

    const shown = ledger.hubCall(sessionId, "graph.show", { graphId });
    expect(shown.data.graph.nodes[0]?.capabilities).toEqual({ mode: "none" });
    expect(shown.text).toContain("none");
  });
});

describe("S6: actionable --no-outer-sandbox validation errors", () => {
  it("lists eligible capability keys and hub caps hint when Computer Use is not mounted", () => {
    const res = validateNoOuterSandboxRequest({
      vendor: "codex",
      platform: "darwin",
      readonly: false,
      review: false,
      workerCapabilities: { mode: "inherit" },
      pmPolicy: defaultCapabilityPolicy("pm"),
      inventory: sampleInventory(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("computer_use_not_mounted");
      expect(res.message).toContain("mcp:cua_repl");
      expect(res.message).toContain("--caps custom --allow");
      expect(res.message).toContain("hub caps");
    }
  });

  it("names disabled and uninstalled Computer Use keys when policy or installation blocks them", () => {
    const disabled = validateNoOuterSandboxRequest({
      vendor: "codex",
      platform: "darwin",
      readonly: false,
      review: false,
      workerCapabilities: { mode: "custom", allow: ["mcp:cua_repl"] },
      pmPolicy: { ...defaultCapabilityPolicy("pm"), overrides: { "mcp:cua_repl": false } },
      inventory: sampleInventory(),
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.code).toBe("computer_use_disabled_by_policy");
      expect(disabled.message).toContain("mcp:cua_repl");
      expect(disabled.message).toContain("hub caps");
    }

    const emptyInv: CapabilityInventory = { scannedAt: 10_000, items: [], groups: [], truncated: false };
    const missing = validateNoOuterSandboxRequest({
      vendor: "codex",
      platform: "darwin",
      readonly: false,
      review: false,
      workerCapabilities: { mode: "custom", allow: ["mcp:cua_repl"] },
      pmPolicy: defaultCapabilityPolicy("pm"),
      inventory: emptyInv,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("computer_use_not_installed");
      expect(missing.message).toContain("mcp:cua_repl");
    }
  });

  it("regression: rejects --no-outer-sandbox on non-macOS platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      const res = validateNoOuterSandboxRequest({
        vendor: "codex",
        platform,
        readonly: false,
        review: false,
        workerCapabilities: { mode: "custom", allow: ["mcp:cua_repl"] },
        pmPolicy: defaultCapabilityPolicy("pm"),
        inventory: sampleInventory(),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("platform_unsupported");
    }
    expect(pmId).toBeGreaterThan(0);
  });
});
