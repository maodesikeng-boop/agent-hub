// claude / agy / codex 的输入框实现（实测见 docs/composer-commands.md）。
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS, MAX_COMMAND_DESCRIPTION_CHARS, VENDOR_SPECS, type ComposerCommand } from "../../shared/index.ts";
import { queryClaudeInitialize } from "../driver/model-catalog.ts";
import { FAKE_CLAUDE } from "../driver/test-helpers.ts";
import { agyComposerBase, createAgyComposer, parseAgyCommands } from "./agy.ts";
import { claudeComposerBase, createClaudeComposer, parseClaudeCommands } from "./claude.ts";
import { codexComposerBase, createCodexComposer, parseCodexCommands, rewriteCodexSkillCommand } from "./codex.ts";
import { DAEMON_VENDORS, composerBaseOf, createVendorComposers } from "./index.ts";

const c = claudeComposerBase;

describe("命令列表的形状", () => {
  it("initialize 的 commands → {name, description, argumentHint?, builtin?}：空的参数提示不给，aliases 不要，builtin: true 留着", () => {
    expect(
      parseClaudeCommands([
        { name: "x", description: "probe command x (project)", argumentHint: "word" },
        { name: "clear", description: "Start a new session", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
        { name: "y", description: "probe skill y (project)", argumentHint: "" },
        { name: "slack:standup", description: "(slack) Generate a standup update" },
      ]),
    ).toEqual([
      { name: "x", description: "probe command x (project)", argumentHint: "word" },
      { name: "clear", description: "Start a new session", argumentHint: "[name]", builtin: true },
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
  const builtin = (name: string): ComposerCommand => ({ name, description: "", builtin: true });
  const user = (name: string): ComposerCommand => ({ name, description: "" });

  it("要求的隐藏名单都在（builtin 的）：会打乱会话的、和资料页打架的、只能在终端用的", () => {
    for (const name of ["clear", "model", "effort", "config", "login", "logout", "resume", "exit", "doctor", "color", "focus", "reload-plugins", "debug"]) {
      expect(c.isHiddenCommand(builtin(name)), name).toBe(true);
    }
    // 别名也拦：/clear 的 reset、new
    expect(c.isHiddenCommand(builtin("reset"))).toBe(true);
    expect(c.isHiddenCommand(builtin("new"))).toBe(true);
    for (const name of ["compact", "context", "usage", "init", "x", "slack:standup", "constructor", "toString"]) {
      expect(c.isHiddenCommand(builtin(name)), name).toBe(false);
    }
  });

  it("/design 和它的同类 design-consent、design-revoke 一样藏（账号相关，实测 builtin）", () => {
    for (const name of ["design", "design-consent", "design-revoke"]) {
      expect(c.isHiddenCommand(builtin(name)), name).toBe(true);
      expect(c.blockReason(`/${name}`, null), name).toMatch(/终端/);
    }
    // design-sync 是别的功能（推设计系统），不在名单里
    expect(c.isHiddenCommand(builtin("design-sync"))).toBe(false);
  });

  it("用户自己的命令、skill 叫 debug、new、reset 这类名字：列表里留着（只藏 builtin）", () => {
    for (const name of ["debug", "new", "reset", "clear", "model", "design"]) {
      expect(c.isHiddenCommand(user(name)), name).toBe(false);
    }
  });

  it("手打隐藏的命令：拦下，原因带命令名和用什么代替；带参数、大写也拦", () => {
    expect(c.blockReason("/clear", null)).toMatch(/^\/clear：.*开新会话/);
    expect(c.blockReason("/clear 新任务", null)).toMatch(/^\/clear：/);
    expect(c.blockReason("/reset", null)).toMatch(/开新会话/);
    expect(c.blockReason("/model opus", null)).toMatch(/资料页/);
    expect(c.blockReason("/Model", null)).toMatch(/资料页/);
    expect(c.blockReason("/doctor", null)).toMatch(/终端/);
    expect(c.blockReason("/login", null)).toMatch(/终端/);
  });

  it("手打：缓存里这个名字是用户自己的（不是 builtin）放行；是 builtin、列表里没有这个名字（别名）、没缓存都拦", () => {
    const known = [builtin("clear"), user("debug"), builtin("model"), user("New")];
    expect(c.blockReason("/debug", known)).toBeNull();
    expect(c.blockReason("/debug 参数", known)).toBeNull();
    expect(c.blockReason("/new", known)).toBeNull(); // 名字不分大小写
    expect(c.blockReason("/clear", known)).toMatch(/开新会话/);
    expect(c.blockReason("/model", known)).toMatch(/资料页/);
    // reset 是 clear 的别名，列表里没有这个名字：按名字拦
    expect(c.blockReason("/reset", known)).toMatch(/开新会话/);
    // 没问到过命令列表：宁可保守，按名字拦
    expect(c.blockReason("/debug", null)).toMatch(/^\/debug：/);
    expect(c.blockReason("/debug", [])).toMatch(/^\/debug：/);
    // 同名的 builtin 和用户的都在：有 builtin 就拦
    expect(c.blockReason("/debug", [user("debug"), builtin("debug")])).toMatch(/^\/debug：/);
  });

  it("不拦：普通命令、普通话、命令不在开头、前面有空格、只有一个 /", () => {
    for (const text of ["/compact", "/x 参数", "你好", "please run /clear", " /clear", "/", "/ clear", "/usr/bin/env"]) {
      expect(c.blockReason(text, null), text).toBeNull();
    }
  });

  it("每个隐藏命令都有原因（纯数据在 shared/vendors.ts）", () => {
    for (const [name, reason] of Object.entries(VENDOR_SPECS.claude.composer.blockedCommands)) {
      expect(name).toBe(name.toLowerCase());
      expect(reason.length, name).toBeGreaterThan(0);
    }
  });

  it("是不是压缩命令：/compact（带不带说明都算），别的不算", () => {
    expect(c.isCompactCommand("/compact")).toBe(true);
    expect(c.isCompactCommand("/compact 只留结论")).toBe(true);
    expect(c.isCompactCommand("/compacted")).toBe(false);
    expect(c.isCompactCommand(" /compact")).toBe(false);
    expect(c.isCompactCommand("请 /compact")).toBe(false);
    expect(c.isCompactCommand("/clear")).toBe(false);
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
    expect(c.blockReason("/clear/x", null)).toBeNull();
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

describe("厂商接口的完整性", () => {
  it("claude.ts 不引入起进程的代码（账本只要纯数据）：model-catalog 只能 import type", () => {
    const source = readFileSync(join(import.meta.dirname, "claude.ts"), "utf8");
    expect(source).not.toMatch(/^import (?!type\b)[^;]*model-catalog/mu);
    expect(source).not.toMatch(/node:child_process/u);
  });

  it("写进 agent 的内容经厂商接口拿；createVendorComposers 给每家都建出完整实现", () => {
    const composers = createVendorComposers({ claude: { claudePath: FAKE_CLAUDE, queryInitialize: queryClaudeInitialize } });
    expect(composers.claude.vendor).toBe("claude");
    expect(composers.agy.vendor).toBe("agy");
    expect(composers.codex.vendor).toBe("codex");
    expect(typeof composers.claude.queryCommands).toBe("function");
    expect(typeof composers.agy.queryCommands).toBe("function");
    expect(typeof composers.codex.queryCommands).toBe("function");
    expect(composers.claude.buildUserContent(["x"], "/y")).toEqual(composerBaseOf("claude")!.buildUserContent(["x"], "/y"));
  });

  it("DAEMON_VENDORS 汇总全部 AGENT_VENDORS 的 base、createComposer、probe、catalog、createDriver", () => {
    for (const vendor of AGENT_VENDORS) {
      const mod = DAEMON_VENDORS[vendor];
      expect(mod.base.vendor).toBe(vendor);
      expect(typeof mod.createComposer).toBe("function");
      expect(typeof mod.probe.parse).toBe("function");
      expect(typeof mod.catalog).toBe("function");
      expect(typeof mod.createDriver).toBe("function");
      const composer = mod.createComposer({ executablePath: vendor });
      expect(composer.vendor).toBe(vendor);
    }
  });
});

describe("按厂商找实现", () => {
  it("认识的厂商有，不认识的 null", () => {
    expect(composerBaseOf("claude")?.vendor).toBe("claude");
    expect(composerBaseOf("agy")?.vendor).toBe("agy");
    expect(composerBaseOf("codex")?.vendor).toBe("codex");
    expect(composerBaseOf("unknown")).toBeNull();
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
      const composer = createClaudeComposer({ claudePath: FAKE_CLAUDE, queryInitialize: queryClaudeInitialize, env: { ...process.env, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_LOG: log } });
      const commands = await composer.queryCommands({ cwd: dir, addDirs: ["/tmp"] }, new AbortController().signal);
      expect(commands).toEqual([{ name: "x", description: "d", argumentHint: "w" }]);
      const argv = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((e) => e.kind === "argv");
      expect(argv.argv).toEqual(expect.arrayContaining(["--add-dir", "/tmp", "--no-session-persistence"]));
      // 工作目录是项目目录，但不跑钩子、不连 MCP（docs/composer-commands.md 的 T10）
      expect(argv.cwd).toBe(realpathSync(dir));
      const settingsAt = argv.argv.indexOf("--settings");
      expect(JSON.parse(argv.argv[settingsAt + 1])).toEqual({ disableAllHooks: true });
      expect(argv.argv).toContain("--strict-mcp-config");
      expect(argv.argv).not.toContain("--mcp-config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("问不到（程序不存在）：失败带原因", async () => {
    const composer = createClaudeComposer({ claudePath: "/nonexistent/claude", queryInitialize: queryClaudeInitialize });
    await expect(composer.queryCommands({ cwd: "/tmp", addDirs: [] }, new AbortController().signal)).rejects.toThrow(/nonexistent/);
  });
});

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

  it("createAgyComposer：未传选项回退内置命令；传 agyPath 时跑 agy -p \"/skills\" --output-format json", async () => {
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
      const composer = createAgyComposer({ agyPath });
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

  it("createCodexComposer：未传选项回退内置命令；传 codexPath 时通过 app-server 发 skills/list", async () => {
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
      const composer = createCodexComposer({ codexPath });
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
