import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, waitForExit } from "../../daemon/driver/process.ts";
import { MemorySessionStore, realSleep } from "../../daemon/driver/test-helpers.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  type ReadonlySandboxInput,
} from "../../daemon/driver/write-scope.ts";
import { buildSetupEnv } from "../../daemon/setup/setup.ts";
import { SENSITIVE_HOME_PATHS } from "../../daemon/sent-files.ts";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  READONLY_SECRET_HOME_PATHS,
  agentLaunchArgs,
  buildReadonlyPolicy,
  notFoundCode,
  vendorFailureOf,
  vendorSpec,
  type AgentSessionRow,
  type Driver,
  type DriverEvent,
  type LaunchFiles,
  type ReadonlyPolicy,
  type SessionId,
} from "../../shared/index.ts";
import { vendorCatalogWatchFiles } from "../../shared/paths.ts";
import { describeStep, toolCategory } from "../../shared/step-labels.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "../_common/acp/fixtures/fake-acp-agent.ts";
import type { AcpDriverOptions } from "../_common/acp/index.ts";
import deepseekDaemon from "./daemon.ts";
import {
  DEEPSEEK_DEFAULT_PROVIDER,
  DEEPSEEK_READONLY_RUNTIME_SUBDIRS,
  DEEPSEEK_SANDBOX_PATCH_ENTRIES,
  DEEPSEEK_WRITE_TOOL_NAMES,
  buildDeepSeekPatchSettings,
  classifyDeepSeekTurnError,
  createDeepSeekDriver,
  isDeepSeekSessionNotFoundError,
  matchesDeepSeekStaleProcess,
  parseDeepSeekModelSpec,
  resolveDeepSeekEffortOptionValue,
  resolveDeepSeekModelOptionValue,
} from "./driver.ts";
import {
  credentialEnv,
  fallbackPaths,
  headlessLoginCommand,
  installCommand,
  parentSessionEnv,
  resolveDeepSeekHome,
} from "./paths.ts";
import deepseekSpec, { DEEPSEEK_HOME_REL } from "./spec.ts";

const FAKE_ACP_AGENT = new URL("../_common/acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;

const DSH_TUPLE_CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: JSON.stringify([DEEPSEEK_DEFAULT_PROVIDER, "deepseek-v4-pro"]),
    options: [
      { value: JSON.stringify([DEEPSEEK_DEFAULT_PROVIDER, "deepseek-v4-pro"]), name: "DeepSeek V4 Pro" },
      { value: JSON.stringify([DEEPSEEK_DEFAULT_PROVIDER, "deepseek-flash"]), name: "DeepSeek V4.1 Flash" },
      { value: JSON.stringify(["openrouter", "deepseek-r1"]), name: "DeepSeek R1 (OpenRouter)" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select" as const,
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

interface DeepSeekHarness {
  dir: string;
  cwd: string;
  dshHome: string;
  logDir: string;
  stateDir: string;
  store: MemorySessionStore;
  driver: Driver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
  readonlySpawns: Array<{ command: string; args: string[]; input: ReadonlySandboxInput }>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  logs(): FakeAcpLogEntry[];
  updateScript(next: FakeAcpScript): void;
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  setReadonly(policy: ReadonlyPolicy | null): void;
  launchDirOf(sessionId: SessionId): string;
  cleanup(): Promise<void>;
}

let nextSessionId = 500;

function makeDeepSeekHarness(options: {
  script?: FakeAcpScript;
  executablePath?: string;
  systemPrompt?: string;
  osSandboxed?: boolean;
  driverOptions?: Partial<AcpDriverOptions>;
} = {}): DeepSeekHarness {
  const rawDir = mkdtempSync(join(tmpdir(), "agent-hub-deepseek-test-"));
  const dir = realpathSync(rawDir);
  const cwd = join(dir, "workspace");
  const dshHome = join(dir, "dsh-home");
  const logDir = join(dir, "logs");
  const stateDir = join(dir, "state");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const scriptFile = join(logDir, "script.json");
  const logFile = join(logDir, "fake-dsh.jsonl");
  writeFileSync(
    scriptFile,
    JSON.stringify({
      loadSessionCapability: false,
      resumeCapability: true,
      closeCapability: true,
      initialConfigOptions: DSH_TUPLE_CONFIG_OPTIONS,
      ...options.script,
    } satisfies FakeAcpScript),
    "utf8",
  );

  const store = new MemorySessionStore();
  let readonlyPolicy: ReadonlyPolicy | null = null;
  const readonlySpawns: Array<{ command: string; args: string[]; input: ReadonlySandboxInput }> = [];
  const osSandboxed = options.osSandboxed ?? true;

  const launchDirOf = (sessionId: SessionId) => join(dir, "launch", String(sessionId));

  const driver = createDeepSeekDriver({
    executablePath: options.executablePath ?? FAKE_ACP_AGENT,
    store,
    env: { ...process.env, DSH_HOME: dshHome },
    idleCloseMs: 60_000,
    interruptGraceMs: 2_000,
    startTimeoutMs: 10_000,
    shutdownGraceMs: 3_000,
    log: () => {},
    readonlySpawn: (base, input) => {
      readonlySpawns.push({ command: base.command, args: [...base.args], input });
      return { command: base.command, args: [...base.args], osSandboxed };
    },
    prepareLaunch: async (row): Promise<LaunchFiles> => {
      const sDir = launchDirOf(row.id);
      mkdirSync(sDir, { recursive: true });
      const promptFile = join(sDir, "system-prompt.md");
      writeFileSync(promptFile, options.systemPrompt ?? "你是 DeepSeek 测试智能体。", "utf8");
      const built = deepseekDaemon.launchFiles!({
        role: row.role === "assistant" ? "pm" : row.role,
        hubSock: join(dir, "hub.sock"),
        stateDir,
        osSandboxed,
      });
      const settingsFile = join(sDir, "settings.json");
      if (built.settings !== undefined) {
        writeFileSync(settingsFile, built.settings, "utf8");
      }
      return {
        promptFile,
        ...(built.settings !== undefined ? { settingsFile } : {}),
        fingerprint: "fp-ds-1",
        env: {
          ...built.env,
          DSH_HOME: dshHome,
          FAKE_ACP_SCRIPT: scriptFile,
          FAKE_ACP_LOG: logFile,
          FAKE_ACP_STATE: stateDir,
        },
        ...(readonlyPolicy ? { readonly: readonlyPolicy } : {}),
      };
    },
    ...options.driverOptions,
  });

  const events: Array<{ sessionId: SessionId; event: DriverEvent }> = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
    for (const wake of waiters.splice(0)) wake();
  });

  const of = <T extends DriverEvent["type"]>(type: T) =>
    events.map((e) => e.event).filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

  const waitFor = async <T extends DriverEvent["type"]>(
    type: T,
    pred: (e: Extract<DriverEvent, { type: T }>) => boolean = () => true,
    count = 1,
  ): Promise<Extract<DriverEvent, { type: T }>> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const matched = of(type).filter(pred);
      if (matched.length >= count) return matched[count - 1]!;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${type} (count=${count}), got: ${events.map((x) => x.event.type).join(",")}`);
      }
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        realSleep(30),
      ]);
    }
  };

  const logs = (): FakeAcpLogEntry[] => {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as FakeAcpLogEntry);
  };

  const addSession = (patch: Partial<AgentSessionRow> = {}): AgentSessionRow => {
    const id = (nextSessionId += 1) as SessionId;
    const now = Date.now();
    const row: AgentSessionRow = {
      id,
      role: "worker",
      conversationId: null,
      pmId: null,
      workerId: null,
      vendor: "deepseek",
      vendorSessionId: `init-ds-${id}`,
      cwd,
      addDirs: [],
      generation: 1,
      model: null,
      effort: null,
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: { ...EMPTY_TOKEN_USAGE },
      createdAt: now,
      updatedAt: now,
      ...patch,
    };
    store.add(row);
    return row;
  };

  return {
    dir,
    cwd,
    dshHome,
    logDir,
    stateDir,
    store,
    driver,
    events,
    readonlySpawns,
    of,
    waitFor,
    logs,
    updateScript: (next) => {
      writeFileSync(
        scriptFile,
        JSON.stringify({
          loadSessionCapability: false,
          resumeCapability: true,
          closeCapability: true,
          initialConfigOptions: DSH_TUPLE_CONFIG_OPTIONS,
          ...next,
        } satisfies FakeAcpScript),
        "utf8",
      );
    },
    addSession,
    setReadonly: (policy) => {
      readonlyPolicy = policy;
    },
    launchDirOf,
    cleanup: async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const activeHarnesses: DeepSeekHarness[] = [];
function track(h: DeepSeekHarness): DeepSeekHarness {
  activeHarnesses.push(h);
  return h;
}

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const h = activeHarnesses.pop()!;
    await h.cleanup();
  }
});

describe("deepseek 声明（spec.ts）与路径/凭据边界（paths.ts）", () => {
  it("spec 元数据、模型档位、工具动作映射、敏感路径与无 CLI 模型参数符合设计", () => {
    expect(vendorSpec("deepseek")).toBe(deepseekSpec);
    expect(deepseekSpec.id).toBe("deepseek");
    expect(deepseekSpec.label).toBe("DeepSeek");
    expect(deepseekSpec.cli).toEqual({
      command: "dsh",
      envVar: "AGENT_HUB_DEEPSEEK",
      loginCommand: "dsh",
    });
    expect(deepseekSpec.capabilities).toEqual({
      backgroundWake: false,
      readonly: "os_sandbox",
    });
    expect(deepseekSpec.models.flags).toBeUndefined();
    expect(agentLaunchArgs({ vendor: "deepseek", model: "deepseek-v4-pro", effort: "max" })).toEqual([]);
    expect(deepseekSpec.models.bundled.map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
    expect(deepseekSpec.models.efforts).toEqual(["off", "low", "high", "max"]);
    expect(deepseekSpec.models.customModel).toBe(true);
    expect(deepseekSpec.handover?.transcriptPortable).toBe(false);

    // shortName 兼容裸模型名、provider/model 与 dsh-acp 二元组 JSON
    expect(deepseekSpec.models.shortName?.("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(deepseekSpec.models.shortName?.("deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(deepseekSpec.models.shortName?.("deepseek-reasoner")).toBe("DeepSeek Reasoner");
    expect(deepseekSpec.models.shortName?.('["deepseek-official","deepseek-v4-pro"]')).toBe("DeepSeek V4 Pro");
    expect(deepseekSpec.models.shortName?.("openrouter/deepseek-chat")).toBe("DeepSeek Chat");
    expect(deepseekSpec.models.shortName?.("qwen-max")).toBeNull();

    // 工具动作映射接入公共 step-labels
    expect(toolCategory("pwsh")).toBe("command");
    expect(toolCategory("subagent_fork")).toBe("other");
    expect(describeStep({ type: "tool_use", name: "subagent_fork", input: {} })).toBe("Running subagent");
    expect(describeStep({ type: "tool_use", name: "read_image", input: { file_path: "/a/b/pic.png" } })).toContain("pic.png");

    // 敏感路径与 DSH_HOME 重定向
    expect(SENSITIVE_HOME_PATHS).toContain(DEEPSEEK_HOME_REL);
    expect(READONLY_SECRET_HOME_PATHS).toContain(".dsh/.credentials.yaml");
    expect(READONLY_SECRET_HOME_PATHS).toContain(".dsh/.env");
    expect(vendorCatalogWatchFiles("deepseek", "/Users/u", {})).toEqual([
      "/Users/u/.dsh/.credentials.yaml",
      "/Users/u/.dsh/.env",
      "/Users/u/.dsh/cordis.patch.yml",
    ]);
    expect(vendorCatalogWatchFiles("deepseek", "/Users/u", { DSH_HOME: "/custom/dsh" })).toEqual([
      "/custom/dsh/.credentials.yaml",
      "/custom/dsh/.env",
      "/custom/dsh/cordis.patch.yml",
    ]);
  });

  it("installCommand 钉死精确预览版版本号，fallbackPaths 与 resolveDeepSeekHome 覆盖双平台", () => {
    expect(installCommand).toBe("npm install -g @deepseek-ai/dsh@0.2.2-rc.1");
    expect(headlessLoginCommand).toContain("~/.dsh/.env");
    expect(headlessLoginCommand).toContain("dsh");

    expect(resolveDeepSeekHome("/home/alice", {})).toBe("/home/alice/.dsh");
    expect(resolveDeepSeekHome("/home/alice", { DSH_HOME: "  /opt/dsh-data  " })).toBe("/opt/dsh-data");
    expect(resolveDeepSeekHome("/home/alice", { DSH_HOME: "   " })).toBe("/home/alice/.dsh");

    const macPaths = fallbackPaths!({
      userHome: "/Users/alice",
      platform: "darwin",
      linuxInstallDirs: ["/usr/local/bin"],
      join: (...parts) => parts.join("/"),
    });
    expect(macPaths).toEqual([
      "/Users/alice/.local/bin/dsh",
      "/Users/alice/.local/share/mise/shims/dsh",
      "/Users/alice/.nvm/current/bin/dsh",
      "/Users/alice/.npm-global/bin/dsh",
      "/opt/homebrew/bin/dsh",
      "/usr/local/bin/dsh",
    ]);

    const linuxPaths = fallbackPaths!({
      userHome: "/home/alice",
      platform: "linux",
      linuxInstallDirs: ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"],
      join: (...parts) => parts.join("/"),
    });
    expect(linuxPaths).toContain("/home/alice/.local/bin/dsh");
    expect(linuxPaths).toContain("/home/linuxbrew/.linuxbrew/bin/dsh");
  });

  it("buildSetupEnv 仅剥离 DeepSeek 专属凭据与 dsh 子 shell 会话变量，严格保留 GH_TOKEN / AWS / OPENAI_BASE_URL / DSH_HOME", () => {
    expect(credentialEnv).toEqual({
      names: ["DEEPSEEK_API_KEY"],
      prefixes: ["DEEPSEEK_", "DSH_API_"],
    });
    expect(parentSessionEnv).toEqual(["DSH_SHELL", "DSH_SESSION_ID", "DSH_PROFILE", "DSH_PROFILE_DIR"]);

    const baseEnv = {
      DEEPSEEK_API_KEY: "sk-secret",
      deepseek_api_key: "sk-lower",
      DEEPSEEK_BASE_URL: "https://secret-proxy.example",
      DSH_API_TOKEN: "tok-secret",
      DSH_SHELL: "1",
      DSH_SESSION_ID: "sess-parent",
      DSH_PROFILE: "acp",
      DSH_PROFILE_DIR: "/tmp/p",
      DSH_HOME: "/Users/dev/.dsh-custom",
      GH_TOKEN: "ghp_keep",
      GITHUB_TOKEN: "ghs_keep",
      AWS_SECRET_ACCESS_KEY: "aws_keep",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      NPM_TOKEN: "npm_keep",
      PATH: "/usr/bin:/bin",
    };
    const out = buildSetupEnv(baseEnv, { rootPath: "/repo", worktreePath: "/repo-wt" });
    expect(out).toEqual({
      DSH_HOME: "/Users/dev/.dsh-custom",
      GH_TOKEN: "ghp_keep",
      GITHUB_TOKEN: "ghs_keep",
      AWS_SECRET_ACCESS_KEY: "aws_keep",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      NPM_TOKEN: "npm_keep",
      PATH: "/usr/bin:/bin",
      [ENV_SETUP_ROOT_PATH]: "/repo",
      [ENV_SETUP_WORKTREE_PATH]: "/repo-wt",
    });
  });
});

describe("deepseek 驱动（driver.ts + daemon.ts）：--patch 启动配置、续接、模型档位、只读沙箱与错误分类", () => {
  it("launchFiles 生成关闭自带沙箱的 danger-full-access patch 文件，并屏蔽 dsh-acp 不支持的 additionalDirectories", async () => {
    const h = track(
      makeDeepSeekHarness({
        systemPrompt: "请严格遵守项目经理指令。",
        script: {
          turns: [{ textChunks: ["首轮完成"] }, { textChunks: ["次轮完成"] }],
        },
      }),
    );

    const extraDir = join(h.dir, "extra-shared-dir");
    mkdirSync(extraDir, { recursive: true });
    const row = h.addSession({
      addDirs: [extraDir],
      model: "openrouter/deepseek-r1",
      effort: "max",
    });

    await h.driver.send(row.id, { messageIds: [1 as never], source: "user", text: "你好 dsh" });
    await h.waitFor("turn.ended");

    const launchDir = h.launchDirOf(row.id);
    const settingsPath = join(launchDir, "settings.json");
    const modelPatchPath = join(launchDir, "dsh-model.patch.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(modelPatchPath)).toBe(true);

    // 1. 核对关闭自带 Seatbelt/bwrap 沙箱的 Cordis overlay patch
    const settingsPatch = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settingsPatch).toEqual(DEEPSEEK_SANDBOX_PATCH_ENTRIES);
    expect(buildDeepSeekPatchSettings()).toBe(`${JSON.stringify(DEEPSEEK_SANDBOX_PATCH_ENTRIES, null, 2)}\n`);

    // 2. 核对模型路由 patch（openrouter/deepseek-r1 -> provider="openrouter", model="deepseek-r1"）
    const modelPatch = JSON.parse(readFileSync(modelPatchPath, "utf8"));
    expect(modelPatch).toEqual([{ id: "acp", config: { provider: "openrouter", model: "deepseek-r1" } }]);

    // 3. 核对 dsh 真实启动参数顺序
    const spawnLog = h.logs().find((e) => e.event === "spawn");
    expect(spawnLog?.argv).toEqual(["--profile", "acp", "--patch", settingsPath, "--patch", modelPatchPath]);

    // 4. 核对未调用 authenticate，且 session/new 未携带会导致 -32602 的 additionalDirectories
    expect(h.logs().some((e) => e.event === "authenticate")).toBe(false);
    const newLog = h.logs().find((e) => e.event === "session/new");
    expect(newLog?.params).toMatchObject({ cwd: h.cwd, mcpServers: [] });
    expect((newLog?.params as Record<string, unknown>)?.additionalDirectories).toBeUndefined();

    // 5. 核对模型与思考程度通过 session/set_config_option 写入二元组与档位
    const setLogs = h.logs().filter((e) => e.event === "session/set_config_option");
    expect(setLogs.map((e) => ({ configId: e.configId, value: e.value }))).toEqual([
      { configId: "model", value: JSON.stringify(["openrouter", "deepseek-r1"]) },
      { configId: "reasoning_effort", value: "max" },
    ]);

    // 6. 首轮注入 <system_instructions>，同进程第二轮不重复注入
    await h.driver.send(row.id, { messageIds: [2 as never], source: "user", text: "继续第二轮" });
    await h.waitFor("turn.ended", () => true, 2);
    const prompts = h.logs().filter((e) => e.event === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.blocks).toEqual([
      "<system_instructions>\n请严格遵守项目经理指令。\n</system_instructions>",
      "你好 dsh",
    ]);
    expect(prompts[1]!.blocks).toEqual(["继续第二轮"]);
  });

  it("跨进程 session/resume 续接不重放历史；遇到 dsh-acp 的 -32602 'session is not resumable' 时自动回退 session/new", async () => {
    const h = track(
      makeDeepSeekHarness({
        systemPrompt: "系统规则提示词",
        driverOptions: { idleCloseMs: 40 },
        script: {
          turns: [{ textChunks: ["第一进程回复"] }, { textChunks: ["跨进程续接回复"] }],
        },
      }),
    );

    const row = h.addSession({ model: "deepseek-flash", effort: "low" });
    await h.driver.send(row.id, { messageIds: [11 as never], source: "user", text: "第一轮" });
    await h.waitFor("turn.ended");

    const savedSessionId = h.store.get(row.id)!.vendorSessionId!;
    expect(savedSessionId).toMatch(/^fake-sess-/);

    // 等待空闲回收关闭旧进程，模拟跨进程恢复
    const idleExited = await h.waitFor("session.exited");
    expect(idleExited.reason).toBe("idle");
    h.store.update(row.id, { hasCompletedTurn: true });

    await h.driver.send(row.id, { messageIds: [12 as never], source: "user", text: "跨进程第二轮" });
    await h.waitFor("turn.ended", () => true, 2);

    const resumeLogs = h.logs().filter((e) => e.event === "session/resume");
    expect(resumeLogs).toHaveLength(1);
    expect(resumeLogs[0]!.sessionId).toBe(savedSessionId);
    expect((resumeLogs[0]!.params as Record<string, unknown>)?.additionalDirectories).toBeUndefined();
    expect(h.logs().some((e) => e.event === "session/load")).toBe(false);
    expect(h.of("session.started")[1]!.resumed).toBe(true);
    // 续接首轮不重复注入系统提示词
    const prompts = h.logs().filter((e) => e.event === "session/prompt");
    expect(prompts[1]!.blocks).toEqual(["跨进程第二轮"]);

    // 模拟真实 dsh-acp 对失效会话抛 -32602 "Invalid params: session is not resumable: <id>"
    const customFakeDsh = join(h.dir, "fake-dsh-unresumable.mjs");
    writeFileSync(
      customFakeDsh,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "dsh", version: "0.2.2-rc.1" },
        agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {}, close: {} } },
      },
    });
    return;
  }
  if (req.method === "session/resume") {
    out({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: "Invalid params: session is not resumable: " + req.params.sessionId },
    });
    return;
  }
  if (req.method === "session/new") {
    if (req.params?.additionalDirectories !== undefined) {
      out({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "Invalid params: additionalDirectories is not supported" },
      });
      return;
    }
    out({ jsonrpc: "2.0", id: req.id, result: { sessionId: "fresh-dsh-session-99", configOptions: [] } });
    return;
  }
  if (req.method === "session/prompt") {
    const joined = (req.params?.prompt || []).map((b) => b.text || "").join("\\n");
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fresh-dsh-session-99",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回退后收到:" + joined } },
      },
    });
    out({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
});
`,
      "utf8",
    );
    chmodSync(customFakeDsh, 0o755);

    const hFallback = track(
      makeDeepSeekHarness({
        executablePath: customFakeDsh,
        systemPrompt: "回退补发的系统提示",
      }),
    );
    const staleRow = hFallback.addSession({
      vendorSessionId: "expired-dsh-uuid",
      hasCompletedTurn: true,
      addDirs: [hFallback.logDir],
    });
    await hFallback.driver.send(staleRow.id, { messageIds: [13 as never], source: "user", text: "继续旧会话" });
    await hFallback.waitFor("turn.ended");

    expect(hFallback.of("session.started")[0]!.resumed).toBe(false);
    expect(hFallback.store.get(staleRow.id)!.vendorSessionId).toBe("fresh-dsh-session-99");
    expect(hFallback.of("agent.text")[0]!.text).toContain("<system_instructions>\n回退补发的系统提示\n</system_instructions>");
  });

  it("模型与思考程度纯函数解析：兼容二元组、provider/model、裸模型名及名单外自定义模型", () => {
    expect(parseDeepSeekModelSpec("deepseek-v4-pro")).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      explicitProvider: false,
    });
    expect(parseDeepSeekModelSpec("openrouter/deepseek/deepseek-r1")).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-r1",
      explicitProvider: true,
    });
    expect(parseDeepSeekModelSpec('["my-route","my-model"]')).toEqual({
      provider: "my-route",
      model: "my-model",
      explicitProvider: true,
    });

    const modelOption = DSH_TUPLE_CONFIG_OPTIONS[0]!;
    const effortOption = DSH_TUPLE_CONFIG_OPTIONS[1]!;

    expect(resolveDeepSeekModelOptionValue("deepseek-v4-pro", modelOption)).toBe(
      JSON.stringify(["deepseek-official", "deepseek-v4-pro"]),
    );
    expect(resolveDeepSeekModelOptionValue("DEEPSEEK-FLASH", modelOption)).toBe(
      JSON.stringify(["deepseek-official", "deepseek-flash"]),
    );
    expect(resolveDeepSeekModelOptionValue("openrouter/deepseek-r1", modelOption)).toBe(
      JSON.stringify(["openrouter", "deepseek-r1"]),
    );
    // 名单外自定义模型在二元组候选表中返回 null（交由启动期 --patch dsh-model.patch.json 生效，避免 set_config_option 抛 -32602）
    expect(resolveDeepSeekModelOptionValue("my-private-deepseek-v5", modelOption)).toBeNull();

    expect(resolveDeepSeekEffortOptionValue("off", effortOption)).toBe("off");
    expect(resolveDeepSeekEffortOptionValue("MAX", effortOption)).toBe("max");
    expect(resolveDeepSeekEffortOptionValue("medium", effortOption)).toBeNull();

    expect(isDeepSeekSessionNotFoundError(new Error("Invalid params: session is not resumable: abc-123"))).toBe(true);
    expect(isDeepSeekSessionNotFoundError(new Error("Invalid params: additionalDirectories is not supported"))).toBe(false);
  });

  it("只读 Worker：外层 OS 沙箱放行 .dsh 运行时子目录（禁写根目录）+ ACP 权限拦截 dsh 写工具与未标只读 MCP", async () => {
    // 1. OS 沙箱不可用时拒绝启动只读 Worker
    const hUnavailable = track(makeDeepSeekHarness({ osSandboxed: false }));
    hUnavailable.setReadonly(buildReadonlyPolicy({ homeDir: homedir(), stateDir: join(hUnavailable.dir, "ro-state") }));
    const failRow = hUnavailable.addSession();
    await expect(
      hUnavailable.driver.send(failRow.id, { messageIds: [21 as never], source: "user", text: "只读测试" }),
    ).rejects.toThrow(WORKER_NEEDS_OS_SANDBOX_MESSAGE);

    // 2. 外层 OS 沙箱可用时：验证 writableDirs / writableFileGlobs / secretPaths 与 ACP 权限裁决
    const h = track(
      makeDeepSeekHarness({
        script: {
          turns: [
            {
              toolCalls: [
                {
                  toolCallId: "tc-read",
                  title: "Read file",
                  name: "read",
                  kind: "read",
                  requestPermission: { name: "read", kind: "read" },
                },
                {
                  toolCallId: "tc-bash",
                  title: "Run git status",
                  name: "bash",
                  kind: "execute",
                  requestPermission: { name: "bash", kind: "execute" },
                },
                {
                  toolCallId: "tc-pwsh-write-list",
                  title: "Run pwsh",
                  name: "pwsh",
                  kind: "execute",
                  requestPermission: { name: "pwsh", kind: "execute" },
                },
                {
                  toolCallId: "tc-write",
                  title: "Write file",
                  name: "write",
                  kind: "edit",
                  requestPermission: { name: "write", kind: "edit" },
                },
                {
                  toolCallId: "tc-todo",
                  title: "Update todos",
                  name: "todo_write",
                  kind: "read",
                  requestPermission: { name: "todo_write", kind: "read" },
                },
                {
                  toolCallId: "tc-mcp-ro",
                  title: "MCP readonly search",
                  name: "mcp__docs__search",
                  kind: "search",
                  requestPermission: {
                    name: "mcp__docs__search",
                    kind: "search",
                    meta: { mcp: { server: "docs", tool: "search", annotations: { readOnlyHint: true } } },
                  },
                },
                {
                  toolCallId: "tc-mcp-unmarked",
                  title: "MCP unmarked tool",
                  name: "mcp__docs__mutate",
                  kind: "execute",
                  requestPermission: {
                    name: "mcp__docs__mutate",
                    kind: "execute",
                    meta: { mcp: { server: "docs", tool: "mutate", annotations: { readOnlyHint: false } } },
                  },
                },
              ],
              textChunks: ["只读检查完毕"],
            },
          ],
        },
      }),
    );

    const ownCredFile = join(h.dshHome, ".credentials.yaml");
    const ownEnvFile = join(h.dshHome, ".env");
    const otherVendorSecret = join(h.dir, "other-vendor-secret.json");
    writeFileSync(ownCredFile, "version: 1\n", { mode: 0o600 });
    writeFileSync(ownEnvFile, "DEEPSEEK_API_KEY=sk-test\n", { mode: 0o600 });
    writeFileSync(otherVendorSecret, "{}", { mode: 0o600 });

    const basePolicy = buildReadonlyPolicy({ homeDir: homedir(), stateDir: join(h.dir, "ro-state") });
    h.setReadonly({
      ...basePolicy,
      secretPaths: [...basePolicy.secretPaths, ownCredFile, ownEnvFile, otherVendorSecret],
    });

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [22 as never], source: "user", text: "执行只读任务" });
    await h.waitFor("turn.ended");

    expect(h.readonlySpawns).toHaveLength(1);
    const spawned = h.readonlySpawns[0]!;
    // 内部仍传 --profile acp --patch <settings.json>（danger-full-access），避免嵌套沙箱冲突
    expect(spawned.args.slice(0, 3)).toEqual(["--profile", "acp", "--patch"]);

    // .dsh 运行时非敏感子目录全部加入可写目录，但 .dsh 根目录绝不可写（防止篡改 .credentials.yaml / cordis.patch.yml）
    for (const sub of DEEPSEEK_READONLY_RUNTIME_SUBDIRS) {
      expect(spawned.input.writableDirs).toContain(realpathSync(join(h.dshHome, sub)));
    }
    expect(spawned.input.writableDirs).not.toContain(realpathSync(h.dshHome));
    expect(spawned.input.writableFileGlobs).toContain(join(realpathSync(h.dshHome), ".anonymous-user-id"));

    // 自身的 .credentials.yaml 从只读禁读列表移除（保留只读、禁写，防 dsh-credentials-local 启动期 EPERM/0666 报错），别家敏感文件仍在禁读列表
    expect(spawned.input.secretPaths).not.toContain(realpathSync(ownCredFile));
    expect(spawned.input.secretPaths).toContain(otherVendorSecret);

    // 核对 ACP request_permission 裁决结果
    const outcomes = Object.fromEntries(
      h
        .logs()
        .filter((e) => e.event === "permission_outcome")
        .map((e) => [e.toolCallId, (e.outcome as { optionId?: string }).optionId]),
    );
    expect(outcomes).toEqual({
      "tc-read": "allow-always",
      "tc-bash": "allow-always",
      "tc-pwsh-write-list": "reject-once",
      "tc-write": "reject-once",
      "tc-todo": "reject-once",
      "tc-mcp-ro": "allow-always",
      "tc-mcp-unmarked": "reject-once",
    });
    expect(DEEPSEEK_WRITE_TOOL_NAMES).toEqual(
      expect.arrayContaining(["write", "edit", "apply_patch", "todo_write", "create_goal", "pwsh"]),
    );
  });

  it("认证缺失/失效、HTTP 402 余额不足与 429 限流错误精准归类到 DeepSeek", async () => {
    // 1. 纯函数分类与 vendorFailureOf 联动校验
    for (const sample of [
      'no API key for provider route "deepseek-official"',
      "Missing API key: please set DEEPSEEK_API_KEY",
      "HTTP 401 authentication_error: api key fails",
      "ACCOUNT_TOKEN_INVALID: session expired",
      "ACCOUNT_SIGN_IN_REQUIRED",
    ]) {
      const classified = classifyDeepSeekTurnError(new Error(sample));
      expect(vendorFailureOf(classified.message, "deepseek"), sample).toEqual({
        kind: "auth",
        serviceName: "DeepSeek",
      });
    }

    for (const sample of [
      "HTTP 402: Insufficient Balance",
      "API error: insufficient_balance",
      "429 Too Many Requests: rate_limit_error",
    ]) {
      const classified = classifyDeepSeekTurnError(new Error(sample));
      expect(vendorFailureOf(classified.message, "deepseek"), sample).toEqual({
        kind: "quota",
        serviceName: "DeepSeek",
      });
    }

    expect(vendorFailureOf(`${notFoundCode("deepseek")}: spawn dsh ENOENT`)).toEqual({
      kind: "missing",
      serviceName: "DeepSeek",
    });

    // 2. 真实驱动回合遇到 402 Insufficient Balance 与缺失 DEEPSEEK_API_KEY
    const h = track(
      makeDeepSeekHarness({
        script: {
          turns: [
            { throwRpcError: { code: -32603, message: 'no API key for provider route "deepseek-official"' } },
            { throwRpcError: { code: -32603, message: "HTTP 402: Insufficient Balance" } },
          ],
        },
      }),
    );

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [31 as never], source: "user", text: "无 key 调用" });
    const firstEnd = await h.waitFor("turn.ended");
    expect(firstEnd.ok).toBe(false);
    expect(vendorFailureOf(firstEnd.error?.message ?? "", "deepseek")).toEqual({
      kind: "auth",
      serviceName: "DeepSeek",
    });

    await h.driver.send(row.id, { messageIds: [32 as never], source: "user", text: "无余额调用" });
    const secondEnd = await h.waitFor("turn.ended", () => true, 2);
    expect(secondEnd.ok).toBe(false);
    expect(vendorFailureOf(secondEnd.error?.message ?? "", "deepseek")).toEqual({
      kind: "quota",
      serviceName: "DeepSeek",
    });
  });

  it("可执行文件缺失报 deepseek_not_found；异常崩溃补杀同进程组残留子进程；matchesDeepSeekStaleProcess 精准匹配", async () => {
    const hMissing = track(makeDeepSeekHarness({ executablePath: "/nonexistent/dsh-binary" }));
    const missingRow = hMissing.addSession();
    await expect(
      hMissing.driver.send(missingRow.id, { messageIds: [41 as never], source: "user", text: "hi" }),
    ).rejects.toMatchObject({
      name: DriverError.name,
      code: "deepseek_not_found",
      retryable: true,
    });

    const hCrash = track(makeDeepSeekHarness());
    const childPidFile = join(hCrash.logDir, "dsh-orphan.pid");
    hCrash.updateScript({
      turns: [
        {
          textChunks: ["崩溃前输出"],
          spawnChildPidFile: childPidFile,
          crashExitCode: 9,
        },
      ],
    });
    const crashRow = hCrash.addSession();
    await hCrash.driver.send(crashRow.id, { messageIds: [42 as never], source: "user", text: "触发崩溃" });
    const exited = await hCrash.waitFor("session.exited");
    expect(exited.reason).toBe("crash");

    expect(existsSync(childPidFile)).toBe(true);
    const orphanPid = Number(readFileSync(childPidFile, "utf8").trim());
    expect(orphanPid).toBeGreaterThan(1);
    expect(await waitForExit(orphanPid, 2_000)).toBe(true);
    expect(isAlive(orphanPid)).toBe(false);

    // 孤儿进程命令行识别：仅匹配 `--profile acp` 且同会话（或无 launch/<id> 冲突）的 dsh 进程
    expect(
      matchesDeepSeekStaleProcess(
        `/usr/local/bin/dsh --profile acp --patch /tmp/x/launch/${crashRow.id}/settings.json`,
        crashRow,
        "/usr/local/bin/dsh",
      ),
    ).toBe(true);
    expect(
      matchesDeepSeekStaleProcess(
        `/usr/local/bin/dsh --profile acp --patch /tmp/x/launch/999999/settings.json`,
        crashRow,
        "/usr/local/bin/dsh",
      ),
    ).toBe(false);
    expect(matchesDeepSeekStaleProcess("/usr/local/bin/dsh", crashRow, "/usr/local/bin/dsh")).toBe(false);
  });
});
