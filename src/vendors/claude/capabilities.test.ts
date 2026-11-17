import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchFingerprint } from "../../shared/launch.ts";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { buildReadonlyPolicy } from "../../shared/readonly-policy.ts";
import { claudeCapabilityDenyRules, claudeCapabilitySettings } from "./capabilities.ts";
import { buildSessionSettings } from "./settings.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
    allow: { skills: [], mcp: [] },
  };
}

function denyCaps(deny: Partial<SessionCapabilities["deny"]>): SessionCapabilities {
  const base = emptyCaps();
  return { ...base, deny: { ...base.deny, ...deny } };
}

const canRunLiveClaude =
  existsSync(join(homedir(), ".claude.json")) &&
  spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;

describe("claudeCapabilitySettings", () => {
  it("关掉的技能写成 skillOverrides 里的 off", () => {
    const res = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, skills: ["docx", "aws-auth"] },
    });
    expect(res).toEqual({
      skillOverrides: {
        "aws-auth": "off",
        docx: "off",
      },
    });
  });

  it("关掉的 MCP 和 claude.ai 云端连接器写成 deniedMcpServers 的 serverName", () => {
    const res = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: {
        ...emptyCaps().deny,
        mcp: ["codegraph"],
        connectors: ["claude.ai Gmail"],
      },
    });
    expect(res).toEqual({
      deniedMcpServers: [{ serverName: "claude.ai Gmail" }, { serverName: "codegraph" }],
    });
  });

  it("整组关掉的插件写成 enabledPlugins 里的 false", () => {
    const res = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, plugins: ["sales@synced", "data@synced"] },
    });
    expect(res).toEqual({
      enabledPlugins: {
        "data@synced": false,
        "sales@synced": false,
      },
    });
  });

  it("插件里的技能不进 skillOverrides（claude 对插件技能不认它），插件 MCP 照样进 deniedMcpServers", () => {
    const res = claudeCapabilitySettings(
      denyCaps({
        skills: ["aws-auth", "data:analyze"],
        mcp: ["plugin:parallel:parallel-search"],
        pluginOf: { skills: { "data:analyze": "data@synced" }, mcp: { "plugin:parallel:parallel-search": "parallel@market" } },
      }),
    );
    expect(res).toEqual({
      skillOverrides: { "aws-auth": "off" },
      deniedMcpServers: [{ serverName: "plugin:parallel:parallel-search" }],
    });
  });

  it("deny 全空时返回空对象，设置文件和现在逐字相同", () => {
    const extra = claudeCapabilitySettings(emptyCaps());
    expect(extra).toEqual({});
    const baseline = JSON.stringify(
      buildSessionSettings({ role: "pm", hubSock: "/tmp/hub.sock", stateDir: "/tmp/state", osSandboxed: true }),
      null,
      2,
    );
    const merged = JSON.stringify(
      {
        ...buildSessionSettings({ role: "pm", hubSock: "/tmp/hub.sock", stateDir: "/tmp/state", osSandboxed: true }),
        ...extra,
      },
      null,
      2,
    );
    expect(merged).toBe(baseline);
  });

  it("同样的输入键顺序相同，fingerprint 不变", () => {
    const a = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: {
        skills: ["z-skill", "a-skill"],
        mcp: ["z-mcp", "a-mcp"],
        connectors: ["claude.ai Slack", "claude.ai Gmail"],
        plugins: ["sales@synced", "data@synced"],
        pluginOf: { skills: {}, mcp: {} },
      },
    });
    const b = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: {
        skills: ["a-skill", "z-skill"],
        mcp: ["a-mcp", "z-mcp"],
        connectors: ["claude.ai Gmail", "claude.ai Slack"],
        plugins: ["data@synced", "sales@synced"],
        pluginOf: { skills: {}, mcp: {} },
      },
    });
    const jsonA = JSON.stringify(a);
    const jsonB = JSON.stringify(b);
    expect(jsonA).toBe(jsonB);
    expect(launchFingerprint({ prompt: "p", settings: jsonA })).toBe(
      launchFingerprint({ prompt: "p", settings: jsonB }),
    );
  });

  it("同样的输入键顺序相同，fingerprint 不变（插件技能拒绝规则也排序）", () => {
    const a = claudeCapabilityDenyRules(
      denyCaps({ skills: ["s:b", "s:a"], pluginOf: { skills: { "s:b": "s@m", "s:a": "s@m" }, mcp: {} } }),
    );
    const b = claudeCapabilityDenyRules(
      denyCaps({ skills: ["s:a", "s:b"], pluginOf: { skills: { "s:a": "s@m", "s:b": "s@m" }, mcp: {} } }),
    );
    expect(a).toEqual(["Skill(s:a)", "Skill(s:b)"]);
    expect(b).toEqual(a);
  });

  it.runIf(canRunLiveClaude)(
    "真机：带这份 --settings 起 claude，system/init 里看不到被关的技能、MCP 和连接器",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "claude-cap-test-"));
      try {
        const skillDir = join(dir, ".claude", "skills", "probe-off-skill");
        writeFileSync(join(dir, "dummy"), "");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          "---\nname: probe-off-skill\ndescription: Probe skill to disable\n---\nBody\n",
        );
        const capsSettings = claudeCapabilitySettings({
          ...emptyCaps(),
          deny: {
            skills: ["probe-off-skill"],
            mcp: ["codegraph"],
            connectors: ["claude.ai Gmail"],
            plugins: ["sales@synced"],
            pluginOf: { skills: {}, mcp: {} },
          },
        });
        const settingsPath = join(dir, "settings.json");
        writeFileSync(settingsPath, JSON.stringify(capsSettings, null, 2));

        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const k of Object.keys(env)) {
          if (k.startsWith("CLAUDE")) delete env[k];
        }
        const initMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const child = spawn(
            "claude",
            ["-p", "ok", "--output-format", "stream-json", "--verbose", "--settings", settingsPath],
            { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let buf = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("claude init timed out"));
          }, 20_000);
          child.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            for (const line of buf.split("\n")) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.type === "system" && parsed.subtype === "init") {
                  clearTimeout(timer);
                  child.kill();
                  resolve(parsed);
                  return;
                }
              } catch {}
            }
          });
          child.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        const skills = Array.isArray(initMsg.skills) ? (initMsg.skills as string[]) : [];
        const mcpServers = Array.isArray(initMsg.mcp_servers)
          ? (initMsg.mcp_servers as Array<{ name: string }>).map((m) => m.name)
          : [];
        expect(skills).not.toContain("probe-off-skill");
        expect(skills.some((s) => s.startsWith("sales:"))).toBe(false);
        expect(mcpServers).not.toContain("codegraph");
        expect(mcpServers).not.toContain("claude.ai Gmail");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});

describe("claudeCapabilityDenyRules", () => {
  it("插件里关掉的技能每个一条 Skill(<名字>)，非插件技能不写", () => {
    const rules = claudeCapabilityDenyRules(
      denyCaps({
        skills: ["aws-auth", "sales:account-plan", "data:analyze"],
        pluginOf: { skills: { "sales:account-plan": "sales@synced", "data:analyze": "data@synced" }, mcp: {} },
      }),
    );
    expect(rules).toEqual(["Skill(data:analyze)", "Skill(sales:account-plan)"]);
  });

  it("所属插件整个关了的技能不再写（enabledPlugins 已经让它不见）", () => {
    const rules = claudeCapabilityDenyRules(
      denyCaps({
        skills: ["sales:account-plan", "data:analyze"],
        plugins: ["sales@synced"],
        pluginOf: { skills: { "sales:account-plan": "sales@synced", "data:analyze": "data@synced" }, mcp: {} },
      }),
    );
    expect(rules).toEqual(["Skill(data:analyze)"]);
  });
});

describe("buildSessionSettings 合并插件技能的拒绝规则", () => {
  const caps = denyCaps({ skills: ["data:analyze"], pluginOf: { skills: { "data:analyze": "data@synced" }, mcp: {} } });
  const base = { hubSock: "/tmp/hub.sock", stateDir: "/tmp/state", osSandboxed: true, capabilities: caps } as const;

  it("项目经理：permissions.deny 只有这一条", () => {
    expect(buildSessionSettings({ ...base, role: "pm" }).permissions.deny).toEqual(["Skill(data:analyze)"]);
  });

  it("普通 Worker：接在 state/ 的拒绝规则后面", () => {
    const deny = buildSessionSettings({ ...base, role: "worker" }).permissions.deny ?? [];
    expect(deny[0]).toMatch(/^Edit\(/);
    expect(deny.at(-1)).toBe("Skill(data:analyze)");
  });

  it("只读 Worker：接在只读规则后面，只读规则一条不少", () => {
    const readonly = { policy: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/tmp/state" }), denyWrite: ["/tmp/w"] };
    const withCaps = buildSessionSettings({ ...base, role: "worker", readonly });
    const without = buildSessionSettings({ ...base, capabilities: undefined, role: "worker", readonly });
    expect(without.permissions.deny?.length).toBeGreaterThan(0);
    expect(withCaps.permissions.deny).toEqual([...(without.permissions.deny ?? []), "Skill(data:analyze)"]);
  });
});
