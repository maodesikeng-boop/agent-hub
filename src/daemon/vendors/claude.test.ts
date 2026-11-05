// claude 的输入框实现（实测见 docs/composer-commands.md）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_COMMAND_DESCRIPTION_CHARS, VENDOR_SPECS } from "../../shared/index.ts";
import { FAKE_CLAUDE } from "../driver/test-helpers.ts";
import { claudeComposerBase, createClaudeComposer, parseClaudeCommands } from "./claude.ts";
import { composerBaseOf } from "./index.ts";

const c = claudeComposerBase;

describe("命令列表的形状", () => {
  it("initialize 的 commands → {name, description, argumentHint?}：空的参数提示不给，aliases、builtin 不要", () => {
    expect(
      parseClaudeCommands([
        { name: "x", description: "probe command x (project)", argumentHint: "word" },
        { name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
        { name: "y", description: "probe skill y (project)", argumentHint: "" },
        { name: "slack:standup", description: "(slack) Generate a standup update" },
      ]),
    ).toEqual([
      { name: "x", description: "probe command x (project)", argumentHint: "word" },
      { name: "clear", description: "Start a new session", argumentHint: "[name]" },
      { name: "y", description: "probe skill y (project)" },
      { name: "slack:standup", description: "(slack) Generate a standup update" },
    ]);
  });

  it("没名字、名字带空白、重复的跳过；说明太长截断；不是数组是 null", () => {
    const long = "说".repeat(MAX_COMMAND_DESCRIPTION_CHARS + 50);
    const parsed = parseClaudeCommands([{ name: "" }, { name: "a b" }, { description: "x" }, "x", { name: "ok", description: long }, { name: "ok" }]);
    expect(parsed?.map((p) => p.name)).toEqual(["ok"]);
    expect([...parsed![0]!.description].length).toBeLessThanOrEqual(MAX_COMMAND_DESCRIPTION_CHARS);
    expect(parseClaudeCommands(undefined)).toBeNull();
    expect(parseClaudeCommands({ name: "x" })).toBeNull();
  });
});

describe("隐藏和拦截（方案第 5 节 8、9）", () => {
  it("要求的隐藏名单都在：会打乱会话的、和资料页打架的、只能在终端用的", () => {
    for (const name of ["clear", "model", "effort", "config", "login", "logout", "resume", "exit", "doctor", "color", "focus", "reload-plugins"]) {
      expect(c.isHiddenCommand(name), name).toBe(true);
    }
    // 别名也拦：/clear 的 reset、new
    expect(c.isHiddenCommand("reset")).toBe(true);
    expect(c.isHiddenCommand("new")).toBe(true);
    for (const name of ["compact", "context", "usage", "init", "x", "slack:standup", "constructor", "toString"]) {
      expect(c.isHiddenCommand(name), name).toBe(false);
    }
  });

  it("手打隐藏的命令：拦下，原因带命令名和用什么代替；带参数、大写也拦", () => {
    expect(c.blockReason("/clear")).toMatch(/^\/clear：.*开新会话/);
    expect(c.blockReason("/clear 新任务")).toMatch(/^\/clear：/);
    expect(c.blockReason("/reset")).toMatch(/开新会话/);
    expect(c.blockReason("/model opus")).toMatch(/资料页/);
    expect(c.blockReason("/Model")).toMatch(/资料页/);
    expect(c.blockReason("/doctor")).toMatch(/终端/);
    expect(c.blockReason("/login")).toMatch(/终端/);
  });

  it("不拦：普通命令、普通话、命令不在开头、前面有空格、只有一个 /", () => {
    for (const text of ["/compact", "/x 参数", "你好", "please run /clear", " /clear", "/", "/ clear", "/usr/bin/env"]) {
      expect(c.blockReason(text), text).toBeNull();
    }
  });

  it("每个隐藏命令都有原因（纯数据在 shared/vendors.ts）", () => {
    for (const [name, reason] of Object.entries(VENDOR_SPECS.claude.composer.blockedCommands)) {
      expect(name).toBe(name.toLowerCase());
      expect(reason.length, name).toBeGreaterThan(0);
    }
  });

  it("是不是命令：只认最开头的 /，后面要有名字", () => {
    expect(c.isCommand("/x")).toBe(true);
    expect(c.isCommand("/x 参数\n第二行")).toBe(true);
    expect(c.isCommand(" /x")).toBe(false);
    expect(c.isCommand("/")).toBe(false);
    expect(c.isCommand("hi /x")).toBe(false);
    // 命令名里带 / 的是路径，不是命令（插件命令用 :）
    expect(c.isCommand("/Users/x/foo.py 这里有 bug")).toBe(false);
    expect(c.isCommand("/usr/bin")).toBe(false);
    expect(c.isCommand("/slack:standup")).toBe(true);
    expect(c.blockReason("/clear/x")).toBeNull();
  });
});

describe("@ 文件的写法（实测 T5、T6）", () => {
  it("普通路径 @path；带空格的 @\"a b.md\"", () => {
    expect(c.mention("README.md")).toBe("@README.md");
    expect(c.mention("src/a.ts")).toBe("@src/a.ts");
    expect(c.mention("docs/a b.md")).toBe('@"docs/a b.md"');
    expect(c.mention("/Users/me/other/中文 文件.md")).toBe('@"/Users/me/other/中文 文件.md"');
  });
});

describe("写进 agent 的内容（实测 T4）", () => {
  it("加的字每项一块在前，原文最后一块", () => {
    expect(c.buildUserContent(["【用户直接对你说】"], "/x 一")).toEqual([
      { type: "text", text: "【用户直接对你说】" },
      { type: "text", text: "/x 一" },
    ]);
    expect(c.buildUserContent([], "你好")).toEqual([{ type: "text", text: "你好" }]);
  });
});

describe("按厂商找实现", () => {
  it("认识的厂商有，不认识的 null", () => {
    expect(composerBaseOf("claude")?.vendor).toBe("claude");
    expect(composerBaseOf("codex")).toBeNull();
    expect(composerBaseOf("constructor")).toBeNull();
  });
});

describe("会话没在跑时另起进程问（假 claude）", () => {
  it("在会话的目录里起，带 --add-dir，回通用形状", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-claude-commands-"));
    try {
      const script = join(dir, "script.json");
      const log = join(dir, "log.jsonl");
      writeFileSync(script, JSON.stringify({ commands: [{ name: "x", description: "d", argumentHint: "w" }] }));
      const composer = createClaudeComposer({ claudePath: FAKE_CLAUDE, env: { ...process.env, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_LOG: log } });
      const commands = await composer.queryCommands({ cwd: dir, addDirs: ["/tmp"] }, new AbortController().signal);
      expect(commands).toEqual([{ name: "x", description: "d", argumentHint: "w" }]);
      const argv = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((e) => e.kind === "argv");
      expect(argv.argv).toEqual(expect.arrayContaining(["--add-dir", "/tmp", "--no-session-persistence"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("问不到（程序不存在）：失败带原因", async () => {
    const composer = createClaudeComposer({ claudePath: "/nonexistent/claude" });
    await expect(composer.queryCommands({ cwd: "/tmp", addDirs: [] }, new AbortController().signal)).rejects.toThrow(/nonexistent/);
  });
});
