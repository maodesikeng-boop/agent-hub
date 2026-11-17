import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchFingerprint } from "../../shared/launch.ts";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { claudeCapabilitySettings } from "./capabilities.ts";
import { buildSessionSettings } from "./settings.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [] },
    allow: { skills: [], mcp: [] },
  };
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
      },
    });
    const b = claudeCapabilitySettings({
      ...emptyCaps(),
      deny: {
        skills: ["a-skill", "z-skill"],
        mcp: ["a-mcp", "z-mcp"],
        connectors: ["claude.ai Gmail", "claude.ai Slack"],
        plugins: ["data@synced", "sales@synced"],
      },
    });
    const jsonA = JSON.stringify(a);
    const jsonB = JSON.stringify(b);
    expect(jsonA).toBe(jsonB);
    expect(launchFingerprint({ prompt: "p", settings: jsonA })).toBe(
      launchFingerprint({ prompt: "p", settings: jsonB }),
    );
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
