import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubPath } from "../../shared/hub.ts";
import { formatHubCapabilities, type HubCapsArgs, type HubCapsData } from "../../shared/hub-caps.ts";
import { HUB_CAPS_LIST_MAX } from "../../shared/limits.ts";
import { defaultCapabilityPolicy, type CapabilityInventory } from "../../shared/pm-capabilities.ts";
import { validateNoOuterSandboxRequest } from "../../shared/sandbox-approval.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
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

describe("S6 regression: agent-api preloads capabilityInventory consistently for worker.start, graph.create, graph.patch, and auto-dispatch", () => {
  async function createApiHarness(initialInventory: CapabilityInventory) {
    let currentInventory = initialInventory;
    const getInventory = vi.fn(async () => currentInventory);
    const tokens = createSessionTokens();
    const token = tokens.issue(sessionId);
    const app = createAgentApi({
      ledger,
      tokens,
      probeWorkspace: async () => ({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false }),
      capabilityInventory: { get: getInventory },
    });
    await app.ready();
    const post = (command: Parameters<typeof hubPath>[0], payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: hubPath(command),
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    return {
      app,
      getInventory,
      setInventory: (next: CapabilityInventory) => { currentInventory = next; },
      post,
    };
  }

  it("rejects uninstalled Computer Use keys consistently across worker.start, graph.create, and graph.patch", async () => {
    const emptyInv: CapabilityInventory = { scannedAt: 10_000, items: [], groups: [], truncated: false };
    const api = await createApiHarness(emptyInv);
    try {
      const workerRes = await api.post("worker.start", {
        title: "W",
        task: "Drive GUI",
        vendor: "codex",
        noWorktree: true,
        noOuterSandbox: true,
        caps: "custom",
        allow: ["mcp:cua_repl"],
      });
      expect(workerRes.statusCode).toBe(400);
      expect(workerRes.json()).toMatchObject({ ok: false, code: "invalid" });
      expect(workerRes.body).toContain("没有安装");
      expect(workerRes.body).toContain("mcp:cua_repl");
      expect(workerRes.body).toContain("hub caps");

      const createRes = await api.post("graph.create", {
        specJson: JSON.stringify({
          title: "Uninstalled CUA",
          steps: [
            { key: "gui", title: "GUI", brief: "Do GUI", vendor: "codex", caps: "custom", allow: ["mcp:cua_repl"], noOuterSandbox: true },
          ],
        }),
      });
      expect(createRes.statusCode).toBe(400);
      expect(createRes.json()).toMatchObject({ ok: false, code: "invalid" });
      expect(createRes.body).toContain("没有安装");
      expect(createRes.body).toContain("mcp:cua_repl");
      expect(createRes.body).toContain("hub caps");
      expect(ledger.snapshot().activeTaskGraphs).toHaveLength(0);
      expect(ledger.snapshot().pendingSandboxApprovals ?? []).toHaveLength(0);

      // Plain graph creation without noOuterSandbox does not scan capabilityInventory.
      api.getInventory.mockClear();
      const plainRes = await api.post("graph.create", {
        specJson: JSON.stringify({
          title: "Plain graph",
          steps: [{ key: "s1", title: "Step 1" }],
        }),
      });
      expect(plainRes.statusCode).toBe(200);
      expect(api.getInventory).not.toHaveBeenCalled();
      const graphId = (plainRes.json() as { data: { graph: { id: number } } }).data.graph.id;

      // graph.patch adding a noOuterSandbox step also rejects uninstalled capability.
      const patchAddRes = await api.post("graph.patch", {
        graphId,
        specJson: JSON.stringify({
          addSteps: [
            { key: "gui", title: "GUI", brief: "Do GUI", vendor: "codex", caps: "custom", allow: ["mcp:cua_repl"], noOuterSandbox: true },
          ],
        }),
      });
      expect(patchAddRes.statusCode).toBe(400);
      expect(patchAddRes.json()).toMatchObject({ ok: false, code: "invalid" });
      expect(patchAddRes.body).toContain("没有安装");
      expect(patchAddRes.body).toContain("mcp:cua_repl");

      // graph.patch updating an existing step to noOuterSandbox also rejects uninstalled capability.
      const patchUpdateRes = await api.post("graph.patch", {
        graphId,
        specJson: JSON.stringify({
          updateSteps: [
            { key: "s1", vendor: "codex", caps: "custom", allow: ["mcp:cua_repl"], noOuterSandbox: true },
          ],
        }),
      });
      expect(patchUpdateRes.statusCode).toBe(400);
      expect(patchUpdateRes.json()).toMatchObject({ ok: false, code: "invalid" });
      expect(patchUpdateRes.body).toContain("没有安装");
      expect(patchUpdateRes.body).toContain("mcp:cua_repl");
    } finally {
      await api.app.close();
    }
  });

  it("accepts dynamic computerUsePlugins keys in graph.create/graph.patch and re-validates on graph.done auto-dispatch", async () => {
    const pluginInv: CapabilityInventory = {
      scannedAt: 10_000,
      items: [
        {
          key: "mcp:unified_cua",
          kind: "mcp",
          name: "unified_cua",
          description: "Dynamic bundled CUA",
          groupId: "mcp:plugin:codex:unified-computer-use@openai-bundled",
          vendors: ["codex"],
          plugins: { codex: "unified-computer-use@openai-bundled" },
        },
      ],
      groups: [],
      truncated: false,
    };
    const api = await createApiHarness(pluginInv);
    try {
      const createRes = await api.post("graph.create", {
        specJson: JSON.stringify({
          title: "Dynamic plugin CUA",
          steps: [
            { key: "prep", title: "Prep" },
            {
              key: "gui",
              title: "GUI",
              deps: ["prep"],
              brief: "Do GUI",
              vendor: "codex",
              caps: "custom",
              allow: ["mcp:unified_cua"],
              noOuterSandbox: true,
            },
          ],
        }),
      });
      expect(createRes.statusCode).toBe(200);
      const graphId = (createRes.json() as { data: { graph: { id: number } } }).data.graph.id;

      // Patching another attribute on an existing noOuterSandbox step still sees the dynamic plugin key.
      const patchRes = await api.post("graph.patch", {
        graphId,
        specJson: JSON.stringify({
          updateSteps: [{ key: "gui", title: "GUI updated" }],
        }),
      });
      expect(patchRes.statusCode).toBe(200);

      // Uninstall the plugin before prep finishes: auto-dispatch via graph.done must not hang a broken sandbox card.
      api.setInventory({ scannedAt: 20_000, items: [], groups: [], truncated: false });
      const doneRes = await api.post("graph.done", { graphId, nodeKey: "prep" });
      expect(doneRes.statusCode).toBe(200);
      expect(doneRes.body).toContain("自动开工未成功");
      expect(ledger.snapshot().pendingSandboxApprovals ?? []).toHaveLength(0);
      const shown = ledger.hubCall(sessionId, "graph.show", { graphId }).data.graph;
      expect(shown.nodes.find((n) => n.key === "gui")).toMatchObject({ status: "waiting", waitingFor: "pm", activeWorkerId: null });

      // Same for a static Computer Use key uninstalled between graph.create and graph.done auto-dispatch.
      api.setInventory(sampleInventory());
      const g2Res = await api.post("graph.create", {
        specJson: JSON.stringify({
          title: "Static CUA uninstall before dispatch",
          steps: [
            { key: "prep", title: "Prep" },
            {
              key: "gui",
              title: "GUI",
              deps: ["prep"],
              brief: "Do GUI",
              vendor: "codex",
              caps: "custom",
              allow: ["mcp:cua_repl"],
              noOuterSandbox: true,
            },
          ],
        }),
      });
      expect(g2Res.statusCode).toBe(200);
      const g2Id = (g2Res.json() as { data: { graph: { id: number } } }).data.graph.id;
      api.setInventory({ scannedAt: 30_000, items: [], groups: [], truncated: false });
      const done2Res = await api.post("graph.done", { graphId: g2Id, nodeKey: "prep" });
      expect(done2Res.statusCode).toBe(200);
      expect(done2Res.body).toContain("没有安装");
      expect(done2Res.body).toContain("mcp:cua_repl");
      expect(ledger.snapshot().pendingSandboxApprovals ?? []).toHaveLength(0);
    } finally {
      await api.app.close();
    }
  });
});
