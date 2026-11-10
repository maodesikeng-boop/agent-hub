// agy 的输入框实现（实测见 docs/composer-commands.md）。
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyComposerBase, createAgyComposer, parseAgyCommands } from "./composer.ts";

describe("agy 输入框实现（parseAgyCommands / agyComposerBase / createAgyComposer）", () => {
  it("parseAgyCommands：解析 command.data.skills 并合并内置 /compact，过滤非法与重复项", () => {
    const parsed = parseAgyCommands({
      command: {
        name: "skills",
        data: {
          skills: [
            { name: "how", description: "Explain how code works", path: "/x/how/SKILL.md" },
            { name: "teach", description: "Teach a concept" },
            { name: "how", description: "duplicate" },
            { name: "bad name", description: "has space" },
          ],
        },
      },
    });
    expect(parsed).toEqual([
      { name: "how", description: "Explain how code works" },
      { name: "teach", description: "Teach a concept" },
      { name: "compact", description: "压缩当前对话上下文", builtin: true },
    ]);
    expect(parseAgyCommands(null)).toBeNull();
    expect(parseAgyCommands("nope")).toBeNull();
  });

  it("agyComposerBase：mention 与隐藏命令拦截", () => {
    expect(agyComposerBase.mention("src/index.ts")).toBe("@src/index.ts");
    expect(agyComposerBase.mention("docs/my file.md")).toBe('@"docs/my file.md"');
    expect(agyComposerBase.blockReason("/clear", null)).toMatch(/开新会话/);
    expect(agyComposerBase.blockReason("/model", null)).toMatch(/资料页/);
    expect(agyComposerBase.blockReason("/compact", null)).toBeNull();
  });

  it("createAgyComposer：未传选项回退内置命令；传 executablePath 时跑 agy -p \"/skills\" --output-format json", async () => {
    const fallback = createAgyComposer();
    expect(await fallback.queryCommands({ cwd: "/tmp", addDirs: [] }, new AbortController().signal)).toEqual([
      { name: "compact", description: "压缩当前对话上下文", builtin: true },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "hub-agy-commands-"));
    try {
      const agyPath = join(dir, "agy");
      writeFileSync(
        agyPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(JSON.stringify({ command: { name: "skills", data: { skills: [{ name: "why", description: "Explain why" }] } } }) + "\\n");
`,
      );
      chmodSync(agyPath, 0o755);
      const composer = createAgyComposer({ executablePath: agyPath });
      const commands = await composer.queryCommands({ cwd: dir, addDirs: [] }, new AbortController().signal);
      expect(commands).toEqual([
        { name: "why", description: "Explain why" },
        { name: "compact", description: "压缩当前对话上下文", builtin: true },
      ]);
      const recorded = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
      expect(recorded.argv).toEqual(["-p", "/skills", "--output-format", "json"]);
      expect(recorded.cwd).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
