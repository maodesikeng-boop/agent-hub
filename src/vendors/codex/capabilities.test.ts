import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { codexCapabilityArgs } from "./capabilities.ts";

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

const canRunLiveCodex =
  existsSync(join(homedir(), ".codex", "config.toml")) &&
  spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

describe("codexCapabilityArgs", () => {
  it("关掉的技能合成一条 skills.config 覆盖，按名字禁用，插件技能也一样", () => {
    const args = codexCapabilityArgs(
      denyCaps({
        skills: ["pdf", "aws-auth", "spreadsheets:Spreadsheets"],
        pluginOf: { skills: { "spreadsheets:Spreadsheets": "spreadsheets@openai-primary-runtime" }, mcp: {} },
      }),
    );
    expect(args).toEqual([
      "-c",
      'skills.config=[{name="aws-auth",enabled=false},{name="pdf",enabled=false},{name="spreadsheets:Spreadsheets",enabled=false}]',
    ]);
  });

  it("config.toml 里的 MCP 合成一条 mcp_servers 内联表，名字放引号键里（带点、空格也行）", () => {
    const args = codexCapabilityArgs(denyCaps({ mcp: ["codegraph", "my.server", "aws-mcp"] }));
    expect(args).toEqual([
      "-c",
      'mcp_servers={"aws-mcp"={enabled=false},"codegraph"={enabled=false},"my.server"={enabled=false}}',
    ]);
  });

  it("插件带的 MCP 写到 plugins.<插件>.mcp_servers 下，不进顶层 mcp_servers（顶层没定义的服务器会让 app-server 退出）", () => {
    const args = codexCapabilityArgs(
      denyCaps({
        mcp: ["codegraph", "cua_repl", "gmail"],
        pluginOf: {
          skills: {},
          mcp: { cua_repl: "unified-computer-use@openai-bundled", gmail: "gmail@openai-curated" },
        },
      }),
    );
    expect(args).toEqual([
      "-c",
      'mcp_servers={"codegraph"={enabled=false}}',
      "-c",
      'plugins={"gmail@openai-curated"={mcp_servers={"gmail"={enabled=false}}},"unified-computer-use@openai-bundled"={mcp_servers={"cua_repl"={enabled=false}}}}',
    ]);
  });

  it("整个插件都关时也只逐项关，不发 plugins.<编号>.enabled", () => {
    const args = codexCapabilityArgs(
      denyCaps({
        skills: ["visualize:visualize"],
        plugins: ["visualize@openai-bundled"],
        pluginOf: { skills: { "visualize:visualize": "visualize@openai-bundled" }, mcp: {} },
      }),
    );
    expect(args).toEqual(["-c", 'skills.config=[{name="visualize:visualize",enabled=false}]']);
  });

  it("关掉的连接器合成一条 apps 内联表", () => {
    const args = codexCapabilityArgs(denyCaps({ connectors: ["connector_openai_chatgpt_pets", "my app"] }));
    expect(args).toEqual(["-c", 'apps={"connector_openai_chatgpt_pets"={enabled=false},"my app"={enabled=false}}']);
  });

  it("deny 全空返回空数组", () => {
    expect(codexCapabilityArgs(emptyCaps())).toEqual([]);
  });

  it.runIf(canRunLiveCodex)(
    "真机：带这些参数起 app-server（插件 MCP 的覆盖不让它退出），skills/list 里该技能 enabled 为 false、app/list 里该连接器 isEnabled 为 false",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-cap-test-"));
      try {
        const skillDir = join(dir, ".agents", "skills", "probe-codex-off");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          "---\nname: probe-codex-off\ndescription: Probe codex skill\n---\nBody\n",
        );
        const extraArgs = codexCapabilityArgs(
          denyCaps({
            skills: ["probe-codex-off"],
            mcp: ["probe-plugin-mcp"],
            connectors: ["connector_openai_chatgpt_pets"],
            pluginOf: { skills: {}, mcp: { "probe-plugin-mcp": "probe-plugin@probe-market" } },
          }),
        );
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
