// Pi RPC 常驻驱动层测试：覆盖握手、流式思考/工具/文本、U+2028 行切分、多轮复用、中途 steer 插话、
// clear_queue + abort 打断、跨重启恢复、只读 Worker 参数与沙箱输入、get_session_stats 换代阈值、/compact 与异常退出。
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  HANDOVER_TOKEN_THRESHOLD,
  buildReadonlyPolicy,
  workerWriteScope,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
  type SessionStore,
} from "../../shared/index.ts";
import type { ReadonlySandboxInput } from "../../daemon/driver/write-scope.ts";
import { createPiDriver, type PiDriver, type PiDriverOptions } from "./driver.ts";
import {
  writeFakePiBinary,
  type FakePiFiles,
  type FakePiLogEntry,
  type FakePiScript,
} from "./fixtures/fake-pi.ts";
import { READONLY_PI_NEEDS_SANDBOX_MESSAGE } from "./readonly.ts";
import { piSessionDirName } from "./transcript.ts";

class MemorySessionStore implements SessionStore {
  readonly rows = new Map<SessionId, AgentSessionRow>();
  readonly patches: Array<{ id: SessionId; patch: AgentSessionPatch }> = [];

  add(row: AgentSessionRow): void {
    this.rows.set(row.id, row);
  }
  get(id: SessionId): AgentSessionRow | null {
    return this.rows.get(id) ?? null;
  }
  update(id: SessionId, patch: AgentSessionPatch): AgentSessionRow {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no session ${id}`);
    this.patches.push({ id, patch });
    const next = { ...row, ...patch, updatedAt: Date.now() };
    this.rows.set(id, next);
    return next;
  }
  listWithProcess(): AgentSessionRow[] {
    return [...this.rows.values()].filter((r) => r.pid !== null);
  }
}

interface PiTestHarness {
  dir: string;
  stateDir: string;
  fake: FakePiFiles;
  store: MemorySessionStore;
  driver: PiDriver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  log(): FakePiLogEntry[];
  rpcIn(): Array<Record<string, unknown>>;
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  setReadonly(sessionId: SessionId, readonly: boolean): void;
  cleanup(): Promise<void>;
}

const harnesses: PiTestHarness[] = [];
let nextSessionId = 1;

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function makePiHarness(
  options: {
    script?: FakePiScript;
    driver?: Partial<PiDriverOptions>;
  } = {},
): PiTestHarness {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-pi-driver-")));
  const stateDir = join(dir, "state");
  const agentDir = join(dir, ".pi", "agent");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const fake = writeFakePiBinary(dir, options.script ?? {});
  const store = new MemorySessionStore();
  const readonlyMap = new Map<SessionId, boolean>();

  const driver = createPiDriver({
    executablePath: fake.binPath,
    homeDir: dir,
    store,
    prepareLaunch: async (session) => {
      const launchDir = join(stateDir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      const promptFile = join(launchDir, "prompt.md");
      writeFileSync(promptFile, `你是 ${session.role}。`);
      const readonly = readonlyMap.get(session.id) ?? false;
      const files: LaunchFiles = {
        promptFile,
        env: {
          HUB_TOKEN: `tok-${session.id}`,
          HUB_SOCK: join(dir, "run", "hub.sock"),
          PI_CODING_AGENT_DIR: agentDir,
        },
        fingerprint: `fp-${session.role}-${readonly ? "ro" : "rw"}`,
      };
      const writeScope = workerWriteScope({ role: session.role, dataDir: dir, cwd: session.cwd });
      if (writeScope !== null) files.writeScope = writeScope;
      if (readonly) files.readonly = buildReadonlyPolicy({ homeDir: dir, stateDir });
      return files;
    },
    env: {
      FAKE_PI_LOG: fake.logPath,
      FAKE_PI_SCRIPT: fake.scriptPath,
      PI_CODING_AGENT_DIR: agentDir,
    },
    writeScopeSpawn: (base) => ({ ...base, osSandboxed: true }),
    readonlySpawn: (base) => ({ ...base, osSandboxed: true }),
    ...options.driver,
  });

  const events: PiTestHarness["events"] = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
    for (const w of waiters.splice(0)) w();
  });

  const of = <T extends DriverEvent["type"]>(type: T) =>
    events.map((e) => e.event).filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

  const waitFor: PiTestHarness["waitFor"] = (type, pred = () => true, count = 1) =>
    new Promise((resolve) => {
      const check = () => {
        const hits = of(type).filter(pred);
        if (hits.length >= count) resolve(hits[count - 1]!);
        else waiters.push(check);
      };
      check();
    });

  const addSession = (patch: Partial<AgentSessionRow> = {}): AgentSessionRow => {
    const id = nextSessionId++;
    const cwd = join(dir, "workspace", String(id));
    mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
    const row: AgentSessionRow = {
      id,
      role: "pm",
      conversationId: id,
      pmId: 1,
      workerId: null,
      vendor: "pi",
      vendorSessionId: `pi-sess-${id}`,
      cwd,
      addDirs: [],
      generation: 1,
      model: "deepseek/deepseek-v4-pro",
      effort: "high",
      pid: null,
      status: "idle",
      hasCompletedTurn: false,
      lastEventAt: null,
      rateLimit: null,
      usage: { ...EMPTY_TOKEN_USAGE },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...patch,
    };
    store.add(row);
    return row;
  };

  const harness: PiTestHarness = {
    dir,
    stateDir,
    fake,
    store,
    driver,
    events,
    waitFor,
    of,
    log: () => fake.readLogs(),
    rpcIn: () =>
      fake
        .readLogs()
        .filter((e) => e.kind === "rpc_in" && e.msg)
        .map((e) => e.msg!),
    addSession,
    setReadonly: (sessionId, ro) => readonlyMap.set(sessionId, ro),
    async cleanup() {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("PiDriver：常驻 RPC 驱动协议与生命周期", () => {
  it("simple：单轮握手、显式 --skill（无 --approve）、流式思考/工具/含 U+2028 文本与扩展弹窗自动取消", async () => {
    const h = makePiHarness({
      script: {
        turns: [
          {
            blockingUiMethod: "confirm",
            autoRetry: { attempt: 1, maxAttempts: 3, delayMs: 250, errorMessage: "429 Too Many Requests" },
            thinkingDeltas: ["先检查目录，", "再读取文件。"],
            tools: [{ id: "call-read-1", name: "read", arguments: { path: "README.md" }, output: "hello" }],
            textDeltas: ["第一行\u2028段落内分隔符不断行", "，完成。"],
            usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 10 },
            contextTokens: 200,
          },
        ],
      },
    });
    const row = h.addSession();

    const sendRes = await h.driver.send(row.id, {
      messageIds: [101],
      source: "user",
      text: "查一下项目\u2028不要在 U+2028 断行",
    });
    expect(sendRes).toEqual({ kind: "written" });

    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(ended.interrupted).toBe(false);
    expect(ended.messageIds).toEqual([101]);

    // 校验启动参数：有 --mode rpc、--session-id、--append-system-prompt、--skill、--model、--thinking，绝无 --approve
    const argvLog = h.log().find((e) => e.kind === "argv")!;
    expect(argvLog.argv).toContain("--mode");
    expect(argvLog.argv).toContain("rpc");
    expect(argvLog.argv).toContain("--session-id");
    expect(argvLog.argv).toContain(row.vendorSessionId);
    expect(argvLog.argv).toContain("--append-system-prompt");
    expect(argvLog.argv).toContain("--skill");
    expect(argvLog.argv).toContain(join(row.cwd, ".agents", "skills"));
    expect(argvLog.argv).toContain("--model");
    expect(argvLog.argv).toContain("deepseek/deepseek-v4-pro");
    expect(argvLog.argv).toContain("--thinking");
    expect(argvLog.argv).toContain("high");
    expect(argvLog.argv).not.toContain("--approve");

    // 校验事件完整且不重复
    expect(h.of("session.started")).toHaveLength(1);
    expect(h.of("api_retry")[0]?.info.errorStatus).toBe(429);
    expect(h.of("agent.thinking")).toHaveLength(1);
    expect(h.of("agent.tool")).toHaveLength(1);
    expect(h.of("agent.tool")[0]?.name).toBe("read");
    expect(h.of("agent.tool_result")[0]?.toolUseIds).toEqual(["call-read-1"]);
    expect(h.of("agent.text")).toHaveLength(1);
    expect(h.of("agent.text")[0]?.text).toBe("第一行\u2028段落内分隔符不断行，完成。");

    // 阻塞弹窗已被回 cancelled: true
    expect(h.rpcIn().some((m) => m.type === "extension_ui_response" && m.cancelled === true)).toBe(true);

    // 运行中会话直接通过 RPC get_commands 查命令
    const commands = await h.driver.queryCommands(row.id);
    expect(commands?.map((c) => c.name)).toContain("skill:demo-skill");
    expect(commands?.map((c) => c.name)).toContain("compact");

    const updated = h.store.get(row.id)!;
    expect(updated.hasCompletedTurn).toBe(true);
    expect(updated.usage).toEqual({
      input: 120,
      cacheRead: 40,
      cacheWrite: 10,
      output: 30,
      context: 200,
    });
  });

  it("multi_turn：连续多轮复用同一个常驻 RPC 进程并累加用量", async () => {
    const h = makePiHarness({
      script: {
        turns: [
          { textDeltas: ["第一轮回复"], usage: { input: 100, output: 20 }, contextTokens: 120 },
          { textDeltas: ["第二轮回复"], usage: { input: 150, output: 25 }, contextTokens: 295 },
        ],
      },
    });
    const row = h.addSession();

    await h.driver.send(row.id, { messageIds: [1], source: "user", text: "第一问" });
    await h.waitFor("turn.ended", () => true, 1);

    await h.driver.send(row.id, { messageIds: [2], source: "user", text: "第二问" });
    await h.waitFor("turn.ended", () => true, 2);

    const pids = new Set(h.log().filter((e) => e.kind === "argv").map((e) => e.pid));
    expect(pids.size).toBe(1);
    expect(h.of("agent.text").map((e) => e.text)).toEqual(["第一轮回复", "第二轮回复"]);
    expect(h.store.get(row.id)!.usage).toEqual({
      input: 250,
      cacheRead: 0,
      cacheWrite: 0,
      output: 45,
      context: 295,
    });
  });

  it("steer 中途插话：忙时走 streamingBehavior: steer 同一轮消费；若轮末未取走则自动排入下一轮", async () => {
    const hold1 = join(tmpdir(), `pi-hold-1-${Date.now()}-${Math.random()}`);
    const hold2 = join(tmpdir(), `pi-hold-2-${Date.now()}-${Math.random()}`);
    try {
      const h = makePiHarness({
        script: {
          turns: [
            {
              tools: [{ id: "call-bash-1", name: "bash", arguments: { command: "sleep 1" } }],
              holdFile: hold1,
              textDeltas: ["合并处理完第一条与插话"],
              usage: { input: 200, output: 40 },
              contextTokens: 240,
            },
            {
              tools: [{ id: "call-bash-2", name: "bash", arguments: { command: "ls" } }],
              holdFile: hold2,
              dropSteers: true,
              textDeltas: ["第二轮正文"],
              usage: { input: 100, output: 10 },
              contextTokens: 350,
            },
            {
              textDeltas: ["第三轮补跑未取走的插话"],
              usage: { input: 80, output: 15 },
              contextTokens: 445,
            },
          ],
        },
      });
      const row = h.addSession();

      // 第 1 轮：工具挂起期间发 steer，验证 midTurn: true 且在同一轮结算
      await h.driver.send(row.id, { messageIds: [10], source: "user", text: "先跑任务" });
      await h.waitFor("agent.tool", (e) => e.toolUseId === "call-bash-1");

      const steerRes = await h.driver.send(row.id, {
        messageIds: [11],
        source: "user",
        text: "顺便改一下标题",
      });
      expect(steerRes).toEqual({ kind: "written", midTurn: true });

      const steerRpc = h.rpcIn().find((m) => m.type === "prompt" && m.streamingBehavior === "steer");
      expect(steerRpc?.message).toBe("顺便改一下标题");

      writeFileSync(hold1, "go");
      const turn1 = await h.waitFor("turn.ended", () => true, 1);
      expect(turn1.ok).toBe(true);
      expect(turn1.messageIds).toEqual([10, 11]);

      // 第 2 轮：dropSteers 模拟轮末刚好结束未消费 steer → 发出 message.requeued 并忘掉已写标记，供账本重发成第 3 轮
      await h.driver.send(row.id, { messageIds: [20], source: "user", text: "第二轮任务" });
      await h.waitFor("agent.tool", (e) => e.toolUseId === "call-bash-2");
      const lateSteer = await h.driver.send(row.id, {
        messageIds: [21],
        source: "user",
        text: "差点赶上的插话",
      });
      expect(lateSteer).toEqual({ kind: "written", midTurn: true });

      writeFileSync(hold2, "go");
      const turn2 = await h.waitFor("turn.ended", () => true, 2);
      expect(turn2.messageIds).toEqual([20]);
      const requeued = await h.waitFor("message.requeued");
      expect(requeued.messageIds).toEqual([21]);

      // 账本收到 message.requeued 后以同 messageId 重发：不会因幂等表误吞，正常跑出第 3 轮
      const resendRes = await h.driver.send(row.id, {
        messageIds: [21],
        source: "user",
        text: "差点赶上的插话",
      });
      expect(resendRes).toEqual({ kind: "written" });
      const turn3 = await h.waitFor("turn.ended", () => true, 3);
      expect(turn3.ok).toBe(true);
      expect(turn3.messageIds).toEqual([21]);
    } finally {
      rmSync(hold1, { force: true });
      rmSync(hold2, { force: true });
    }
  });

  it("turn_interrupt：先发 clear_queue 再发 abort，报 interrupted: true；进程卡死时超时升级 SIGINT", async () => {
    const h = makePiHarness({
      script: {
        turns: [
          {
            tools: [{ id: "call-long", name: "bash", arguments: { command: "long-job" } }],
            waitForAbort: true,
          },
          {
            tools: [{ id: "call-stuck", name: "bash", arguments: { command: "stuck-job" } }],
            waitForAbort: true,
            ignoreAbort: true,
          },
        ],
      },
      driver: { interruptGraceMs: 120 },
    });
    const row = h.addSession();

    // 1. 正常优雅打断：clear_queue 必须在 abort 之前发出
    await h.driver.send(row.id, { messageIds: [30], source: "user", text: "跑个长命令" });
    await h.waitFor("agent.tool", (e) => e.toolUseId === "call-long");

    await h.driver.interrupt(row.id);
    const interruptedTurn = await h.waitFor("turn.ended", () => true, 1);
    expect(interruptedTurn.ok).toBe(false);
    expect(interruptedTurn.interrupted).toBe(true);

    const methods = h.rpcIn().map((m) => m.type);
    const clearIdx = methods.indexOf("clear_queue");
    const abortIdx = methods.indexOf("abort");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(abortIdx).toBeGreaterThan(clearIdx);

    // 2. 忽略 abort 时升级到 SIGINT 杀进程组
    await h.driver.send(row.id, { messageIds: [31], source: "user", text: "跑个卡死命令" });
    await h.waitFor("agent.tool", (e) => e.toolUseId === "call-stuck");
    await h.driver.interrupt(row.id);
    const exited = await h.waitFor("session.exited");
    expect(exited.reason).toBe("interrupt");
    expect(h.log().some((e) => e.kind === "signal" && e.signal === "SIGINT")).toBe(true);
  });

  it("resume：重启驱动后对已完成过轮次的会话传 --session 恢复，session.started 标 resumed: true", async () => {
    const h = makePiHarness({
      script: {
        initialTokens: { input: 1000, output: 200 },
        initialContextTokens: 1200,
        turns: [{ textDeltas: ["恢复后继续"], usage: { input: 50, output: 10 }, contextTokens: 1260 }],
      },
    });
    const row = h.addSession({
      vendorSessionId: "prev-session-42",
      hasCompletedTurn: true,
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200, context: 1200 },
    });

    // 预先落盘旧会话 JSONL
    const sessionDir = join(h.dir, ".pi", "agent", "sessions", piSessionDirName(row.cwd));
    mkdirSync(sessionDir, { recursive: true });
    const existingFile = join(sessionDir, "2026-11-10T12-00-00-000Z_prev-session-42.jsonl");
    writeFileSync(existingFile, '{"type":"session","version":3,"id":"prev-session-42"}\n');

    await h.driver.send(row.id, { messageIds: [50], source: "user", text: "接着做" });
    await h.waitFor("turn.ended");

    const started = h.of("session.started")[0]!;
    expect(started.resumed).toBe(true);

    const argv = h.log().find((e) => e.kind === "argv")!.argv!;
    expect(argv).toContain("--session");
    expect(argv).toContain(existingFile);
  });

  it("只读 Worker：加 --exclude-tools edit,write --no-mcp，组装只读沙箱且无沙箱时拒绝启动", async () => {
    let capturedInput: ReadonlySandboxInput | null = null;
    const h = makePiHarness({
      driver: {
        readonlySpawn: (base, input) => {
          capturedInput = input;
          return { ...base, osSandboxed: true };
        },
      },
    });
    const row = h.addSession({ role: "worker", workerId: 7 });
    h.setReadonly(row.id, true);

    await h.driver.send(row.id, { messageIds: [60], source: "user", text: "只读检查" });
    await h.waitFor("turn.ended");

    const argvEntry = h.log().find((e) => e.kind === "argv")!;
    expect(argvEntry.argv).toContain("--exclude-tools");
    expect(argvEntry.argv).toContain("edit,write");
    expect(argvEntry.argv).toContain("--no-mcp");
    expect(capturedInput).not.toBeNull();
    // Pi 自己的 auth.json / models.json 允许只读打开（不可写），别家的敏感路径仍在禁读列表
    expect(capturedInput!.secretPaths).not.toContain(join(h.dir, ".pi", "agent", "auth.json"));
    expect(capturedInput!.secretPaths).toContain(join(h.dir, ".ssh"));
    const privateTmp = argvEntry.envSnapshot?.TMPDIR;
    expect(privateTmp).toContain("agent-hub-ro-");

    // 结束会话后私有 TMPDIR 立即清理，driver 内存不残留会话
    await h.driver.end(row.id);
    expect(privateTmp && existsSync(privateTmp)).toBe(false);

    // 平台不支持 OS 沙箱时直接拒绝启动只读 Worker
    const hNoSandbox = makePiHarness({
      driver: {
        readonlySpawn: (base) => ({ ...base, osSandboxed: false }),
      },
    });
    const row2 = hNoSandbox.addSession({ role: "worker", workerId: 8 });
    hNoSandbox.setReadonly(row2.id, true);
    await expect(
      hNoSandbox.driver.send(row2.id, { messageIds: [61], source: "user", text: "只读" }),
    ).rejects.toThrow(READONLY_PI_NEEDS_SANDBOX_MESSAGE);
  });

  it("get_session_stats 换代阈值与手动 /compact：准确写入 usage.context 并走 RPC compact 命令", async () => {
    const overThreshold = HANDOVER_TOKEN_THRESHOLD + 15_000;
    const h = makePiHarness({
      script: {
        turns: [
          {
            textDeltas: ["长对话回复"],
            usage: { input: 190_000, cacheRead: 25_000, output: 1_200 },
            contextTokens: overThreshold,
          },
        ],
      },
    });
    const row = h.addSession();

    await h.driver.send(row.id, { messageIds: [70], source: "user", text: "总结全仓" });
    await h.waitFor("turn.ended", () => true, 1);
    expect(h.store.get(row.id)!.usage.context).toBe(overThreshold);
    expect(h.store.get(row.id)!.usage.context).toBeGreaterThan(HANDOVER_TOKEN_THRESHOLD);

    // 发送 /compact 走 RPC compact 而非 prompt，并发出 context.compacted 与压缩后的 usage.context
    await h.driver.send(row.id, { messageIds: [71], source: "user", text: "/compact 保留关键架构决定" });
    await h.waitFor("turn.ended", () => true, 2);

    const compactRpc = h.rpcIn().find((m) => m.type === "compact");
    expect(compactRpc?.customInstructions).toBe("保留关键架构决定");
    const compacted = h.of("context.compacted")[0]!;
    expect(compacted.trigger).toBe("manual");
    expect(compacted.preTokens).toBe(overThreshold);
    expect(compacted.postTokens).toBe(24_000);
    expect(h.store.get(row.id)!.usage.context).toBe(24_000);
  });

  it("not_found：找不到 pi 可执行文件时报 DriverError(pi_not_found)", async () => {
    const h = makePiHarness({
      driver: { executablePath: "/nonexistent/path/to/pi-missing-bin" },
    });
    const row = h.addSession();

    await expect(
      h.driver.send(row.id, { messageIds: [80], source: "user", text: "你好" }),
    ).rejects.toSatisfy((err: unknown) => err instanceof DriverError && err.code === "pi_not_found");
  });
});
