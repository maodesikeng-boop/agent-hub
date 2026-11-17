import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { codexCapabilityArgs } from "./capabilities.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [] },
    allow: { skills: [], mcp: [] },
  };
}

const canRunLiveCodex =
  existsSync(join(homedir(), ".codex", "config.toml")) &&
  spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

describe("codexCapabilityArgs", () => {
  it("关掉的技能合成一条 skills.config 覆盖，按名字禁用", () => {
    const args = codexCapabilityArgs({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, skills: ["pdf", "aws-auth"] },
    });
    expect(args).toEqual(["-c", 'skills.config=[{name="aws-auth",enabled=false},{name="pdf",enabled=false}]']);
  });

  it("关掉的 MCP 各一条 mcp_servers.<名字>.enabled=false", () => {
    const args = codexCapabilityArgs({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, mcp: ["codegraph", "aws-mcp"] },
    });
    expect(args).toEqual([
      "-c",
      "mcp_servers.aws-mcp.enabled=false",
      "-c",
      "mcp_servers.codegraph.enabled=false",
    ]);
  });

  it("关掉的连接器各一条 apps.<编号>.enabled=false", () => {
    const args = codexCapabilityArgs({
      ...emptyCaps(),
      deny: { ...emptyCaps().deny, connectors: ["connector_openai_chatgpt_pets"] },
    });
    expect(args).toEqual(["-c", "apps.connector_openai_chatgpt_pets.enabled=false"]);
  });

  it("名字带点或空格的键段加引号", () => {
    const args = codexCapabilityArgs({
      ...emptyCaps(),
      deny: {
        skills: [],
        mcp: ["my.server"],
        connectors: ["my app"],
        plugins: ["slack@claude-plugins-official"],
      },
    });
    expect(args).toEqual([
      "-c",
      'mcp_servers."my.server".enabled=false',
      "-c",
      'apps."my app".enabled=false',
      "-c",
      'plugins."slack@claude-plugins-official".enabled=false',
    ]);
  });

  it("deny 全空返回空数组", () => {
    expect(codexCapabilityArgs(emptyCaps())).toEqual([]);
  });

  it.runIf(canRunLiveCodex)(
    "真机：带这些参数起 app-server，skills/list 里该技能 enabled 为 false、app/list 里该连接器 isEnabled 为 false",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-cap-test-"));
      try {
        const skillDir = join(dir, ".agents", "skills", "probe-codex-off");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          "---\nname: probe-codex-off\ndescription: Probe codex skill\n---\nBody\n",
        );
        const extraArgs = codexCapabilityArgs({
          ...emptyCaps(),
          deny: {
            skills: ["probe-codex-off"],
            mcp: [],
            connectors: ["connector_openai_chatgpt_pets"],
            plugins: [],
          },
        });
        const { skillsResult, appsResult } = await new Promise<{
          skillsResult: unknown;
          appsResult: unknown;
        }>((resolve, reject) => {
          const child = spawn("codex", ["app-server", "--listen", "stdio://", ...extraArgs], {
            cwd: dir,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let buf = "";
          let gotSkills: unknown;
          let gotApps: unknown;
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("codex app-server timed out"));
          }, 25_000);
          const maybeFinish = () => {
            if (gotSkills !== undefined && gotApps !== undefined) {
              clearTimeout(timer);
              child.kill();
              resolve({ skillsResult: gotSkills, appsResult: gotApps });
            }
          };
          child.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const msg = JSON.parse(line) as { id?: number; result?: unknown };
              if (msg.id === 1) {
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
                child.stdin.write(
                  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "skills/list", params: { cwds: [dir] } }) + "\n",
                );
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "app/installed", params: {} }) + "\n");
              } else if (msg.id === 2) {
                gotSkills = msg.result;
                maybeFinish();
              } else if (msg.id === 3) {
                gotApps = msg.result;
                maybeFinish();
              }
            }
          });
          child.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { clientInfo: { name: "test", version: "1.0" }, capabilities: { experimentalApi: true } },
            }) + "\n",
          );
        });

        const skillsData = (skillsResult as { data?: Array<{ skills?: Array<{ name: string; enabled: boolean }> }> })
          ?.data?.[0]?.skills ?? [];
        const probeSkill = skillsData.find((s) => s.name === "probe-codex-off");
        expect(probeSkill).toBeDefined();
        expect(probeSkill?.enabled).toBe(false);

        const appsData =
          (appsResult as { apps?: Array<{ id: string; enabled: boolean; callable: boolean }> })?.apps ?? [];
        const pets = appsData.find((a) => a.id === "connector_openai_chatgpt_pets");
        if (pets !== undefined) {
          expect(pets.enabled).toBe(false);
          expect(pets.callable).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
