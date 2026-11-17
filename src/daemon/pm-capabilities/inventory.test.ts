import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PM_CAPABILITY_INVENTORY_MAX_ITEMS,
  PM_CAPABILITY_INVENTORY_RETRY_MS,
  PM_CAPABILITY_INVENTORY_TTL_MS,
} from "../../shared/limits.ts";
import { claudeSyncAdapter } from "../../vendors/claude/sync.ts";
import type { VendorCapabilityScan, VendorSyncAdapter } from "../../vendors/daemon-types.ts";
import { createCapabilityInventory } from "./inventory.ts";

let root: string;
let userHome: string;
let now: number;

function writeSkill(baseDir: string, name: string, description = `Skill ${name}`): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`, "utf8");
  return dir;
}

function snapshotTreeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string, prefix: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir, "");
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pmcap-inv-"));
  userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  now = 100_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createCapabilityInventory", () => {
  it("合并各厂商同名技能和 MCP 为一项，vendors 列出能看到它的几家", async () => {
    writeSkill(join(userHome, ".agents", "skills"), "aws-auth", "Auth skill");
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: ["mcp"] } } }),
    );
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    writeFileSync(
      join(userHome, ".codex", "config.toml"),
      '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["mcp"]\n',
    );

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const res = await inv.get({ projectDir: null });

    const skillItems = res.items.filter((i) => i.key === "skill:aws-auth");
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]!.vendors).toContain("codex");
    expect(skillItems[0]!.vendors).toContain("pi");

    const mcpItems = res.items.filter((i) => i.key === "mcp:codegraph");
    expect(mcpItems).toHaveLength(1);
    expect(mcpItems[0]!.vendors).toEqual(["claude", "codex"]);
  });

  it("云端连接器按厂商分开算，键带厂商编号", async () => {
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify({ claudeAiMcpEverConnected: ["claude.ai Gmail"] }),
    );
    const cacheDir = join(userHome, ".codex", "cache", "codex_apps_tools");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "tools.json"),
      JSON.stringify({
        tools: [{ connector_id: "connector_gmail", connector_name: "Gmail", tool_name: "search" }],
      }),
    );

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const res = await inv.get({ projectDir: null });

    const claudeConn = res.items.find((i) => i.key === "connector:claude:claude.ai Gmail");
    const codexConn = res.items.find((i) => i.key === "connector:codex:connector_gmail");
    expect(claudeConn).toBeDefined();
    expect(claudeConn?.vendors).toEqual(["claude"]);
    expect(codexConn).toBeDefined();
    expect(codexConn?.vendors).toEqual(["codex"]);
  });

  it("codex_apps_tools 缓存文件超过 2 MB（含完整工具 Schema）时仍能扫出云端连接器", async () => {
    const cacheDir = join(userHome, ".codex", "cache", "codex_apps_tools");
    mkdirSync(cacheDir, { recursive: true });
    const bigSchemaPadding = "x".repeat(2_300_000);
    writeFileSync(
      join(cacheDir, "big-tools.json"),
      JSON.stringify({
        tools: [
          {
            connector_id: "connector_openai_chatgpt_pets",
            connector_name: "Pets",
            tool_name: "feed",
            namespace_description: bigSchemaPadding,
          },
        ],
      }),
    );

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const res = await inv.get({ projectDir: null });
    expect(res.items.find((i) => i.key === "connector:codex:connector_openai_chatgpt_pets")).toMatchObject({
      kind: "connector",
      name: "Pets",
      vendors: ["codex"],
    });
  });

  it("给了 projectDir 时含项目技能，分组 source 为 project", async () => {
    const projectDir = join(root, "my-repo");
    writeSkill(join(projectDir, ".agents", "skills"), "repo-lint", "Repo lint skill");

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const withoutProj = await inv.get({ projectDir: null });
    expect(withoutProj.items.find((i) => i.key === "skill:repo-lint")).toBeUndefined();

    const withProj = await inv.get({ projectDir });
    const item = withProj.items.find((i) => i.key === "skill:repo-lint");
    expect(item).toBeDefined();
    const group = withProj.groups.find((g) => g.id === item!.groupId);
    expect(group?.source).toEqual({ kind: "project", projectLabel: "my-repo" });
  });

  it("插件里的技能和 MCP 归到插件分组", async () => {
    const pluginDir = join(userHome, ".claude", "plugins", "synced", "acc-1", "sales-dir");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sales" }));
    writeSkill(join(pluginDir, "skills"), "call-prep", "Call prep");
    writeFileSync(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { salesforce: { type: "http", url: "https://example.com/mcp" } } }),
    );

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const res = await inv.get({ projectDir: null });

    const pSkill = res.items.find((i) => i.key === "skill:sales:call-prep");
    const pMcp = res.items.find((i) => i.key === "mcp:plugin:sales:salesforce");
    expect(pSkill).toBeDefined();
    expect(pMcp).toBeDefined();

    const skillGroup = res.groups.find((g) => g.id === pSkill!.groupId);
    const mcpGroup = res.groups.find((g) => g.id === pMcp!.groupId);
    expect(skillGroup?.source).toEqual({ kind: "plugin", vendor: "claude", plugin: "sales@synced" });
    expect(mcpGroup?.source).toEqual({ kind: "plugin", vendor: "claude", plugin: "sales@synced" });
  });

  it("缓存有效期内返回同一个对象", async () => {
    writeSkill(join(userHome, ".agents", "skills"), "alpha");
    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const first = await inv.get({ projectDir: null });
    now += PM_CAPABILITY_INVENTORY_TTL_MS - 1;
    const second = await inv.get({ projectDir: null });
    expect(second).toBe(first);

    now += 2;
    const third = await inv.get({ projectDir: null });
    expect(third).not.toBe(first);
    expect(third.scannedAt).toBe(now);
  });

  it("技能目录或配置文件的 mtime 变了，下一次 get 重新扫描", async () => {
    const skillsRoot = join(userHome, ".agents", "skills");
    writeSkill(skillsRoot, "alpha");
    const claudeCfg = join(userHome, ".claude.json");
    writeFileSync(claudeCfg, JSON.stringify({ mcpServers: {} }));

    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const first = await inv.get({ projectDir: null });
    expect(first.items.map((i) => i.key)).toEqual(["skill:alpha"]);

    now += 100;
    writeFileSync(claudeCfg, JSON.stringify({ mcpServers: { added_mcp: { command: "echo", args: [] } } }));
    const st = statSync(claudeCfg);
    const bumpSec = Math.floor(st.mtimeMs / 1000) + 5;
    utimesSync(claudeCfg, bumpSec, bumpSec);

    const second = await inv.get({ projectDir: null });
    expect(second).not.toBe(first);
    expect(second.items.some((i) => i.key === "mcp:added_mcp")).toBe(true);
  });

  it("一家扫描失败时其余几家照常返回，失败结果只缓存 PM_CAPABILITY_INVENTORY_RETRY_MS", async () => {
    writeSkill(join(userHome, ".agents", "skills"), "steady-skill");
    let shouldFail = true;
    let calls = 0;
    const flakyClaude: VendorSyncAdapter = {
      ...claudeSyncAdapter,
      async scanCapabilities(): Promise<VendorCapabilityScan> {
        calls++;
        if (shouldFail) throw new Error("probe timed out");
        return {
          skills: [],
          mcp: [],
          connectors: [{ id: "claude.ai Gmail", name: "Gmail" }],
          plugins: [],
        };
      },
    };

    const inv = createCapabilityInventory({
      ctx: { userHome, env: {} },
      now: () => now,
      adapters: { claude: flakyClaude },
    });

    const r1 = await inv.get({ projectDir: null });
    expect(calls).toBe(1);
    expect(r1.items.some((i) => i.key === "skill:steady-skill")).toBe(true);
    expect(r1.items.some((i) => i.key === "connector:claude:claude.ai Gmail")).toBe(false);

    shouldFail = false;
    now += PM_CAPABILITY_INVENTORY_RETRY_MS - 1;
    const r2 = await inv.get({ projectDir: null });
    expect(r2).toBe(r1);
    expect(calls).toBe(1);

    now += 2;
    const r3 = await inv.get({ projectDir: null });
    expect(calls).toBe(2);
    expect(r3.items.some((i) => i.key === "connector:claude:claude.ai Gmail")).toBe(true);
  });

  it("超过 PM_CAPABILITY_INVENTORY_MAX_ITEMS 时截断并标 truncated", async () => {
    const hugeClaude: VendorSyncAdapter = {
      ...claudeSyncAdapter,
      async scanCapabilities(): Promise<VendorCapabilityScan> {
        return {
          skills: Array.from({ length: PM_CAPABILITY_INVENTORY_MAX_ITEMS + 25 }, (_, idx) => ({
            name: `bulk-skill-${String(idx).padStart(4, "0")}`,
            dir: `/fake/skills/${idx}`,
            description: null,
            source: { kind: "vendor_bundled" as const, vendor: "claude" as const },
          })),
          mcp: [],
          connectors: [],
          plugins: [],
        };
      },
    };

    const inv = createCapabilityInventory({
      ctx: { userHome, env: {} },
      now: () => now,
      adapters: { claude: hugeClaude },
    });
    const res = await inv.get({ projectDir: null });
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(PM_CAPABILITY_INVENTORY_MAX_ITEMS);
  });

  it("invalidate 后重新扫描", async () => {
    writeSkill(join(userHome, ".agents", "skills"), "alpha");
    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    const first = await inv.get({ projectDir: null });

    now += 10;
    inv.invalidate();
    const second = await inv.get({ projectDir: null });
    expect(second).not.toBe(first);
    expect(second.scannedAt).toBe(now);
  });

  it("扫描不写任何用户配置文件", async () => {
    writeSkill(join(userHome, ".agents", "skills"), "alpha");
    writeFileSync(
      join(userHome, ".claude.json"),
      JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: [] } } }),
    );
    mkdirSync(join(userHome, ".codex"), { recursive: true });
    writeFileSync(join(userHome, ".codex", "config.toml"), '[mcp_servers.codegraph]\ncommand = "codegraph"\n');

    const before = snapshotTreeHashes(userHome);
    const inv = createCapabilityInventory({ ctx: { userHome, env: {} }, now: () => now });
    await inv.get({ projectDir: null });
    const after = snapshotTreeHashes(userHome);
    expect(after).toEqual(before);
  });
});
