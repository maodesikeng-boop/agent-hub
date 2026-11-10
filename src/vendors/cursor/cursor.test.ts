import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, waitForExit } from "../../daemon/driver/process.ts";
import { MemorySessionStore } from "../../daemon/driver/test-helpers.ts";
import type { ReadonlySandboxInput, SpawnCommand } from "../../daemon/driver/write-scope.ts";
import { buildSetupEnv } from "../../daemon/setup/index.ts";
import {
  EMPTY_TOKEN_USAGE,
  MAX_CATALOG_MODELS,
  MAX_COMMANDS,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
} from "../../shared/index.ts";
import { linuxInstallDirs } from "../../shared/paths.ts";
import { describeStep, toolCategory } from "../../shared/step-labels.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import type { AcpDriverOptions } from "../_common/acp/index.ts";
import {
  createCursorCatalogSource,
  cursorCatalogProbe,
  parseCursorModelsText,
  parseStatusAvailability,
  queryCursorCatalog,
} from "./catalog.ts";
import { createCursorComposer, cursorComposerBase, parseCursorCommands } from "./composer.ts";
import cursorDaemon from "./daemon.ts";
import {
  classifyCursorTurnError,
  createCursorDriver,
  extractCursorErrorDetail,
  extractCursorToolUse,
  isCursorSessionNotFoundError,
  normalizeCursorBaseModel,
  resolveCursorModelValue,
} from "./driver.ts";
import { CURSOR_PROBE_MAX_STDOUT_BYTES } from "./limits.ts";
import * as cursorPaths from "./paths.ts";
import cursorSpec from "./spec.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP_AGENT = join(THIS_DIR, "..", "_common", "acp", "fixtures", "fake-acp-agent.ts");

const REAL_CURSOR_ACP_MODEL_OPTION: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "grok-4.7[effort=medium,fast=false]",
  options: [
    { value: "default[]", name: "Auto", description: "Balanced quality and speed, recommended for most tasks" },
    { value: "composer-2.5[fast=false]", name: "composer-2.5" },
    { value: "composer-2.5[fast=true]", name: "composer-2.5" },
    { value: "claude-opus-5-5[context=300k,effort=medium,fast=false]", name: "claude-opus-5-5" },
    { value: "claude-sonnet-5-5[context=200k,thinking=true]", name: "claude-sonnet-5-5" },
    { value: "claude-sonnet-4-6[context=200k,thinking=true]", name: "claude-sonnet-4-6" },
    { value: "gpt-5.6-sol[context=272k,effort=medium,fast=false]", name: "gpt-5.6-sol" },
    { value: "grok-4.7[effort=medium,fast=false]", name: "grok-4.7" },
  ],
};

/** 模拟本机 `cursor-agent models` 的真实输出（含零宽字符 \u200b、双空格与 (default)/(current) 标记）。 */
const REAL_CURSOR_MODELS_TEXT = [
  "\x1b[2K\x1b[GLoading models…",
  "Available models",
  "",
  "auto - Auto  (default)",
  "composer-2.5 - Composer 2.5",
  "composer-2.5-fast - Composer 2.5 Fast",
  "claude-opus-5-5-high - Claude Opus 5.5 1M High",
  "claude-sonnet-5-5-high - Claude Sonnet 5.5 High",
  "gpt-5.6-sol-high - GPT-5.6 Sol 1M High",
  "gemini-4-carbon-high - Gemini 4 Carbon High",
  "grok-4.7 - Grok 4.7\u200b  (current)",
  "grok-4.7-high-fast - Grok 4.7 High Fast\u200b",
  "",
  "Tip: use --model <id> (or /model in interactive mode) to switch.",
].join("\n");

function writeNodeScript(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("cursor spec 与 paths 声明边界", () => {
  it("思考档位只留单档（前端自动隐藏思考选择器），开启 explicitDefaultModel 与 ownSandboxOffArgs", () => {
    expect(cursorSpec.id).toBe("cursor");
    expect(cursorSpec.label).toBe("Cursor");
    expect(cursorSpec.models.efforts).toHaveLength(1);
    expect(cursorSpec.models.customModel).toBe(true);
    expect(cursorSpec.models.flags).toBeUndefined();
    expect(cursorSpec.capabilities).toEqual({
      backgroundWake: false,
      readonly: "os_sandbox",
      explicitDefaultModel: true,
      ownSandboxOffArgs: ["--sandbox", "disabled"],
    });
    expect(cursorSpec.models.shortName?.("auto")).toBe("Auto");
    expect(cursorSpec.models.shortName?.("default[]")).toBe("Auto");
    expect(cursorSpec.models.shortName?.("composer-2.5-fast")).toBe("Composer 2.5 Fast");
    expect(cursorSpec.models.shortName?.("grok-4.7-high-fast")).toBe("Grok 4.7 High Fast");
  });

  it("paths.ts 只剥离 Cursor 自身凭据，绝不剥离 GH_TOKEN / AWS / OPENAI_BASE_URL 等通用环境变量", () => {
    const names = cursorPaths.credentialEnv?.names ?? [];
    const prefixes = cursorPaths.credentialEnv?.prefixes ?? [];
    expect(names).toEqual(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_ACCESS_TOKEN"]);
    expect(prefixes).toEqual([]);
    for (const safe of ["GH_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "OPENAI_BASE_URL", "NPM_TOKEN"]) {
      expect(names).not.toContain(safe);
    }
    const sanitized = buildSetupEnv(
      {
        PATH: "/usr/bin",
        CURSOR_API_KEY: "secret-1",
        cursor_auth_token: "secret-2",
        CURSOR_ACCESS_TOKEN: "secret-3",
        GH_TOKEN: "ghp_keep",
        GITHUB_TOKEN: "ghs_keep",
        AWS_SECRET_ACCESS_KEY: "aws_keep",
        OPENAI_BASE_URL: "https://api.example.com/v1",
        NPM_TOKEN: "npm_keep",
      },
      { rootPath: "/repo", worktreePath: "/repo/.worktrees/1" },
    );
    expect(sanitized.CURSOR_API_KEY).toBeUndefined();
    expect(sanitized.cursor_auth_token).toBeUndefined();
    expect(sanitized.CURSOR_ACCESS_TOKEN).toBeUndefined();
    expect(sanitized.GH_TOKEN).toBe("ghp_keep");
    expect(sanitized.GITHUB_TOKEN).toBe("ghs_keep");
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBe("aws_keep");
    expect(sanitized.OPENAI_BASE_URL).toBe("https://api.example.com/v1");
    expect(sanitized.NPM_TOKEN).toBe("npm_keep");
    expect(
      cursorPaths.fallbackPaths!({
        userHome: "/Users/u",
        platform: "darwin",
        linuxInstallDirs: linuxInstallDirs("/Users/u"),
        join,
      }),
    ).toEqual(["/Users/u/.local/bin/cursor-agent"]);
    const linuxPaths = cursorPaths.fallbackPaths!({
      userHome: "/home/u",
      platform: "linux",
      linuxInstallDirs: linuxInstallDirs("/home/u"),
      join,
    });
    expect(linuxPaths[0]).toBe("/home/u/.local/bin/cursor-agent");
    expect(new Set(linuxPaths).size).toBe(linuxPaths.length);
  });

  it("daemon.ts 的 sessionFiles 指向 ~/.cursor/acp-sessions/<id> 且防路径穿越", () => {
    const roots = { home: "/Users/u", env: {} };
    expect(cursorDaemon.sessionFiles?.({ vendor: "cursor", vendorSessionId: "abc-123", cwd: "/repo" }, roots)).toEqual([
      "/Users/u/.cursor/acp-sessions/abc-123",
    ]);
    expect(cursorDaemon.sessionFiles?.({ vendor: "cursor", vendorSessionId: "../etc/passwd", cwd: "/repo" }, roots)).toEqual([]);
    expect(cursorDaemon.sessionFiles?.({ vendor: "cursor", vendorSessionId: "", cwd: "/repo" }, roots)).toEqual([]);
  });
});

describe("cursor catalog：模型列表解析、登录态、50 上限与进程组清理", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-cursor-cat-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("清洗 ANSI 与零宽字符，提取 current / auto 默认模型，每个模型 efforts 为空数组", () => {
    const catalog = parseCursorModelsText(REAL_CURSOR_MODELS_TEXT);
    expect(catalog).not.toBeNull();
    expect(catalog!.source).toBe("vendor");
    // 存在 (current) 项时优先取当前选中项；仅存在 auto (default) 时回退到 Auto
    expect(catalog!.defaultModel).toBe("Grok 4.7");
    expect(catalog!.defaultModelId).toBe("grok-4.7");
    expect(catalog!.defaultEfforts).toEqual([]);
    expect(catalog!.models.some((m) => m.id === "auto")).toBe(false);
    const grok = catalog!.models.find((m) => m.id === "grok-4.7");
    expect(grok).toEqual({
      id: "grok-4.7",
      label: "Grok 4.7",
      description: null,
      efforts: [],
    });
    expect(grok!.label).not.toContain("\u200b");

    const autoOnly = parseCursorModelsText("Available models\n\nauto - Auto  (default)\ncomposer-2.5 - Composer 2.5\n");
    expect(autoOnly?.defaultModel).toBe("Auto");
    expect(autoOnly?.defaultModelId).toBe("auto");
  });

  it("超过 50 个模型时严格截断至 MAX_CATALOG_MODELS，且各主流模型家族均有代表入选", () => {
    const lines = ["Available models", "", "auto - Auto  (default)"];
    // 故意先塞 60 个 claude 变体，再放 composer / gpt / gemini / grok / deepseek / kimi，验证代表家族优选不会让单一家族占满 50 个名额
    for (let i = 1; i <= 60; i++) {
      lines.push(`claude-variant-${i} - Claude Variant ${i}`);
    }
    lines.push(
      "composer-2.5 - Composer 2.5",
      "composer-2.5-fast - Composer 2.5 Fast",
      "gpt-5.6-sol-high - GPT-5.6 Sol 1M High",
      "gemini-4-carbon-high - Gemini 4 Carbon High",
      "grok-4.7-high-fast - Grok 4.7 High Fast",
      "deepseek-r2 - DeepSeek R2",
      "kimi-k2.5 - Kimi K2.5",
    );
    const catalog = parseCursorModelsText(lines.join("\n"));
    expect(catalog).not.toBeNull();
    expect(catalog!.models).toHaveLength(MAX_CATALOG_MODELS);
    const ids = new Set(catalog!.models.map((m) => m.id));
    for (const mustHave of [
      "composer-2.5",
      "composer-2.5-fast",
      "gpt-5.6-sol-high",
      "gemini-4-carbon-high",
      "grok-4.7-high-fast",
      "deepseek-r2",
      "kimi-k2.5",
    ]) {
      expect(ids.has(mustHave), mustHave).toBe(true);
    }
  });

  it("登录状态解析（兼容 isAuthenticated 与 authenticated）与空结果保护：空输出返回 null 不长期缓存", () => {
    expect(parseStatusAvailability({ isAuthenticated: true, email: "a@b.com" })).toBe("available");
    expect(parseStatusAvailability({ authenticated: true, email: "a@b.com" })).toBe("available");
    expect(parseStatusAvailability({ isAuthenticated: false })).toBe("signed_out");
    expect(parseStatusAvailability({ authenticated: false })).toBe("signed_out");
    expect(parseStatusAvailability("nonsense")).toBeNull();

    expect(
      cursorCatalogProbe.parse({
        modelsText: "",
        statusJson: { isAuthenticated: false },
      }),
    ).toBeNull();
    expect(
      cursorCatalogProbe.availabilityOf({
        modelsText: "",
        statusJson: { isAuthenticated: false },
      }),
    ).toBe("signed_out");
    expect(
      cursorCatalogProbe.availabilityOf({
        modelsText: null,
        statusJson: null,
        modelsError: "Not logged in. Please run cursor-agent login",
      }),
    ).toBe("signed_out");
  });

  it("queryCursorCatalog / createCursorCatalogSource：超时或中止时清理整个子进程组，超大输出封顶不爆内存", async () => {
    const childPidFile = join(dir, "sleeper.pid");
    const hangBin = writeNodeScript(
      join(dir, "cursor-hang"),
      `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "models") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
  setInterval(() => {}, 10000);
} else {
  // status 也挂起，让两边都走超时强杀路径并抛超时错误
  setInterval(() => {}, 10000);
}
`,
    );

    await expect(queryCursorCatalog({ cursorPath: hangBin, cwd: dir, timeoutMs: 1_500 })).rejects.toThrow(/timed out/);
    const sleeperPid = Number(readFileSync(childPidFile, "utf8").trim());
    expect(Number.isInteger(sleeperPid) && sleeperPid > 0).toBe(true);
    expect(await waitForExit(sleeperPid, 5_000)).toBe(true);
    expect(isAlive(sleeperPid)).toBe(false);

    // 验证超大 stdout 按 CURSOR_PROBE_MAX_STDOUT_BYTES 封顶，不会无界增长
    const floodBin = writeNodeScript(
      join(dir, "cursor-flood"),
      `
const argv = process.argv.slice(2);
if (argv[0] === "models") {
  process.stdout.write("Available models\\n\\ncomposer-2.5 - Composer 2.5\\n");
  const chunk = "x".repeat(64 * 1024) + "\\n";
  for (let i = 0; i < 20; i++) process.stdout.write(chunk);
  process.exit(0);
}
process.stdout.write(JSON.stringify({ isAuthenticated: true }) + "\\n");
`,
    );
    const floodRaw = await queryCursorCatalog({ cursorPath: floodBin, cwd: dir });
    expect(floodRaw.modelsText).not.toBeNull();
    expect(Buffer.byteLength(floodRaw.modelsText!, "utf8")).toBeLessThanOrEqual(CURSOR_PROBE_MAX_STDOUT_BYTES);
    const source = createCursorCatalogSource({ path: floodBin, cwd: dir, installed: () => true });
    const parsed = source.parse(floodRaw);
    expect(parsed?.models[0]?.id).toBe("composer-2.5");
  });
});

describe("cursor composer：本地命令扫描、阻塞拦截与 /compact 兜底", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-cursor-comp-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("空闲未起进程时扫描工作区与主目录 .cursor/commands、.cursor/skills、.agents/skills 并补齐 /compact，受 MAX_COMMANDS 保护", async () => {
    const home = join(dir, "home");
    const cwd = join(dir, "repo");
    mkdirSync(join(cwd, ".cursor", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "skills", "review-pr"), { recursive: true });
    mkdirSync(join(home, ".cursor", "skills", "deploy-check"), { recursive: true });

    writeFileSync(join(cwd, ".cursor", "commands", "fix-lint.md"), "# Fix Lint\n自动修复 lint 问题\n");
    writeFileSync(
      join(cwd, ".agents", "skills", "review-pr", "SKILL.md"),
      "---\ndescription: 审查当前 PR 的改动与测试覆盖\n---\n正文\n",
    );
    writeFileSync(
      join(home, ".cursor", "skills", "deploy-check", "SKILL.md"),
      "---\ndescription: 检查上线前配置\n---\n",
    );

    const composer = createCursorComposer({
      executablePath: "cursor-agent",
      env: { HOME: home },
    });

    const cmds = await composer.queryCommands({ cwd, addDirs: [] }, new AbortController().signal);
    expect(cmds.map((c) => c.name)).toEqual(["fix-lint", "review-pr", "deploy-check", "compact"]);
    expect(cmds.find((c) => c.name === "review-pr")?.description).toBe("审查当前 PR 的改动与测试覆盖");

    // 超过 MAX_COMMANDS 时严格截断且保留 /compact
    const huge = Array.from({ length: MAX_COMMANDS + 30 }, (_, i) => ({
      name: `cmd-${i}`,
      description: `desc ${i}`,
    }));
    const parsed = parseCursorCommands(huge)!;
    expect(parsed.length).toBeLessThanOrEqual(MAX_COMMANDS);
    expect(parsed.some((c) => c.name === "compact")).toBe(true);
  });

  it("拦截交互式斜杠命令，放行 /compact", () => {
    expect(cursorComposerBase.isCompactCommand("/compact")).toBe(true);
    expect(cursorComposerBase.blockReason("/compact", null)).toBeNull();
    for (const blocked of ["/login", "/logout", "/model", "/clear", "/resume", "/sandbox", "/mcp", "/vim"]) {
      expect(cursorComposerBase.blockReason(blocked, null), blocked).toMatch(/\S/);
      expect(
        cursorComposerBase.isHiddenCommand({ name: blocked.slice(1), description: "", builtin: true }),
        blocked,
      ).toBe(true);
      expect(cursorComposerBase.isHiddenCommand({ name: blocked.slice(1), description: "" }), blocked).toBe(false);
    }
  });
});

describe("cursor driver：ACP 常驻会话、阻塞扩展拦截、session/load 续接与只读沙箱", () => {
  let dir: string;
  let activeDrivers: Array<{ shutdown: () => Promise<void> }>;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-cursor-drv-")));
    activeDrivers = [];
  });

  afterEach(async () => {
    for (const d of activeDrivers.splice(0)) {
      await d.shutdown();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function setupHarness(options: {
    script?: FakeAcpScript;
    executablePath?: string;
    row?: Partial<AgentSessionRow>;
    defaultModel?: () => Promise<string | null>;
    readonlyWorker?: boolean;
    readonlySpawn?: AcpDriverOptions["readonlySpawn"];
  } = {}) {
    const cwd = join(dir, "workspace");
    const homeDir = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    const promptFile = join(dir, "system-prompt.md");
    writeFileSync(promptFile, "你是 Cursor 测试智能体。", "utf8");

    const scriptFile = join(dir, "fake-script.json");
    const logFile = join(dir, "fake-acp.log");
    const stateDir = join(dir, "fake-state");
    writeFileSync(
      scriptFile,
      JSON.stringify({
        initialConfigOptions: [REAL_CURSOR_ACP_MODEL_OPTION],
        ...(options.script ?? {}),
      } satisfies FakeAcpScript),
      "utf8",
    );

    const wrapperPath =
      options.executablePath ??
      writeNodeScript(
        join(dir, "cursor-agent"),
        `
const { spawn } = require("node:child_process");
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(FAKE_ACP_AGENT)}, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  process.exit(code ?? 0);
});
`,
      );

    const store = new MemorySessionStore();
    const row: AgentSessionRow = {
      id: 1,
      role: options.readonlyWorker ? "worker" : "pm",
      conversationId: 10,
      pmId: options.readonlyWorker ? null : 1,
      workerId: options.readonlyWorker ? 1 : null,
      vendor: "cursor",
      vendorSessionId: "",
      cwd,
      addDirs: [],
      generation: 1,
      model: "claude-opus-5-5-high",
      effort: null,
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: { ...EMPTY_TOKEN_USAGE },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...options.row,
    };
    store.add(row);

    const prepareLaunch = async (): Promise<LaunchFiles> => ({
      promptFile,
      env: {
        ...process.env,
        HOME: homeDir,
        FAKE_ACP_SCRIPT: scriptFile,
        FAKE_ACP_LOG: logFile,
        FAKE_ACP_STATE: stateDir,
      },
      fingerprint: "fp-cursor",
      ...(options.readonlyWorker
        ? {
            readonly: {
              secretPaths: [join(homeDir, ".cursor", "auth.json")],
              secretGlobs: ["**/.env"],
              connectors: { extraAllow: [], deny: [] },
            },
          }
        : {}),
    });

    const driver = createCursorDriver({
      store,
      executablePath: wrapperPath,
      prepareLaunch,
      log: () => {},
      ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
      ...(options.readonlySpawn ? { readonlySpawn: options.readonlySpawn } : {}),
    });
    activeDrivers.push(driver);

    const events: DriverEvent[] = [];
    driver.onEvent((_id, ev) => events.push(ev));

    const logs = (): FakeAcpLogEntry[] => {
      try {
        return readFileSync(logFile, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as FakeAcpLogEntry);
      } catch {
        return [];
      }
    };

    const waitForTurnEnd = async (count = 1): Promise<Extract<DriverEvent, { type: "turn.ended" }>> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const hits = events.filter((e): e is Extract<DriverEvent, { type: "turn.ended" }> => e.type === "turn.ended");
        if (hits.length >= count) return hits[count - 1]!;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for turn.ended #${count}; events=${events.map((e) => e.type).join(",")}`);
    };

    return { driver, store, events, logs, waitForTurnEnd, cwd, homeDir, logFile, stateDir };
  }

  it("模型映射纯函数：精确命中、auto -> default[]、CLI 档位变体归并、未知自定义模型返回 null 交由 CLI --model 处理", () => {
    expect(normalizeCursorBaseModel("claude-opus-5-5-high")).toBe("claude-opus-5-5");
    expect(normalizeCursorBaseModel("claude-4.6-sonnet-medium-thinking")).toBe("claude-sonnet-4-6");
    expect(normalizeCursorBaseModel("cursor-grok-4.7-high-fast")).toBe("grok-4.7");

    expect(resolveCursorModelValue("auto", REAL_CURSOR_ACP_MODEL_OPTION)).toBe("default[]");
    expect(resolveCursorModelValue("default", REAL_CURSOR_ACP_MODEL_OPTION)).toBe("default[]");
    expect(resolveCursorModelValue("claude-opus-5-5-high", REAL_CURSOR_ACP_MODEL_OPTION)).toBe(
      "claude-opus-5-5[context=300k,effort=medium,fast=false]",
    );
    expect(resolveCursorModelValue("claude-4.6-sonnet-medium-thinking", REAL_CURSOR_ACP_MODEL_OPTION)).toBe(
      "claude-sonnet-4-6[context=200k,thinking=true]",
    );
    expect(resolveCursorModelValue("brand-new-custom-model-2027", REAL_CURSOR_ACP_MODEL_OPTION)).toBeNull();
  });

  it("免 authenticate 直连 session/new；拦截 cursor/ask_question 与 cursor/create_plan 返回双层 outcome 不挂起；忽略扩展通知", async () => {
    const h = setupHarness({
      row: { model: null },
      defaultModel: async () => "auto",
      script: {
        turns: [
          {
            thoughtChunks: ["正在规划步骤"],
            customUpdates: [
              { sessionUpdate: "cursor/update_todos", payload: { todos: [{ id: "1", text: "测试" }] } },
              { sessionUpdate: "cursor/task", payload: { status: "running" } },
            ],
            extensionRequests: [
              {
                method: "cursor/ask_question",
                params: { questions: [{ id: "q1", prompt: "选哪个？" }] },
              },
              {
                method: "cursor/create_plan",
                params: { title: "执行计划", steps: ["步骤 1"] },
              },
              {
                method: "cursor/unknown_modal",
                params: {},
              },
            ],
            toolCalls: [
              {
                toolCallId: "tc-exec-1",
                title: "Terminal: pnpm test",
                kind: "execute",
                rawInput: { command: "pnpm test" },
              },
            ],
            textChunks: ["已完成检查，直接汇报。"],
            usage: { inputTokens: 120, outputTokens: 45, cachedReadTokens: 30, totalTokens: 195 },
          },
        ],
      },
    });

    await h.driver.send(1, { messageIds: [1], source: "user", text: "开始执行" });
    const ended = await h.waitForTurnEnd(1);
    expect(ended.ok).toBe(true);
    expect(ended.interrupted).toBe(false);

    const logEntries = h.logs();
    // 确认未调 authenticate，直接进 session/new，且命令行带上 --trust --approve-mcps --model auto acp
    expect(logEntries.some((e) => e.event === "authenticate")).toBe(false);
    const spawnLog = logEntries.find((e) => e.event === "spawn");
    expect(spawnLog?.argv).toEqual(["--trust", "--approve-mcps", "--model", "auto", "acp"]);

    // 默认模型 auto -> default[] 通过 session/set_config_option 显式覆盖 cli-config.json 粘性模型
    const cfgCalls = logEntries.filter((e) => e.event === "session/set_config_option");
    expect(cfgCalls).toEqual([
      expect.objectContaining({ configId: "model", value: "default[]" }),
    ]);

    // 核对 Cursor 私有阻塞请求返回的双层嵌套 outcome 结构
    const extResponses = logEntries.filter((e) => e.event === "extension_response");
    expect(extResponses).toEqual([
      expect.objectContaining({
        method: "cursor/ask_question",
        result: { outcome: { outcome: "cancelled" } },
      }),
      expect.objectContaining({
        method: "cursor/create_plan",
        result: {
          outcome: {
            outcome: "rejected",
            reason: expect.stringContaining("disabled"),
          },
        },
      }),
      expect.objectContaining({
        method: "cursor/unknown_modal",
        result: { outcome: { outcome: "cancelled" } },
      }),
    ]);

    // 验证仅带句子型 title + kind="execute" 的 ACP 工具调用被归一化为通用 command 工具
    const toolEvents = h.events.filter((e): e is Extract<DriverEvent, { type: "agent.tool" }> => e.type === "agent.tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]!.name).toBe("execute");
    expect(toolCategory(toolEvents[0]!.name)).toBe("command");
    expect(describeStep({ type: "tool_use", name: toolEvents[0]!.name, input: { command: "pnpm test" } })).toBe(
      "Running command",
    );

    const texts = h.events.filter((e): e is Extract<DriverEvent, { type: "agent.text" }> => e.type === "agent.text");
    expect(texts.map((t) => t.text)).toEqual(["已完成检查，直接汇报。"]);
  });

  it("extractCursorToolUse：保留已登记工具名与 mcp__ 前缀，仅对句子型 title 按 kind 归并", () => {
    expect(
      extractCursorToolUse({
        toolCallId: "1",
        title: "Read /repo/src/index.ts",
        kind: "read",
        locations: [{ path: "/repo/src/index.ts" }],
      }),
    ).toEqual({
      name: "read",
      input: { path: "/repo/src/index.ts" },
    });

    expect(
      extractCursorToolUse({
        toolCallId: "2",
        title: "mcp__github__get_pr",
        kind: "other",
        rawInput: { number: 1 },
      }),
    ).toEqual({
      name: "mcp__github__get_pr",
      input: { number: 1 },
    });
  });

  it("session/load 续接吞掉重放历史并保留命令更新（自动补齐 /compact）", async () => {
    const h = setupHarness({
      row: {
        vendorSessionId: "saved-cursor-sess-1",
        hasCompletedTurn: true,
        model: "claude-opus-5-5-high",
      },
      script: {
        knownSessions: ["saved-cursor-sess-1"],
        replayOnLoad: {
          userTexts: ["上一轮的用户提问"],
          thoughtTexts: ["上一轮的历史思考"],
          toolTitle: "Read old.ts",
          agentTexts: ["上一轮的历史回答"],
          commands: [{ name: "review", description: "Review code" }],
        },
        turns: [
          {
            textChunks: ["续接后的新一轮回复"],
          },
        ],
      },
    });

    await h.driver.send(1, { messageIds: [2], source: "user", text: "继续第二轮" });
    const ended = await h.waitForTurnEnd(1);
    expect(ended.ok).toBe(true);

    // 历史重放的消息、思考、工具调用全部被吞掉，只发出新一轮的文本
    expect(h.events.filter((e) => e.type === "agent.thinking")).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "agent.tool")).toHaveLength(0);
    const texts = h.events.filter((e): e is Extract<DriverEvent, { type: "agent.text" }> => e.type === "agent.text");
    expect(texts.map((t) => t.text)).toEqual(["续接后的新一轮回复"]);

    // 重放期间发出的 available_commands_update 被保留，且自动补上 /compact
    const cmds = await h.driver.queryCommands(1);
    expect(cmds?.map((c) => c.name)).toEqual(["review", "compact"]);

    // 续接轮不重复注入 <system_instructions>
    const promptLog = h.logs().find((e) => e.event === "session/prompt");
    expect(promptLog?.blocks).toEqual(["继续第二轮"]);
  });

  it("session/load 遇到 Cursor 特有的 -32602 data.message 会话不存在报错时自动回退 session/new", async () => {
    const reqErr = new RequestError(-32602, "Invalid params", { message: 'Session "gone-123" not found' });
    expect(extractCursorErrorDetail(reqErr)).toBe('Invalid params: Session "gone-123" not found');
    expect(isCursorSessionNotFoundError(reqErr)).toBe(true);
    expect(classifyCursorTurnError(new RequestError(-32603, "Internal error", { message: "Not logged in" }))).toEqual({
      subtype: "auth_required",
      message: "Internal error: Not logged in",
    });

    const loadFallbackAgent = writeNodeScript(
      join(dir, "cursor-load-32602"),
      `
const { createInterface } = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    out({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (req.method === "session/load") {
    out({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Invalid params", data: { message: 'Session "' + req.params.sessionId + '" not found' } },
    });
  } else if (req.method === "session/new") {
    out({ jsonrpc: "2.0", id: req.id, result: { sessionId: "fresh-cursor-sess-2", configOptions: [] } });
  } else if (req.method === "session/prompt") {
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fresh-cursor-sess-2",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已回退新建会话" } },
      },
    });
    out({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );

    const h = setupHarness({
      executablePath: loadFallbackAgent,
      row: {
        vendorSessionId: "stale-cursor-sess-1",
        hasCompletedTurn: true,
        model: "brand-new-custom-model",
      },
    });

    await h.driver.send(1, { messageIds: [5], source: "user", text: "你好" });
    const ended = await h.waitForTurnEnd(1);
    expect(ended.ok).toBe(true);
    expect(h.store.get(1)?.vendorSessionId).toBe("fresh-cursor-sess-2");
    const started = h.events.find((e): e is Extract<DriverEvent, { type: "session.started" }> => e.type === "session.started");
    expect(started?.resumed).toBe(false);
  });

  it("只读 Worker：前置 --sandbox disabled 传入沙箱包装器、补充 .cursor 运行时可写子目录，并在权限层拒绝写工具", async () => {
    let capturedBase: SpawnCommand | null = null;
    let capturedInput: ReadonlySandboxInput | null = null;

    const customReadonlySpawn: NonNullable<AcpDriverOptions["readonlySpawn"]> = (base, input) => {
      capturedBase = base;
      capturedInput = input;
      return { ...base, osSandboxed: true };
    };

    const prevHome = process.env.HOME;
    const isolatedHome = join(dir, "ro-home");
    for (const sub of ["acp-sessions", "chats", "projects", "ai-tracking", "logs"]) {
      mkdirSync(join(isolatedHome, ".cursor", sub), { recursive: true });
    }
    process.env.HOME = isolatedHome;

    try {
      const h = setupHarness({
        readonlyWorker: true,
        readonlySpawn: customReadonlySpawn,
        script: {
          turns: [
            {
              toolCalls: [
                {
                  toolCallId: "ro-read",
                  title: "Read README.md",
                  kind: "read",
                  requestPermission: { kind: "read" },
                },
                {
                  toolCallId: "ro-edit",
                  title: "Edit README.md",
                  name: "edit_file",
                  kind: "edit",
                  requestPermission: { kind: "edit", name: "edit_file" },
                },
              ],
              textChunks: ["只读检查完毕"],
            },
          ],
        },
      });

      await h.driver.send(1, { messageIds: [1], source: "user", text: "只读检查" });
      const ended = await h.waitForTurnEnd(1);
      expect(ended.ok).toBe(true);

      // 验证 ownSandboxOffArgs（--sandbox disabled）排在 --trust --approve-mcps --model ... acp 之前
      expect(capturedBase).not.toBeNull();
      expect(capturedBase!.args).toEqual([
        "--sandbox",
        "disabled",
        "--trust",
        "--approve-mcps",
        "--model",
        "claude-opus-5-5-high",
        "acp",
      ]);
      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.writableDirs).toEqual(
        expect.arrayContaining([
          join(isolatedHome, ".cursor", "acp-sessions"),
          join(isolatedHome, ".cursor", "chats"),
          join(isolatedHome, ".cursor", "projects"),
          join(isolatedHome, ".cursor", "ai-tracking"),
          join(isolatedHome, ".cursor", "logs"),
        ]),
      );
      expect(capturedInput!.writableFileGlobs).toContain(join(isolatedHome, ".cursor", "statsig-cache.json"));

      const perms = h.logs().filter((e) => e.event === "permission_outcome");
      expect(perms).toEqual([
        expect.objectContaining({
          toolCallId: "ro-read",
          outcome: { outcome: "selected", optionId: "allow-always" },
        }),
        expect.objectContaining({
          toolCallId: "ro-edit",
          outcome: { outcome: "selected", optionId: "reject-once" },
        }),
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("常驻进程异常崩溃时自动补杀同进程组残留后台子进程", async () => {
    const sleeperPidFile = join(dir, "acp-sleeper.pid");
    const h = setupHarness({
      script: {
        turns: [
          {
            spawnChildPidFile: sleeperPidFile,
            crashExitCode: 1,
          },
        ],
      },
    });

    await h.driver.send(1, { messageIds: [1], source: "user", text: "触发崩溃" });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !h.events.some((e) => e.type === "session.exited")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.events.some((e) => e.type === "session.exited")).toBe(true);

    const sleeperPid = Number(readFileSync(sleeperPidFile, "utf8").trim());
    expect(Number.isInteger(sleeperPid) && sleeperPid > 0).toBe(true);
    expect(await waitForExit(sleeperPid, 5_000)).toBe(true);
    expect(isAlive(sleeperPid)).toBe(false);
  });
});
