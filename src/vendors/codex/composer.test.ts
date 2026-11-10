// codex 的输入框实现（实测见 docs/composer-commands.md）。
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexComposerBase, createCodexComposer, parseCodexCommands, rewriteCodexSkillCommand } from "./composer.ts";

describe("codex 输入框实现（parseCodexCommands / codexComposerBase / createCodexComposer）", () => {
  it("parseCodexCommands：解析 skills/list 的 data[].skills，跳过 enabled === false，合并内置 /compact", () => {
    const parsed = parseCodexCommands({
      data: [
        {
          cwd: "/repo",
          skills: [
            { name: "review", description: "Review code changes", enabled: true },
            { name: "disabled-skill", description: "Should be skipped", enabled: false },
            { name: "short-only", shortDescription: "Short description fallback", enabled: true },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      { name: "review", description: "Review code changes" },
      { name: "short-only", description: "Short description fallback" },
      { name: "compact", description: "压缩当前对话上下文", builtin: true },
    ]);
    expect(parseCodexCommands(null)).toBeNull();
  });

  it("codexComposerBase：非 compact 的 /<skill> 在 buildUserContent 中改写为 $<skill>，/compact 与路径保持原样", () => {
    expect(rewriteCodexSkillCommand("/review src/a.ts")).toBe("$review src/a.ts");
    expect(rewriteCodexSkillCommand("/compact")).toBe("/compact");
    expect(rewriteCodexSkillCommand("/compact 留结论")).toBe("/compact 留结论");
    expect(rewriteCodexSkillCommand("/Users/me/file.ts 有问题")).toBe("/Users/me/file.ts 有问题");
    expect(rewriteCodexSkillCommand("普通消息")).toBe("普通消息");

    expect(codexComposerBase.buildUserContent(["【用户直接对你说】"], "/review")).toEqual([
      { type: "text", text: "【用户直接对你说】" },
      { type: "text", text: "$review" },
    ]);
    expect(codexComposerBase.buildUserContent([], "/compact")).toEqual([{ type: "text", text: "/compact" }]);
    expect(codexComposerBase.blockReason("/sandbox", null)).toMatch(/沙箱/);
  });

  it("createCodexComposer：未传选项回退内置命令；传 executablePath 时通过 app-server 发 skills/list", async () => {
    const fallback = createCodexComposer();
    expect(await fallback.queryCommands({ cwd: "/tmp", addDirs: [] }, new AbortController().signal)).toEqual([
      { name: "compact", description: "压缩当前对话上下文", builtin: true },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "hub-codex-commands-"));
    try {
      const codexPath = join(dir, "codex");
      writeFileSync(
        codexPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) out({ jsonrpc: "2.0", id: 1, result: {} });
  if (msg.id === 2 && msg.method === "skills/list") {
    fs.writeFileSync(${JSON.stringify(join(dir, "params.json"))}, JSON.stringify(msg.params));
    out({
      jsonrpc: "2.0",
      id: 2,
      result: {
        data: [{ cwd: msg.params.cwds[0], skills: [{ name: "deploy", description: "Deploy service", enabled: true }] }],
      },
    });
  }
});
`,
      );
      chmodSync(codexPath, 0o755);
      const composer = createCodexComposer({ executablePath: codexPath });
      const commands = await composer.queryCommands({ cwd: dir, addDirs: ["/extra"] }, new AbortController().signal);
      expect(commands).toEqual([
        { name: "deploy", description: "Deploy service" },
        { name: "compact", description: "压缩当前对话上下文", builtin: true },
      ]);
      expect(JSON.parse(readFileSync(join(dir, "params.json"), "utf8"))).toEqual({
        cwds: [dir, "/extra"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
