import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, waitForExit } from "../../../daemon/driver/process.ts";
import { MemorySessionStore, realSleep } from "../../../daemon/driver/test-helpers.ts";
import {
  SANDBOX_EXEC,
  osSandboxAvailable,
  type ReadonlySandboxInput,
} from "../../../daemon/driver/write-scope.ts";
import {
  AGENT_VENDORS,
  CRASH_RECOVERY_NOTE,
  DriverError,
  EMPTY_TOKEN_USAGE,
  MAX_COMMANDS,
  MAX_MESSAGE_BYTES,
  SESSION_STEPS_KEEP,
  agentLaunchArgs,
  buildReadonlyPolicy,
  notFoundCode,
  vendorSpec,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type ReadonlyPolicy,
  type SessionId,
} from "../../../shared/index.ts";
import { defineVendor } from "../../types.ts";
import {
  createAcpDriver,
  decideAcpPermission,
  parseAcpAvailableCommands,
  resolveEffortConfigUpdate,
  resolveModelConfigUpdate,
  type AcpDriverConfig,
  type AcpDriverOptions,
  type AcpSessionDriver,
} from "./index.ts";
import type { FakeAcpLogEntry, FakeAcpScript } from "./fixtures/fake-acp-agent.ts";

const FAKE_ACP_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.ts", import.meta.url));
const TEST_VENDOR = AGENT_VENDORS[0]!;

interface AcpTestHarness {
  dir: string;
  cwd: string;
  logDir: string;
  stateDir: string;
  promptFile: string;
  store: MemorySessionStore;
  driver: AcpSessionDriver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
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
  setFingerprint(fp: string): void;
  cleanup(): Promise<void>;
}

async function waitForLog(h: AcpTestHarness, event: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!h.logs().some((e) => e.event === event)) {
    if (Date.now() >= deadline) throw new Error(`Missing fake ACP event: ${event}`);
    await realSleep(10);
  }
}

let nextSessionId = 100;

function makeAcpHarness(options: {
  script?: FakeAcpScript;
  config?: Partial<AcpDriverConfig>;
  driverOptions?: Partial<AcpDriverOptions>;
  systemPrompt?: string;
} = {}): AcpTestHarness {
  const rawDir = mkdtempSync(join(tmpdir(), "agent-hub-acp-test-"));
  const dir = realpathSync(rawDir);
  const cwd = join(dir, "workspace");
  const logDir = join(dir, "logs");
  const stateDir = join(dir, "state");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const scriptFile = join(logDir, "script.json");
  const logFile = join(logDir, "fake-acp.jsonl");
  const promptFile = join(dir, "system-prompt.md");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}), "utf8");
  writeFileSync(promptFile, options.systemPrompt ?? "Follow hub rules strictly.", "utf8");

  const store = new MemorySessionStore();
  let readonlyPolicy: ReadonlyPolicy | null = null;
  let fingerprint = "fp-v1";

  const config: AcpDriverConfig = {
    vendor: TEST_VENDOR,
    launchArgs: ["--acp-test-mode"],
    readonlySandbox: {
      // 允许假 ACP 程序在只读 OS 沙箱测试中把事件日志写进独立的 logs 目录，workspace 保持严格只读
      writableDirs: () => [logDir],
    },
    ...options.config,
    // TEST_VENDOR（名单第一家）走常驻通道，底座默认不拼；底座的拼接逻辑按“拼进首条消息”测，这里显式写（测按声明推的用例传 undefined）
    session: { systemPromptInjection: "first_turn_new_session", ...options.config?.session },
  };

  const driver = createAcpDriver(config, {
    executablePath: wrapScriptAsPlatformCli(FAKE_ACP_AGENT, dir, "fake-acp-agent"),
    store,
    idleCloseMs: 60_000,
    interruptGraceMs: 2_000,
    startTimeoutMs: 10_000,
    shutdownGraceMs: 3_000,
    log: () => {},
    prepareLaunch: async (): Promise<LaunchFiles> => ({
      promptFile,
      fingerprint,
      env: {
        FAKE_ACP_SCRIPT: scriptFile,
        FAKE_ACP_LOG: logFile,
        FAKE_ACP_STATE: stateDir,
      },
      ...(readonlyPolicy ? { readonly: readonlyPolicy } : {}),
    }),
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
        throw new Error(`Timed out waiting for ${type} (count=${count}), got events: ${events.map((x) => x.event.type).join(",")}`);
      }
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        realSleep(50),
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
      generation: 1,
      vendor: TEST_VENDOR,
      vendorSessionId: "",
      model: null,
      effort: null,
      cwd,
      addDirs: [],
      status: "idle",
      pid: null,
      hasCompletedTurn: false,
      personaRevision: null,
      usage: { ...EMPTY_TOKEN_USAGE },
      rateLimit: null,
      createdAt: now,
      updatedAt: now,
      lastEventAt: null,
      ...patch,
    };
    store.add(row);
    return row;
  };

  return {
    dir,
    cwd,
    logDir,
    stateDir,
    promptFile,
    store,
    driver,
    events,
    of,
    waitFor,
    logs,
    updateScript: (next) => writeFileSync(scriptFile, JSON.stringify(next), "utf8"),
    addSession,
    setReadonly: (p) => {
      readonlyPolicy = p;
    },
    setFingerprint: (fp) => {
      fingerprint = fp;
    },
    cleanup: async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let activeHarnesses: AcpTestHarness[] = [];
function track(h: AcpTestHarness): AcpTestHarness {
  activeHarnesses.push(h);
  return h;
}

afterEach(async () => {
  const list = activeHarnesses;
  activeHarnesses = [];
  for (const h of list) {
    await h.cleanup();
  }
});

describe("VendorSpec models.flags 可选适配", () => {
  it("允许 ACP 厂商省略 models.flags，且未配置 flags 时 agentLaunchArgs 返回空数组", () => {
    const acpLikeSpec = defineVendor({
      id: "acpdemo",
      label: "ACP Demo",
      cli: {
        command: "acp-demo-bin",
        envVar: "AGENT_HUB_ACPDEMO",
        loginCommand: "acp-demo-bin login",
      },
      home: {
        dirs: [".acp-demo"],
        readonlySecrets: [".acp-demo/auth.json"],
        catalogWatchPaths: [".acp-demo/config.json"],
      },
      models: {
        bundled: [{ id: "m-1", label: "Model 1", efforts: ["low", "high"] }],
        customModel: true,
        customModelExample: "m-custom",
        efforts: ["low", "high"],
        routerDefault: { model: "m-1", effort: "low" },
      },
      composer: {
        commandPrefix: "/",
        compactCommand: "compact",
        blockedCommands: {},
      },
      prompt: {
        subagentTools: [],
        backgroundCommandTool: "background",
      },
      failure: {
        serviceName: "ACP Demo",
      },
      capabilities: {
        backgroundWake: false,
        readonly: "os_sandbox",
        systemPrompt: "first_message",
        skills: "read_file",
      },
    });
    expect(acpLikeSpec.models.flags).toBeUndefined();
    // 对未知/无 flags 厂商调用 agentLaunchArgs 不抛错且返回 []
    expect(
      agentLaunchArgs({
        vendor: "acpdemo" as unknown as typeof TEST_VENDOR,
        model: "m-1",
        effort: "high",
      }),
    ).toEqual([]);
  });
});

describe("ACP 驱动底座：产品提示词的通道（spec 的 capabilities.systemPrompt）与压缩后重新拼", () => {
  const promptsOf = (h: AcpTestHarness) => h.logs().filter((e) => e.event === "session/prompt").map((e) => e.blocks);
  const compacted = { sessionUpdate: "compaction_update", payload: { compactionId: "c1", status: "completed" } };

  it("没写 systemPromptInjection 时按厂商声明：resident 的不拼进消息，first_message 的拼进新会话第一条", async () => {
    const resident = track(
      makeAcpHarness({ systemPrompt: "常驻的提示词", config: { session: { systemPromptInjection: undefined } } }),
    );
    expect(vendorSpec(TEST_VENDOR).capabilities.systemPrompt).toBe("resident");
    const r = resident.addSession();
    await resident.driver.send(r.id, { messageIds: [1 as never], source: "user", text: "你好" });
    await resident.waitFor("turn.ended");
    expect(promptsOf(resident)).toEqual([["你好"]]);

    const firstMessageVendor = AGENT_VENDORS.find((v) => vendorSpec(v).capabilities.systemPrompt === "first_message")!;
    const fm = track(
      makeAcpHarness({
        systemPrompt: "拼进首条的提示词",
        config: { vendor: firstMessageVendor, session: { systemPromptInjection: undefined } },
      }),
    );
    const f = fm.addSession({ vendor: firstMessageVendor });
    await fm.driver.send(f.id, { messageIds: [2 as never], source: "user", text: "你好" });
    await fm.waitFor("turn.ended");
    expect(promptsOf(fm)).toEqual([["<system_instructions>\n拼进首条的提示词\n</system_instructions>", "你好"]]);

    // 拼进消息的才在 initialize 声明 session.compaction（ACP 规定声明了 agent 才发 compaction_update），常驻的不声明
    const capsOf = (h: AcpTestHarness) =>
      (h.logs().find((e) => e.event === "initialize")?.params as { clientCapabilities?: { session?: unknown } }).clientCapabilities;
    expect(capsOf(fm)?.session).toEqual({ compaction: {} });
    expect(capsOf(resident)?.session).toBeUndefined();
  });

  it("收到 compaction_update completed：发 context.compacted，下一条消息最前面重新拼一次（读 prompt.md 现在的内容），再下一条不拼", async () => {
    const h = track(
      makeAcpHarness({
        systemPrompt: "第一版提示词",
        script: {
          turns: [
            { textChunks: ["一"] },
            { customUpdates: [compacted], textChunks: ["二"] },
            { textChunks: ["三"] },
            { textChunks: ["四"] },
          ],
        },
      }),
    );
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [1 as never], source: "user", text: "第一句" });
    await h.waitFor("turn.ended", () => true, 1);
    await h.driver.send(row.id, { messageIds: [2 as never], source: "user", text: "第二句" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.of("context.compacted")).toHaveLength(1);
    writeFileSync(h.promptFile, "第二版提示词", "utf8");
    await h.driver.send(row.id, { messageIds: [3 as never], source: "user", text: "第三句" });
    await h.waitFor("turn.ended", () => true, 3);
    await h.driver.send(row.id, { messageIds: [4 as never], source: "user", text: "第四句" });
    await h.waitFor("turn.ended", () => true, 4);
    expect(promptsOf(h)).toEqual([
      ["<system_instructions>\n第一版提示词\n</system_instructions>", "第一句"],
      ["第二句"],
      ["<system_instructions>\n第二版提示词\n</system_instructions>", "第三句"],
      ["第四句"],
    ]);
  });

  it("压缩完进程闲置关了：下一条起新进程恢复会话（恢复不拼首轮提示词），照样在最前面补上", async () => {
    const h = track(
      makeAcpHarness({
        systemPrompt: "提示词",
        driverOptions: { idleCloseMs: 120 },
        script: { closeCapability: true, turns: [{ customUpdates: [compacted], textChunks: ["一"] }, { textChunks: ["二"] }] },
      }),
    );
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [1 as never], source: "user", text: "第一句" });
    await h.waitFor("turn.ended", () => true, 1);
    await h.waitFor("session.exited");
    await h.driver.send(row.id, { messageIds: [2 as never], source: "user", text: "第二句" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.logs().some((e) => e.event === "session/load")).toBe(true);
    expect(promptsOf(h)).toEqual([
      ["<system_instructions>\n提示词\n</system_instructions>", "第一句"],
      ["<system_instructions>\n提示词\n</system_instructions>", "第二句"],
    ]);
  });

  it("同一轮里压缩两次只重新拼一次；走常驻通道的（never）压缩后也不拼", async () => {
    const h = track(
      makeAcpHarness({
        systemPrompt: "提示词",
        script: { turns: [{ textChunks: ["一"] }, { customUpdates: [compacted, compacted], textChunks: ["二"] }, { textChunks: ["三"] }] },
      }),
    );
    const row = h.addSession();
    for (const [i, text] of ["第一句", "第二句", "第三句"].entries()) {
      await h.driver.send(row.id, { messageIds: [(i + 1) as never], source: "user", text });
      await h.waitFor("turn.ended", () => true, i + 1);
    }
    expect(promptsOf(h)[2]).toEqual(["<system_instructions>\n提示词\n</system_instructions>", "第三句"]);

    const never = track(
      makeAcpHarness({
        systemPrompt: "常驻",
        config: { session: { systemPromptInjection: "never" } },
        script: { turns: [{ customUpdates: [compacted], textChunks: ["一"] }, { textChunks: ["二"] }] },
      }),
    );
    const n = never.addSession();
    await never.driver.send(n.id, { messageIds: [1 as never], source: "user", text: "第一句" });
    await never.waitFor("turn.ended", () => true, 1);
    await never.driver.send(n.id, { messageIds: [2 as never], source: "user", text: "第二句" });
    await never.waitFor("turn.ended", () => true, 2);
    expect(never.of("context.compacted")).toHaveLength(1);
    expect(promptsOf(never)).toEqual([["第一句"], ["第二句"]]);
  });
});

describe("ACP 驱动底座端到端协议与生命周期", () => {
  it("simple：支持可选 authenticate、模型与思考档位两段式 configOptions、首轮系统提示词注入、思考/工具/流式文本聚合与用量统计", async () => {
    const h = track(
      makeAcpHarness({
        systemPrompt: "你是测试 Worker。",
        config: {
          authenticate: { enabled: true, preferredMethodId: "test_login" },
          session: { defaultModeId: "auto" },
        },
        script: {
          requireAuth: true,
          turns: [
            {
              thoughtChunks: ["先分析问题...", "继续推导..."],
              toolCalls: [
                {
                  toolCallId: "tc-read-1",
                  title: "Read File",
                  name: "read_file",
                  kind: "read",
                  locations: [{ path: "/repo/src/demo.ts" }],
                },
              ],
              textChunks: ["你好，", "世界！"],
              usageUpdate: { used: 4096, size: 128000 },
              usage: {
                totalTokens: 350,
                inputTokens: 200,
                outputTokens: 90,
                thoughtTokens: 30,
                cachedReadTokens: 20,
                cachedWriteTokens: 10,
              },
            },
          ],
        },
      }),
    );

    const row = h.addSession({ model: "reasoner-pro", effort: "high" });
    const res = await h.driver.send(row.id, {
      messageIds: [1 as never],
      source: "user",
      text: "请帮我检查文件",
    });
    expect(res).toEqual({ kind: "written" });

    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(ended.interrupted).toBe(false);
    expect(ended.messageIds).toEqual([1]);

    const started = h.of("session.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(false);
    expect(started[0]!.model).toBe("reasoner-pro");

    // 连续两个 thought chunk 合并为一次 agent.thinking
    expect(h.of("agent.thinking")).toHaveLength(1);

    // 工具事件与 locations[0].path 注入
    const tools = h.of("agent.tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!).toMatchObject({
      toolUseId: "tc-read-1",
      name: "read_file",
      input: { path: "/repo/src/demo.ts" },
    });
    expect(h.of("agent.tool_result")).toHaveLength(1);
    expect(h.of("agent.tool_result")[0]!.toolUseIds).toEqual(["tc-read-1"]);

    // 增量文本实时发出 agent.text_delta，合并后仍为单条 agent.text
    expect(h.of("agent.text_delta").map((e) => e.delta)).toEqual(["你好，", "世界！"]);
    const texts = h.of("agent.text");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe("你好，世界！");

    // 核对握手顺序与首轮 <system_instructions> 注入
    const logEvents = h.logs();
    expect(logEvents.some((e) => e.event === "authenticate" && e.methodId === "test_login")).toBe(true);
    expect(logEvents.some((e) => e.event === "session/set_mode" && e.modeId === "auto")).toBe(true);
    const cfgCalls = logEvents
      .filter((e) => e.event === "session/set_config_option")
      .map((e) => ({ configId: e.configId, value: e.value }));
    expect(cfgCalls).toEqual([
      { configId: "model", value: "reasoner-pro" },
      { configId: "reasoning_effort", value: "high" },
    ]);

    const promptLog = logEvents.find((e) => e.event === "session/prompt");
    expect(promptLog?.blocks).toEqual([
      "<system_instructions>\n你是测试 Worker。\n</system_instructions>",
      "请帮我检查文件",
    ]);

    // 核对 SessionStore 的 vendorSessionId、hasCompletedTurn 与 usage
    const updated = h.store.get(row.id)!;
    expect(updated.vendorSessionId).toMatch(/^fake-sess-/);
    expect(updated.hasCompletedTurn).toBe(true);
    expect(updated.usage).toEqual({
      input: 200,
      cacheRead: 20,
      cacheWrite: 10,
      output: 120,
      context: 4096,
    });
  });

  it("multi_turn：多轮对话复用同一常驻进程且次轮不重复注入系统提示词，空闲到期正常关闭", async () => {
    const h = track(
      makeAcpHarness({
        driverOptions: { idleCloseMs: 120 },
        script: {
          closeCapability: true,
          turns: [
            { textChunks: ["第一轮回复"] },
            { textChunks: ["第二轮回复"] },
          ],
        },
      }),
    );

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [10 as never], source: "user", text: "第一句" });
    await h.waitFor("turn.ended", () => true, 1);
    const firstPid = h.logs().find((e) => e.event === "initialize")?.pid;

    await h.driver.send(row.id, { messageIds: [11 as never], source: "user", text: "第二句" });
    await h.waitFor("turn.ended", () => true, 2);

    const prompts = h.logs().filter((e) => e.event === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.pid).toBe(firstPid);
    expect(prompts[1]!.pid).toBe(firstPid);
    // 第二轮不再重复注入 <system_instructions>
    expect(prompts[1]!.blocks).toEqual(["第二句"]);

    const texts = h.of("agent.text");
    expect(texts.map((t) => t.text)).toEqual(["第一轮回复", "第二轮回复"]);
    expect(texts[0]!.uuid).not.toBe(texts[1]!.uuid);

    // 等待空闲关闭触发 session/close + session.exited(idle)
    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("idle");
    expect(h.logs().some((e) => e.event === "session/close")).toBe(true);
  });

  it("additionalDirectories 只在 agent 声明 sessionCapabilities.additionalDirectories 时随 session/new 带上", async () => {
    for (const capable of [true, false]) {
      const h = track(makeAcpHarness({ script: { additionalDirectoriesCapability: capable, turns: [{ textChunks: ["ok"] }] } }));
      const extra = join(h.dir, "extra");
      mkdirSync(extra);
      const row = h.addSession({ addDirs: [extra] });
      await h.driver.send(row.id, { messageIds: [12 as never], source: "user", text: "hi" });
      await h.waitFor("turn.ended");
      const params = h.logs().find((e) => e.event === "session/new")?.params as Record<string, unknown>;
      expect(params.additionalDirectories).toEqual(capable ? [extra] : undefined);
    }
  });

  it("queued_turn：一轮忙时收到的多条用户消息进入待发队列（去重幂等），本轮结束后自动合并发送", async () => {
    const h = track(
      makeAcpHarness({
        script: {
          turns: [
            { sleepMs: 180, textChunks: ["忙完第一轮"] },
            { textChunks: ["处理完合并队列"] },
          ],
        },
      }),
    );

    const row = h.addSession();
    const r1 = await h.driver.send(row.id, { messageIds: [21 as never], source: "user", text: "先做任务 A" });
    expect(r1).toEqual({ kind: "written" });

    const r2 = await h.driver.send(row.id, { messageIds: [22 as never], source: "user", text: "补充条件 1" });
    const r2Dup = await h.driver.send(row.id, { messageIds: [22 as never], source: "user", text: "补充条件 1" });
    const r3 = await h.driver.send(row.id, { messageIds: [23 as never], source: "user", text: "补充条件 2" });
    expect(r2).toEqual({ kind: "queued" });
    expect(r2Dup).toEqual({ kind: "queued" });
    expect(r3).toEqual({ kind: "queued" });

    const secondEnded = await h.waitFor("turn.ended", () => true, 2);
    expect(secondEnded.ok).toBe(true);
    expect(secondEnded.messageIds).toEqual([22, 23]);

    const prompts = h.logs().filter((e) => e.event === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.blocks).toEqual(["【用户连发了 2 条】", "1. 补充条件 1", "2. 补充条件 2"]);
  });

  it("turn_interrupt：正规发送 session/cancel 打断当前轮、取消排队用户消息并保留常驻进程继续下一轮；不响应时升级强杀", async () => {
    const h = track(
      makeAcpHarness({
        script: {
          turns: [
            { waitForCancel: true, textChunks: ["被打断前的一半"] },
            { textChunks: ["打断后同进程恢复正常"] },
            { waitForCancel: true, ignoreCancel: true },
          ],
        },
        driverOptions: { interruptGraceMs: 120 },
      }),
    );

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [31 as never], source: "user", text: "长耗时任务" });
    await h.waitFor("message.processing");

    // 排一条用户消息与一条系统消息：停止时用户消息标 cancelled，系统消息保留
    await h.driver.send(row.id, { messageIds: [32 as never], source: "user", text: "排队的普通用户消息" });
    await h.driver.send(row.id, { messageIds: [33 as never], source: "system", text: "【系统】保留的系统通知" });

    await h.driver.interrupt(row.id);

    const cancelledMsg = h.of("message.cancelled");
    expect(cancelledMsg).toHaveLength(1);
    expect(cancelledMsg[0]!.messageIds).toEqual([32]);

    const firstTurnEnded = await h.waitFor("turn.ended", () => true, 1);
    expect(firstTurnEnded.interrupted).toBe(true);
    expect(firstTurnEnded.ok).toBe(false);
    expect(h.logs().some((e) => e.event === "session/cancel")).toBe(true);
    // 进程未退出，自动把保留的系统消息（33）在同进程发送完第二轮
    const secondTurnEnded = await h.waitFor("turn.ended", () => true, 2);
    expect(secondTurnEnded.ok).toBe(true);
    expect(secondTurnEnded.messageIds).toEqual([33]);
    expect(h.of("session.exited")).toHaveLength(0);

    // 第三轮模拟 ignoreCancel：超时升级 SIGINT/SIGKILL 退出
    await h.driver.send(row.id, { messageIds: [34 as never], source: "user", text: "卡死不响应 cancel 的任务" });
    await h.waitFor("message.delivered", (e) => e.messageIds.includes(34 as never));
    await h.driver.interrupt(row.id);

    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("interrupt");
  });

  it.each(["initialize", "authenticate", "new"] as const)("%s 挂起时停止会收尾所有 Promise，且不谎报送达", async (phase) => {
    const h = track(makeAcpHarness({
      config: { authenticate: { enabled: true } },
      script: {
        hangOnInitialize: phase === "initialize",
        hangOnAuthenticate: phase === "authenticate",
        hangOnNew: phase === "new",
      },
      driverOptions: { interruptGraceMs: 40 },
    }));
    const row = h.addSession();
    const sending = h.driver.send(row.id, { messageIds: [301 as never], source: "user", text: "pending" });
    await waitForLog(h, phase === "new" ? "new_pending" : phase);
    await h.driver.interrupt(row.id);
    await sending;
    expect(h.of("message.delivered")).toEqual([]);
    expect(h.logs().filter((e) => e.event === "session/prompt")).toEqual([]);
  });

  it("空闲预热在 initialize 挂起时也能停止；end 在启动超时后可结束", async () => {
    const h = track(makeAcpHarness({ script: { hangOnInitialize: true }, driverOptions: { interruptGraceMs: 40 } }));
    const row = h.addSession();
    const starting = h.driver.start(row.id).catch((error: unknown) => error);
    await waitForLog(h, "initialize");
    await h.driver.interrupt(row.id);
    expect(await starting).toBeInstanceOf(DriverError);
    expect(h.of("message.delivered")).toHaveLength(0);

    const ending = track(makeAcpHarness({ script: { hangOnInitialize: true }, driverOptions: { startTimeoutMs: 1000 } }));
    const pending = ending.addSession();
    const sending = ending.driver.send(pending.id, { messageIds: [311 as never], source: "user", text: "init" }).catch((error: unknown) => error);
    await waitForLog(ending, "initialize");
    await ending.driver.end(pending.id);
    expect(await sending).toBeInstanceOf(DriverError);
    expect(ending.store.get(pending.id)!.status).toBe("ended");
  });

  it("取消响应晚于 SIGINT 时仍强杀忽略信号的进程，送达早于轮末", async () => {
    const h = track(makeAcpHarness({
      script: { ignoreSigint: true, cancelDelayMs: 150, turns: [{ waitForCancel: true }] },
      driverOptions: { interruptGraceMs: 100 },
    }));
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [302 as never], source: "user", text: "pending" });
    expect(h.of("message.delivered")).toHaveLength(1);
    expect(h.of("turn.ended")).toHaveLength(0);
    await h.driver.interrupt(row.id);
    await h.waitFor("turn.ended");
    const exited = await h.waitFor("session.exited");
    expect(exited.signal).toBe("SIGKILL");
  });

  it("恢复 RPC 不支持时先 load；同一会话跨进程的消息 UUID 不重复", async () => {
    const h = track(makeAcpHarness({
      script: { resumeCapability: true, resumeUnsupported: true, knownSessions: ["saved"] },
    }));
    const row = h.addSession({ vendorSessionId: "saved", hasCompletedTurn: true });
    await h.driver.send(row.id, { messageIds: [303 as never], source: "user", text: "one" });
    await h.waitFor("turn.ended");
    h.setFingerprint("changed");
    await h.driver.send(row.id, { messageIds: [304 as never], source: "user", text: "two" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.of("session.started").every((e) => e.resumed)).toBe(true);
    const ids = h.of("agent.text").map((e) => e.uuid);
    expect(new Set(ids).size).toBe(2);
    expect(h.logs().filter((e) => e.event === "session/load")).toHaveLength(2);
  });

  it("守护进程重启后恢复同一会话也不会重复 UUID", async () => {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const h = track(makeAcpHarness({ script: { knownSessions: ["persisted"] } }));
      const row = h.addSession({ vendorSessionId: "persisted", hasCompletedTurn: true });
      await h.driver.send(row.id, { messageIds: [310 as never], source: "user", text: "reply" });
      await h.waitFor("turn.ended");
      ids.push(h.of("agent.text")[0]!.uuid);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it("无换行协议输出超限会强关；忙时待发队列有总字节上限", async () => {
    const h = track(makeAcpHarness({ script: { turns: [{ unterminatedOutputBytes: MAX_MESSAGE_BYTES * 9 }] } }));
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [305 as never], source: "user", text: "overflow" });
    await h.waitFor("session.exited");
    expect(h.of("driver.error").some((e) => e.message.includes("frame exceeds"))).toBe(true);

    const q = track(makeAcpHarness({ script: { turns: [{ waitForCancel: true }] } }));
    const queuedRow = q.addSession();
    await q.driver.send(queuedRow.id, { messageIds: [306 as never], source: "user", text: "busy" });
    expect(await q.driver.send(queuedRow.id, { messageIds: [307 as never], source: "user", text: "x".repeat(MAX_MESSAGE_BYTES / 2 + 1) })).toEqual({ kind: "queued" });
    expect(await q.driver.send(queuedRow.id, { messageIds: [308 as never], source: "user", text: "y".repeat(MAX_MESSAGE_BYTES / 2 + 1) })).toEqual({ kind: "rejected" });
    await q.driver.interrupt(queuedRow.id);
  });

  it("resume（session/load 吞历史重放 vs 不吞重放、session/resume 直接续接、会话不存在回退 session/new）", async () => {
    // 1. session/load 默认吞掉重放的历史消息，但保留 available_commands_update
    const hLoad = track(
      makeAcpHarness({
        config: { continuation: { mode: "load", swallowReplayOnLoad: true } },
        script: {
          knownSessions: ["saved-load-1"],
          replayOnLoad: {
            userTexts: ["旧用户消息"],
            thoughtTexts: ["旧思考内容"],
            toolTitle: "old_tool",
            agentTexts: ["旧历史助手回复（不应重复发出）"],
            commands: [
              { name: "compact", description: "压缩上下文" },
              { name: "review", description: "代码审查", hint: "<file>" },
            ],
          },
          turns: [{ textChunks: ["恢复后的新回复"] }],
        },
      }),
    );

    const rowLoad = hLoad.addSession({
      vendorSessionId: "saved-load-1",
      hasCompletedTurn: true,
    });
    await hLoad.driver.send(rowLoad.id, { messageIds: [41 as never], source: "user", text: "继续工作" });
    await hLoad.waitFor("turn.ended");

    expect(hLoad.of("session.started")[0]!.resumed).toBe(true);
    expect(hLoad.logs().some((e) => e.event === "session/load" && e.sessionId === "saved-load-1")).toBe(true);
    // 历史重放被完整吞掉（包括流式增量），只有本轮的新回复！
    expect(hLoad.of("agent.text_delta").map((e) => e.delta)).toEqual(["恢复后的新回复"]);
    expect(hLoad.of("agent.text").map((e) => e.text)).toEqual(["恢复后的新回复"]);
    expect(hLoad.of("agent.tool")).toHaveLength(0);
    expect(hLoad.of("agent.thinking")).toHaveLength(0);
    // available_commands_update 正常透出并写入缓存供 queryCommands 读取
    expect(hLoad.of("commands.changed")).toHaveLength(1);
    const cmds = await hLoad.driver.queryCommands(rowLoad.id);
    expect(cmds).toEqual([
      { name: "compact", description: "压缩上下文", builtin: true },
      { name: "review", description: "代码审查", argumentHint: "<file>", builtin: true },
    ]);

    // 2. session/load 显式配置 swallowReplayOnLoad: false 时不吞历史
    const hNoSwallow = track(
      makeAcpHarness({
        config: { continuation: { mode: "load", swallowReplayOnLoad: false } },
        script: {
          knownSessions: ["saved-load-2"],
          replayOnLoad: {
            agentTexts: ["显式保留的历史回复"],
          },
          turns: [{ textChunks: ["新一轮回复"] }],
        },
      }),
    );
    const rowNoSwallow = hNoSwallow.addSession({
      vendorSessionId: "saved-load-2",
      hasCompletedTurn: true,
    });
    await hNoSwallow.driver.send(rowNoSwallow.id, { messageIds: [42 as never], source: "user", text: "继续" });
    await hNoSwallow.waitFor("turn.ended");
    expect(hNoSwallow.of("agent.text").map((e) => e.text)).toEqual(["显式保留的历史回复", "新一轮回复"]);

    // 3. 服务端支持 sessionCapabilities.resume 时走 session/resume（无历史重放）
    const hResume = track(
      makeAcpHarness({
        config: { continuation: { mode: "auto" } },
        script: {
          resumeCapability: true,
          knownSessions: ["saved-resume-1"],
          turns: [{ textChunks: ["通过 session/resume 恢复成功"] }],
        },
      }),
    );
    const rowResume = hResume.addSession({
      vendorSessionId: "saved-resume-1",
      hasCompletedTurn: true,
    });
    await hResume.driver.send(rowResume.id, { messageIds: [43 as never], source: "user", text: "用 resume 续接" });
    await hResume.waitFor("turn.ended");
    expect(hResume.logs().some((e) => e.event === "session/resume" && e.sessionId === "saved-resume-1")).toBe(true);
    expect(hResume.logs().some((e) => e.event === "session/load")).toBe(false);
    expect(hResume.of("session.started")[0]!.resumed).toBe(true);
    expect(hResume.of("agent.text").map((e) => e.text)).toEqual(["通过 session/resume 恢复成功"]);

    // 4. 目标会话不存在（-32002）时自动回退到 session/new 并补发系统提示词
    const hFallback = track(
      makeAcpHarness({
        systemPrompt: "回退新建时的系统指令",
        script: {
          loadNotFound: true,
          turns: [{ textChunks: ["回退新建会话成功"] }],
        },
      }),
    );
    const rowMissing = hFallback.addSession({
      vendorSessionId: "missing-session-999",
      hasCompletedTurn: true,
    });
    await hFallback.driver.send(rowMissing.id, { messageIds: [44 as never], source: "user", text: "继续旧会话" });
    await hFallback.waitFor("turn.ended");
    expect(hFallback.of("session.started")[0]!.resumed).toBe(false);
    expect(hFallback.store.get(rowMissing.id)!.vendorSessionId).toMatch(/^fake-sess-/);
    const fallbackPrompt = hFallback.logs().find((e) => e.event === "session/prompt");
    expect(fallbackPrompt?.blocks).toEqual([
      "<system_instructions>\n回退新建时的系统指令\n</system_instructions>",
      "继续旧会话",
    ]);
  });

  it("只读 Worker：request_permission 放行只读/沙箱受限命令与 readOnlyHint MCP、拒绝写类工具与未标只读 MCP，且校验外层只读 OS 沙箱参数与不可用拒启", async () => {
    const canNestOsSandbox =
      process.platform === "darwin"
        ? (() => {
            try {
              execFileSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], {
                stdio: "ignore",
              });
              return true;
            } catch {
              return false;
            }
          })()
        : osSandboxAvailable();

    // 1. 当 OS 沙箱不可用（osSandboxed: false）时拒绝启动只读 Worker
    const hNoSandbox = track(
      makeAcpHarness({
        driverOptions: {
          readonlySpawn: (base) => ({ ...base, osSandboxed: false }),
        },
      }),
    );
    const roPolicy = buildReadonlyPolicy({
      homeDir: realpathSync(homedir()),
      stateDir: hNoSandbox.stateDir,
    });
    hNoSandbox.setReadonly(roPolicy);
    const sDenied = hNoSandbox.addSession({ role: "worker" });
    await expect(
      hNoSandbox.driver.send(sDenied.id, { messageIds: [50 as never], source: "user", text: "测试无沙箱拒启" }),
    ).rejects.toThrow(/需要 OS 沙箱/);

    // 2. 端到端验证只读 Worker 的 request_permission 策略、私有 TMPDIR 与退出清理（若当前进程未嵌套 seatbelt 则直接跑真沙箱）
    let capturedSandboxInput: ReadonlySandboxInput | null = null;
    const h = track(
      makeAcpHarness({
        driverOptions: {
          ...(canNestOsSandbox
            ? {}
            : {
                readonlySpawn: (base, input) => {
                  capturedSandboxInput = input;
                  return { ...base, osSandboxed: true };
                },
              }),
        },
      }),
    );

    const probeTarget = join(h.cwd, "forbidden-write.txt");
    h.updateScript({
      turns: [
        {
          toolCalls: [
            {
              toolCallId: "ro-read",
              title: "Read README",
              name: "read_file",
              kind: "read",
              requestPermission: { kind: "read", name: "read_file" },
            },
            {
              toolCallId: "ro-edit",
              title: "Edit File",
              name: "edit_file",
              kind: "edit",
              requestPermission: { kind: "edit", name: "edit_file" },
            },
            {
              toolCallId: "ro-mcp-readonly",
              title: "mcp__docs__search",
              name: "mcp__docs__search",
              kind: "other",
              requestPermission: {
                name: "mcp__docs__search",
                meta: { annotations: { readOnlyHint: true } },
              },
            },
            {
              toolCallId: "ro-mcp-unmarked",
              title: "mcp__docs__create_page",
              name: "mcp__docs__create_page",
              kind: "other",
              requestPermission: {
                name: "mcp__docs__create_page",
              },
            },
            {
              toolCallId: "ro-mcp-destructive",
              title: "mcp__docs__drop_table",
              name: "mcp__docs__drop_table",
              kind: "other",
              requestPermission: {
                name: "mcp__docs__drop_table",
                meta: { annotations: { readOnlyHint: true, destructiveHint: true } },
              },
            },
            {
              toolCallId: "ro-mcp-exec-unmarked",
              title: "mcp__runner__exec",
              name: "mcp__runner__exec",
              kind: "execute",
              requestPermission: {
                kind: "execute",
                name: "mcp__runner__exec",
              },
            },
            {
              toolCallId: "ro-exec-probe",
              title: "Run shell probe",
              name: "bash",
              kind: "execute",
              requestPermission: { kind: "execute", name: "bash" },
              ...(canNestOsSandbox ? { probeWritePath: probeTarget } : {}),
            },
          ],
          textChunks: ["只读检查完毕"],
        },
      ],
    });

    const policy = buildReadonlyPolicy({
      homeDir: realpathSync(homedir()),
      stateDir: h.stateDir,
    });
    h.setReadonly(policy);

    const row = h.addSession({ role: "worker" });
    await h.driver.send(row.id, { messageIds: [51 as never], source: "user", text: "执行只读排查" });
    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);

    const outcomes = Object.fromEntries(
      h
        .logs()
        .filter((e) => e.event === "permission_outcome")
        .map((e) => [e.toolCallId, e.outcome]),
    );
    expect(outcomes["ro-read"]).toEqual({ outcome: "selected", optionId: "allow-always" });
    expect(outcomes["ro-edit"]).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(outcomes["ro-mcp-readonly"]).toEqual({ outcome: "selected", optionId: "allow-always" });
    expect(outcomes["ro-mcp-unmarked"]).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(outcomes["ro-mcp-destructive"]).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(outcomes["ro-mcp-exec-unmarked"]).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(outcomes["ro-exec-probe"]).toEqual({ outcome: "selected", optionId: "allow-always" });

    if (canNestOsSandbox) {
      const probeLog = h.logs().find((e) => e.event === "probe_write");
      expect(probeLog?.ok).toBe(false);
      expect(existsSync(probeTarget)).toBe(false);
    } else {
      expect(capturedSandboxInput).not.toBeNull();
      expect(capturedSandboxInput!.secretPaths.length).toBeGreaterThan(0);
      expect(capturedSandboxInput!.writableDirs).toContain(h.logDir);
      const roTmpDir = capturedSandboxInput!.tmpDir;
      expect(existsSync(roTmpDir)).toBe(true);
      await h.driver.end(row.id);
      expect(existsSync(roTmpDir)).toBe(false);
    }
  });

  it("厂商阻塞扩展请求响应、elicitation 自动拒绝与非标 sessionUpdate 拦截", async () => {
    const receivedCustomUpdates: Array<{ sessionUpdate: string; step?: unknown }> = [];
    const h = track(
      makeAcpHarness({
        config: {
          extensions: {
            onBlockingRequest: ({ method, params }) => {
              if (method === "ext/ask_question") {
                return { skipped: true, echoed: params };
              }
              if (method === "ext/create_plan") {
                return { approved: true };
              }
              return undefined;
            },
            onCustomSessionUpdate: ({ sessionUpdate, update }) => {
              receivedCustomUpdates.push({ sessionUpdate, step: update.step });
            },
          },
        },
        script: {
          turns: [
            {
              customUpdates: [{ sessionUpdate: "ext_custom_progress", payload: { step: "indexing" } }],
              extensionRequests: [
                { method: "ext/ask_question", params: { q: "which port?" } },
                { method: "ext/create_plan", params: { steps: 2 } },
                { method: "ext/unhandled_method", params: {} },
              ],
              elicitation: true,
              textChunks: ["扩展交互全部无阻塞完成"],
            },
          ],
        },
      }),
    );

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [61 as never], source: "user", text: "触发扩展请求" });
    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);

    expect(receivedCustomUpdates).toEqual([{ sessionUpdate: "ext_custom_progress", step: "indexing" }]);

    const extResponses = h.logs().filter((e) => e.event === "extension_response");
    expect(extResponses).toEqual([
      expect.objectContaining({
        method: "ext/ask_question",
        result: { skipped: true, echoed: { q: "which port?" } },
      }),
      expect.objectContaining({
        method: "ext/create_plan",
        result: { approved: true },
      }),
    ]);

    // 未注册扩展方法按标准 JSON-RPC -32601 立即拒绝，不挂起
    const extErrors = h.logs().filter((e) => e.event === "extension_error");
    expect(extErrors).toHaveLength(1);
    expect(extErrors[0]!.method).toBe("ext/unhandled_method");

    // 标准 elicitation/create 默认自动 decline
    const elicitationLog = h.logs().find((e) => e.event === "elicitation_response");
    expect(elicitationLog?.result).toEqual({ action: "decline" });
  });

  it("not_found：可执行文件不存在时抛出对应厂商的可重试 <vendor>_not_found 错误", async () => {
    const h = track(
      makeAcpHarness({
        driverOptions: {
          executablePath: "/nonexistent/acp-binary-does-not-exist",
        },
      }),
    );

    const row = h.addSession();
    let caught: unknown = null;
    try {
      await h.driver.send(row.id, { messageIds: [71 as never], source: "user", text: "测试找不到程序" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DriverError);
    const driverErr = caught as DriverError;
    expect(driverErr.code).toBe(notFoundCode(TEST_VENDOR));
    expect(driverErr.retryable).toBe(true);
  });

  it("异常退出与进程组清理：崩溃时冲刷半截文本、清理同进程组残留后台子进程，并在下一轮附带崩溃恢复说明", async () => {
    const h = track(makeAcpHarness());
    const childPidFile = join(h.logDir, "spawned-sleeper.pid");
    h.updateScript({
      turns: [
        {
          textChunks: ["崩溃前半截输出"],
          spawnChildPidFile: childPidFile,
          crashExitCode: 7,
        },
        {
          textChunks: ["崩溃后重新拉起恢复成功"],
        },
      ],
    });

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [81 as never], source: "user", text: "跑会崩溃的任务" });

    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("crash");
    expect(exited.exitCode).toBe(7);
    expect(exited.messageIds).toEqual([81]);
    expect(h.of("agent.text").map((e) => e.text)).toEqual(["崩溃前半截输出"]);

    // 验证同进程组派生的后台睡眠子进程已被 termGroupAfterExit 清理干净
    expect(existsSync(childPidFile)).toBe(true);
    const orphanPid = Number(readFileSync(childPidFile, "utf8").trim());
    expect(orphanPid).toBeGreaterThan(1);
    const reaped = await waitForExit(orphanPid, 2_000);
    expect(reaped).toBe(true);
    expect(isAlive(orphanPid)).toBe(false);

    // 重发同一条消息（之前崩溃已 forgetWritten）能够真正再次发送，且自动附带 CRASH_RECOVERY_NOTE
    const resend = await h.driver.send(row.id, { messageIds: [81 as never], source: "user", text: "跑会崩溃的任务" });
    expect(resend).toEqual({ kind: "written" });
    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);

    const prompts = h.logs().filter((e) => e.event === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.blocks).toContain(CRASH_RECOVERY_NOTE);
  });
});

describe("ACP 协议纯函数边界与上限守卫", () => {
  it("超长用户消息（> MAX_MESSAGE_BYTES）被拒绝并发射 invalid_input，命令缓存严格截断至 MAX_COMMANDS", async () => {
    const h = track(makeAcpHarness());
    const row = h.addSession();

    const hugeText = "a".repeat(MAX_MESSAGE_BYTES + 10);
    const res = await h.driver.send(row.id, {
      messageIds: [91 as never],
      source: "user",
      text: hugeText,
    });
    expect(res).toEqual({ kind: "rejected" });
    const errEvents = h.of("driver.error");
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0]!.code).toBe("invalid_input");
    expect(errEvents[0]!.messageIds).toEqual([91]);

    const manyCommands = Array.from({ length: MAX_COMMANDS + 50 }, (_, idx) => ({
      name: `cmd_${idx}`,
      description: `desc ${idx}`,
    }));
    const parsed = parseAcpAvailableCommands(manyCommands);
    expect(parsed).toHaveLength(MAX_COMMANDS);
  });

  it.each(["edit", "delete", "move", "switch_mode", "other", null, undefined] as const)("只读 %s 默认拒绝，配置不能越过边界", async (kind) => {
    const policy = buildReadonlyPolicy({ homeDir: homedir(), stateDir: "/tmp/acp-policy" });
    const result = await decideAcpPermission({
      request: {
        sessionId: "s", toolCall: { toolCallId: "t", title: "tool", kind },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      readonlyPolicy: policy, closing: false, signal: new AbortController().signal,
    }, { writeToolKinds: [], rejectOptionKinds: ["allow_once"], decide: () => ({ outcome: "selected", optionId: "allow" }) });
    expect(result).toEqual({ outcome: "cancelled" });
  });

  it.each(["read", "search", "think", "fetch", "execute"] as const)(
    "只读内置 %s 工具默认放行，但命中写工具名或追加 writeToolKinds 时拒绝",
    async (kind) => {
      const policy = buildReadonlyPolicy({ homeDir: homedir(), stateDir: "/tmp/acp-policy" });
      const options = [
        { optionId: "allow-always", name: "Always Allow", kind: "allow_always" as const },
        { optionId: "reject-once", name: "Reject Once", kind: "reject_once" as const },
      ];
      const allowed = await decideAcpPermission({
        request: {
          sessionId: "s",
          toolCall: { toolCallId: "t-ok", title: "Run builtin tool", name: "builtin_tool", kind },
          options,
        },
        readonlyPolicy: policy,
        closing: false,
        signal: new AbortController().signal,
      });
      expect(allowed).toEqual({ outcome: "selected", optionId: "allow-always" });

      const deniedByWriteName = await decideAcpPermission({
        request: {
          sessionId: "s",
          toolCall: { toolCallId: "t-write-name", title: "Write File", name: "write_file", kind },
          options,
        },
        readonlyPolicy: policy,
        closing: false,
        signal: new AbortController().signal,
      });
      expect(deniedByWriteName).toEqual({ outcome: "selected", optionId: "reject-once" });

      const deniedByExtraKind = await decideAcpPermission(
        {
          request: {
            sessionId: "s",
            toolCall: { toolCallId: "t-extra-kind", title: "Run builtin tool", name: "builtin_tool", kind },
            options,
          },
          readonlyPolicy: policy,
          closing: false,
          signal: new AbortController().signal,
        },
        { writeToolKinds: [kind] },
      );
      expect(deniedByExtraKind).toEqual({ outcome: "selected", optionId: "reject-once" });
    },
  );

  it("伪装成 kind: 'execute' 但属于未标只读的 MCP 工具仍被拒绝", async () => {
    const policy = buildReadonlyPolicy({
      homeDir: homedir(),
      stateDir: "/tmp/acp-policy",
      connectors: { extraAllow: ["runner/*"] },
    });
    const options = [
      { optionId: "allow-always", name: "Always Allow", kind: "allow_always" as const },
      { optionId: "reject-once", name: "Reject Once", kind: "reject_once" as const },
    ];
    const bypassAttemptCfg = {
      decide: () => ({ outcome: "selected" as const, optionId: "allow-always" }),
      extractMcpTool: () => null,
    };

    // 1. 命名前缀 mcp__<server>__<tool> 伪装成 kind: "execute"
    await expect(
      decideAcpPermission(
        {
          request: {
            sessionId: "s",
            toolCall: { toolCallId: "t1", title: "Run command", name: "mcp__runner__exec", kind: "execute" },
            options,
          },
          readonlyPolicy: policy,
          closing: false,
          signal: new AbortController().signal,
        },
        bypassAttemptCfg,
      ),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });

    // 2. 普通工具名 bash + kind: "execute"，但通过 _meta 声明 MCP 身份且未标 readOnlyHint: true
    await expect(
      decideAcpPermission(
        {
          request: {
            sessionId: "s",
            toolCall: {
              toolCallId: "t2",
              title: "Run shell",
              name: "bash",
              kind: "execute",
              _meta: { mcp: { server: "runner", tool: "exec", annotations: { readOnlyHint: false } } },
            },
            options,
          },
          readonlyPolicy: policy,
          closing: false,
          signal: new AbortController().signal,
        },
        bypassAttemptCfg,
      ),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });

    // 3. _meta 仅给 mcpServer（未重复给 tool 字段）或残缺 MCP 前缀 mcp_<flat>，伪装成 kind: "execute"
    await expect(
      decideAcpPermission(
        {
          request: {
            sessionId: "s",
            toolCall: {
              toolCallId: "t3",
              title: "Run shell",
              name: "bash",
              kind: "execute",
              _meta: { mcpServer: "runner" },
            },
            options,
          },
          readonlyPolicy: policy,
          closing: false,
          signal: new AbortController().signal,
        },
        bypassAttemptCfg,
      ),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });

    await expect(
      decideAcpPermission(
        {
          request: {
            sessionId: "s",
            toolCall: {
              toolCallId: "t4",
              title: "mcp_runner_exec",
              name: "mcp_runner_exec",
              kind: "execute",
            },
            options,
          },
          readonlyPolicy: policy,
          closing: false,
          signal: new AbortController().signal,
        },
        bypassAttemptCfg,
      ),
    ).resolves.toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("MCP 手动白名单也不能放行缺少 readOnlyHint 的请求", async () => {
    const result = await decideAcpPermission({
      request: {
        sessionId: "s", toolCall: { toolCallId: "t", title: "mcp__docs__write", kind: "other" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      readonlyPolicy: buildReadonlyPolicy({ homeDir: homedir(), stateDir: "/tmp/acp-policy", connectors: { extraAllow: ["docs/*"] } }),
      closing: false, signal: new AbortController().signal,
    });
    expect(result).toEqual({ outcome: "cancelled" });
  });

  it("单个超大 Unicode chunk 分段后每条消息仍在字节上限内且内容完整", async () => {
    const text = "你好🙂".repeat(MAX_MESSAGE_BYTES / 5);
    const h = track(makeAcpHarness({ script: { turns: [{ textChunks: [text] }] } }));
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [309 as never], source: "user", text: "large chunk" });
    await h.waitFor("turn.ended");
    const chunks = h.of("agent.text").map((e) => e.text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => Buffer.byteLength(c) <= MAX_MESSAGE_BYTES)).toBe(true);
  });

  it("数千次工具调用后下一轮复用 toolCallId，生命周期仍各自完整", async () => {
    const count = SESSION_STEPS_KEEP * 2;
    const h = track(makeAcpHarness({ script: { turns: [
      { toolCalls: Array.from({ length: count }, (_, i) => ({ toolCallId: `tool-${i}`, title: "read", kind: "read" })) },
      { toolCalls: [{ toolCallId: "tool-0", title: "read", kind: "read" }] },
    ] } }));
    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [312 as never], source: "user", text: "many tools" });
    await h.waitFor("turn.ended");
    await h.driver.send(row.id, { messageIds: [313 as never], source: "user", text: "reuse" });
    await h.waitFor("turn.ended", () => true, 2);
    expect(h.of("agent.tool")).toHaveLength(count + 1);
    expect(h.of("agent.tool_result")).toHaveLength(count + 1);
    expect(new Set(h.of("agent.tool").map((e) => e.uuid)).size).toBe(count + 1);
  });

  it("分组式 SessionConfigSelectGroup 选项与取消态权限裁决", async () => {
    const groupedOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: "m-default",
        options: [
          {
            group: "tier-pro",
            name: "Pro Models",
            options: [{ value: "Pro-Model-X", name: "Pro Model X" }],
          },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        type: "select" as const,
        currentValue: "medium",
        options: [{ value: "high", name: "High" }],
      },
    ];

    expect(resolveModelConfigUpdate("pro-model-x", groupedOptions)).toEqual({
      configId: "model",
      value: "Pro-Model-X",
    });
    expect(resolveEffortConfigUpdate("high", groupedOptions)).toEqual({
      configId: "thought_level",
      value: "high",
    });

    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const cancelledDecision = await decideAcpPermission({
      request: {
        sessionId: "s-1",
        toolCall: { toolCallId: "t-1", title: "read" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      },
      readonlyPolicy: null,
      closing: false,
      signal: abortCtrl.signal,
    });
    expect(cancelledDecision).toEqual({ outcome: "cancelled" });
  });

  it("流式工具更新（deepseek/cursor 共用 ACP）：初始 tool_call 空参后收到 tool_call_update 补齐路径，发出 agent.tool_preview 且不重复发 agent.tool", async () => {
    const h = track(
      makeAcpHarness({
        script: {
          turns: [
            {
              customUpdates: [
                {
                  sessionUpdate: "tool_call",
                  payload: {
                    toolCallId: "tc-stream-1",
                    title: "Read",
                    name: "read_file",
                    kind: "read",
                    status: "pending",
                    rawInput: {},
                  },
                },
                {
                  sessionUpdate: "tool_call_update",
                  payload: {
                    toolCallId: "tc-stream-1",
                    status: "in_progress",
                    locations: [{ path: "/repo/src/late-path.ts" }],
                  },
                },
                {
                  sessionUpdate: "tool_call_update",
                  payload: {
                    toolCallId: "tc-stream-1",
                    status: "in_progress",
                    locations: [{ path: "/repo/src/late-path.ts" }],
                  },
                },
                {
                  sessionUpdate: "tool_call_update",
                  payload: {
                    toolCallId: "tc-stream-1",
                    status: "completed",
                  },
                },
              ],
              textChunks: ["读取完成"],
            },
          ],
        },
      }),
    );

    const row = h.addSession();
    await h.driver.send(row.id, { messageIds: [401 as never], source: "user", text: "读文件" });
    await h.waitFor("turn.ended");

    expect(h.of("agent.tool")).toHaveLength(1);
    expect(h.of("agent.tool")[0]).toMatchObject({
      toolUseId: "tc-stream-1",
      name: "read_file",
      input: {},
    });
    expect(h.of("agent.tool_preview")).toHaveLength(1);
    expect(h.of("agent.tool_preview")[0]).toMatchObject({
      toolUseId: "tc-stream-1",
      name: "read_file",
      input: { path: "/repo/src/late-path.ts" },
    });
    expect(h.of("agent.tool_result")).toHaveLength(1);
  });
});
import { fileURLToPath } from "node:url";
import { wrapScriptAsPlatformCli } from "../../../../test/fake-cli-shim.ts";
