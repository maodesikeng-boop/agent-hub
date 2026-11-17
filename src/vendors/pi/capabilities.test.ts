import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";
import { piCapabilityArgs } from "./capabilities.ts";
import { buildPiArgs } from "./protocol.ts";

function emptyCaps(): SessionCapabilities {
  return {
    deny: { skills: [], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
    allow: { skills: [], mcp: [] },
  };
}

const canRunLivePi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

describe("piCapabilityArgs", () => {
  it("有技能被关时 noSkills 为 true，只带允许的技能目录", () => {
    const res = piCapabilityArgs({
      deny: { skills: ["aws-auth"], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: {
        skills: [
          { name: "docx", dir: "/skills/docx" },
          { name: "pdf", dir: "/skills/pdf" },
        ],
        mcp: [],
      },
    });
    expect(res).toEqual({
      noSkills: true,
      skillDirs: ["/skills/docx", "/skills/pdf"],
      excludeTools: [],
    });
  });

  it("没有技能被关时不加 --no-skills，保留默认技能目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-cap-default-"));
    try {
      const projSkills = join(dir, ".agents", "skills");
      mkdirSync(projSkills, { recursive: true });
      const caps: SessionCapabilities = {
        deny: { skills: [], mcp: ["codegraph"], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
        allow: { skills: [{ name: "docx", dir: "/skills/docx" }], mcp: [] },
      };
      const res = piCapabilityArgs(caps);
      expect(res.noSkills).toBe(false);
      expect(res.skillDirs).toEqual([]);

      const args = buildPiArgs({
        row: { cwd: dir, addDirs: [], model: null, effort: null },
        files: { promptFile: "", capabilities: caps },
        sessionId: "sess-1",
      });
      expect(args).not.toContain("--no-skills");
      expect(args).toContain(projSkills);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("关掉的 MCP 写成 mcp__<服务器>__* 并进 --exclude-tools", () => {
    const caps: SessionCapabilities = {
      deny: { skills: [], mcp: ["codegraph", "aws-mcp"], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
      allow: { skills: [], mcp: [] },
    };
    const res = piCapabilityArgs(caps);
    expect(res.excludeTools).toEqual(["mcp__aws_mcp__*", "mcp__codegraph__*"]);

    const roArgs = buildPiArgs({
      row: { cwd: "/tmp", addDirs: [], model: null, effort: null },
      files: {
        promptFile: "",
        readonly: { secretPaths: [], secretGlobs: [], connectors: { extraAllow: [], deny: [] } },
        capabilities: caps,
      },
      sessionId: "sess-ro",
    });
    const xtIndices = roArgs.reduce<number[]>((acc, arg, idx) => (arg === "--exclude-tools" ? [...acc, idx] : acc), []);
    expect(xtIndices).toHaveLength(1);
    const xtVal = roArgs[xtIndices[0]! + 1]!;
    expect(xtVal.split(",")).toEqual(["edit", "write", "mcp__aws_mcp__*", "mcp__codegraph__*"]);
  });

  it.runIf(canRunLivePi)(
    "真机：get_commands 里只剩允许的技能",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-cap-live-"));
      try {
        const allowedDir = join(dir, "pool", "allowed-one");
        const deniedDir = join(dir, ".agents", "skills", "denied-two");
        mkdirSync(allowedDir, { recursive: true });
        mkdirSync(deniedDir, { recursive: true });
        writeFileSync(
          join(allowedDir, "SKILL.md"),
          "---\nname: allowed-one\ndescription: Allowed test skill\n---\nBody\n",
        );
        writeFileSync(
          join(deniedDir, "SKILL.md"),
          "---\nname: denied-two\ndescription: Denied test skill\n---\nBody\n",
        );

        const caps: SessionCapabilities = {
          deny: { skills: ["denied-two"], mcp: [], connectors: [], plugins: [], pluginOf: { skills: {}, mcp: {} } },
          allow: { skills: [{ name: "allowed-one", dir: allowedDir }], mcp: [] },
        };
        const args = buildPiArgs({
          row: { cwd: dir, addDirs: [], model: null, effort: null },
          files: { promptFile: "", capabilities: caps },
          sessionId: "pi-cap-live-1",
        });
        const rpcArgs = [...args, "--no-session", "--offline", "--no-mcp"];
        const commands = await new Promise<Array<{ name: string; source: string }>>((resolve, reject) => {
          const child = spawn("pi", rpcArgs, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
          let buf = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("pi get_commands timed out"));
          }, 15_000);
          child.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const msg = JSON.parse(line) as { id?: string; data?: { commands?: Array<{ name: string; source: string }> } };
              if (msg.id === "c1") {
                clearTimeout(timer);
                child.kill();
                resolve(msg.data?.commands ?? []);
                return;
              }
            }
          });
          child.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.stdin.write(JSON.stringify({ id: "c1", type: "get_commands" }) + "\n");
        });

        const skillNames = commands.filter((c) => c.source === "skill").map((c) => c.name);
        expect(skillNames).toEqual(["skill:allowed-one"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
