// AgyDriver 与 protocol.ts 单元测试（TDD：覆盖协议纯函数、首轮完整流式交互、长连接复用与恢复、SIGINT 打断、Worker 安全拦截、生命周期管理）。
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  RELAUNCH_NOTE,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  backgroundTasksKilledNote,
  buildReadonlyPolicy,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
  type SessionStore,
  type WriteScope,
} from "../../shared/index.ts";
import { AGY_DENIED_CONTINUE_MAX } from "./limits.ts";
import { createAgyDriver, type AgyDriver, type AgyDriverOptions } from "./driver.ts";
import { describeStep } from "../../shared/step-labels.ts";
import { toolFinished, toolStarted, working, type LiveSession } from "../../daemon/ledger/sessions.ts";
import { stepOfTool } from "../../daemon/ledger/tool-summary.ts";
import type { AgyConnectorCatalog } from "./readonly.ts";
import { makePersonaFixture, type PersonaFixture } from "../../daemon/driver/persona-fixture.ts";
import { fakePreambleLedger, PREAMBLE } from "../../daemon/driver/preamble-fixture.ts";
import { SANDBOX_EXEC, type SpawnCommand } from "../../daemon/driver/write-scope.ts";
import {
  buildAgyArgs,
  buildAgyUserLine,
  checkAgyUserLine,
  WRITE_SCOPE_VIOLATION_MESSAGE,
  checkWorkerToolViolation,
  detectAgyArgsConflict,
  formatSystemInstructions,
  parseAgyUsage,
} from "./protocol.ts";

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

const canRunSandboxExec =
  process.platform === "darwin" &&
  existsSync(SANDBOX_EXEC) &&
  (() => {
    try {
      execFileSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

const canRunPs = (() => {
  try {
    execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
  set(id: SessionId, patch: Partial<AgentSessionRow>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no session ${id}`);
    this.rows.set(id, { ...row, ...patch });
  }
  listWithProcess(): AgentSessionRow[] {
    return [...this.rows.values()].filter((r) => r.pid !== null);
  }
}

interface FakeAgyTurn {
  /** 等这个文件出现才出 user_input（模拟写进去了、agy 还没取走）。 */
  holdUserInput?: string;
  steps?: Array<
    | { type: "text"; stepId?: number; deltas: string[]; usage?: Record<string, number>; omitDone?: boolean }
    | {
        type: "tool";
        stepId?: number;
        name: string;
        parameters?: Record<string, unknown>;
        durationMs?: number;
        background?: boolean;
        omitDone?: boolean;
        doneAfterResultMs?: number;
        endState?: "DONE" | "FAILED" | "CANCELLED" | "CANCELED" | "ERROR";
        duplicateEndStates?: Array<"DONE" | "FAILED" | "CANCELLED" | "CANCELED" | "ERROR">;
      }
    | { type: "rawStepUpdate"; stepUpdate: Record<string, unknown> }
    | { type: "backgroundTasks"; tasks: Array<string | Record<string, unknown>> | "malformed" }
    | { type: "sleep"; ms: number }
    | { type: "waitFile"; path: string }
  >;
  backgroundTasksAfter?: Array<{ afterMs: number; tasks: Array<string | Record<string, unknown>> | "malformed" }>;
  result?: {
    status?: "SUCCESS" | "ERROR";
    finishedReason?: string | null;
    response?: string;
    usage?: Record<string, number>;
    error?: string;
    /** result.denied_actions（agy 无头模式下遇到要批准的操作自动拒绝）。 */
    deniedActions?: unknown[];
  };
}

interface FakeAgyScript {
  assignedConversationId?: string;
  tools?: string[];
  turns?: FakeAgyTurn[];
  defaultTurn?: FakeAgyTurn;
  rejectConversationOnce?: boolean;
  /** SIGINT 时不出 result，直接退出。 */
  silentSigint?: boolean;
}

interface FakeAgyLogEntry {
  kind: "argv" | "stdin" | "signal" | "exit" | "probe";
  pid: number;
  argv?: string[];
  cwd?: string;
  line?: string;
  signal?: string;
  code?: number;
  /** kind probe：FAKE_AGY_PROBE 写没写成。 */
  ok?: boolean;
  errno?: string;
}

/** 生成模拟 agy CLI 行为的 Node 脚本。 */
function writeFakeAgyScript(scriptPath: string): void {
  const code = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const logFile = process.env.FAKE_AGY_LOG;
const scriptFile = process.env.FAKE_AGY_SCRIPT;
const stateDir = process.env.FAKE_AGY_STATE;

function log(entry) {
  if (logFile) appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

const argv = process.argv.slice(2);
log({ kind: "argv", argv, cwd: process.cwd() });
if (process.env.FAKE_AGY_PROBE) {
  try {
    writeFileSync(process.env.FAKE_AGY_PROBE, "probe");
    log({ kind: "probe", ok: true });
  } catch (error) {
    log({ kind: "probe", ok: false, errno: error.code });
  }
}

const script = scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, "utf8")) : {};
const convIdx = argv.indexOf("--conversation");
const requestedConv = convIdx >= 0 ? argv[convIdx + 1] : null;

if (requestedConv && script.rejectConversationOnce && stateDir) {
  const marker = join(stateDir, "rejected-once");
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stderr.write("Error: conversation " + requestedConv + " not found\\n");
    log({ kind: "exit", code: 1 });
    process.exit(1);
  }
}

const conversationId = requestedConv || script.assignedConversationId || "agy-conv-default-001";
let initSent = false;
let busy = false;
let interrupted = false;
let stdinClosed = false;
let stepCounter = 1;
const inbox = [];

function nextTurnIndex() {
  if (!stateDir) return 0;
  const f = join(stateDir, "turn-count");
  const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
  writeFileSync(f, String(n + 1));
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(userObj) {
  busy = true;
  interrupted = false;
  const turnIdx = nextTurnIndex();
  const turn = (script.turns && script.turns[turnIdx]) || script.defaultTurn || {
    steps: [{ type: "text", deltas: ["默认回复"] }],
  };

  if (!initSent) {
    initSent = true;
    emit({
      event: "init",
      conversation_id: conversationId,
      init: {
        cwd: process.cwd(),
        tools: script.tools || ["read_file", "edit_file", "run_command"],
        permission_mode: argv.includes("plan") ? "plan" : "auto",
      },
    });
  }

  if (turn.holdUserInput) {
    while (!existsSync(turn.holdUserInput) && !interrupted) await sleep(20);
    if (interrupted) return;
  }
  const userStepId = stepCounter++;
  emit({
    event: "step_update",
    step_update: { conversation_id: conversationId, step_index: userStepId, step_type: "user_input", state: "DONE" },
  });

  let lastFullText = "";
  for (const step of turn.steps || []) {
    if (interrupted) return;
    if (step.type === "sleep") {
      await sleep(step.ms);
    } else if (step.type === "waitFile") {
      while (!existsSync(step.path) && !interrupted) await sleep(20);
    } else if (step.type === "text") {
      const sid = step.stepId ?? stepCounter++;
      let acc = "";
      for (const d of step.deltas) {
        if (interrupted) return;
        acc += d;
        emit({
          event: "step_update",
          step_update: {
            conversation_id: conversationId,
            step_index: sid,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: d,
            ...(step.usage ? { usage: step.usage } : {}),
          },
        });
      }
      lastFullText = acc;
      if (!step.omitDone) {
        emit({
          event: "step_update",
          step_update: {
            conversation_id: conversationId,
            step_index: sid,
            step_type: "agent_response",
            state: "DONE",
            text_delta: "",
            ...(step.usage ? { usage: step.usage } : {}),
          },
        });
      }
    } else if (step.type === "backgroundTasks") {
      const entry = (t) => (typeof t === "string" ? { task_id: t, description: "fake task " + t } : t);
      emit({
        event: "background_tasks_changed",
        conversation_id: conversationId,
        ...(step.tasks === "malformed" ? {} : { tasks: step.tasks.map(entry) }),
      });
    } else if (step.type === "rawStepUpdate") {
      emit({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          ...step.stepUpdate,
        },
      });
    } else if (step.type === "tool") {
      const sid = step.stepId ?? stepCounter++;
      const endState = step.endState || "DONE";
      emit({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: sid,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: step.name,
          ...(step.background ? { background: true } : {}),
          tool_info: { parameters: step.parameters ?? {} },
        },
      });
      if (step.durationMs) {
        await sleep(step.durationMs);
      }
      if (interrupted) return;
      if (step.doneAfterResultMs) {
        setTimeout(() => {
          emit({
            event: "step_update",
            step_update: {
              conversation_id: conversationId,
              step_index: sid,
              step_type: "tool",
              state: endState,
              tool_name: step.name,
              tool_info: { parameters: step.parameters ?? {} },
            },
          });
        }, step.doneAfterResultMs);
      } else if (!step.omitDone) {
        emit({
          event: "step_update",
          step_update: {
            conversation_id: conversationId,
            step_index: sid,
            step_type: "tool",
            state: endState,
            tool_name: step.name,
            tool_info: { parameters: step.parameters ?? {} },
          },
        });
        for (const dupState of step.duplicateEndStates || []) {
          emit({
            event: "step_update",
            step_update: {
              conversation_id: conversationId,
              step_index: sid,
              step_type: "tool",
              state: dupState,
              tool_name: step.name,
              tool_info: { parameters: step.parameters ?? {} },
            },
          });
        }
      }
    }
  }

  if (interrupted) return;
  const r = turn.result || {};
  emit({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: r.status || "SUCCESS",
      finished_reason: r.finishedReason ?? null,
      response: r.response !== undefined ? r.response : lastFullText,
      usage: r.usage || { input_tokens: 20, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 8 },
      ...(r.error ? { error: r.error } : {}),
      ...(r.deniedActions ? { denied_actions: r.deniedActions } : {}),
    },
  });
  for (const ev of turn.backgroundTasksAfter || []) {
    const entry = (t) => (typeof t === "string" ? { task_id: t, description: "fake task " + t } : t);
    setTimeout(() => {
      emit({
        event: "background_tasks_changed",
        conversation_id: conversationId,
        ...(ev.tasks === "malformed" ? {} : { tasks: ev.tasks.map(entry) }),
      });
    }, ev.afterMs);
  }
  busy = false;
  if (inbox.length > 0) {
    const next = inbox.shift();
    void runTurn(next);
  } else if (stdinClosed) {
    log({ kind: "exit", code: 0 });
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  log({ kind: "signal", signal: "SIGINT" });
  interrupted = true;
  if (busy && !script.silentSigint) {
    emit({
      event: "result",
      conversation_id: conversationId,
      result: {
        status: "ERROR",
        finished_reason: "interrupted",
        response: "",
        usage: { input_tokens: 5, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0 },
        error: "interrupted by user",
      },
    });
  }
  log({ kind: "exit", code: 1 });
  process.exit(1);
});

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  log({ kind: "stdin", line });
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    process.stderr.write("Invalid JSON line\\n");
    process.exit(1);
  }
  if (obj.event !== "user") return;
  if (busy) inbox.push(obj);
  else void runTurn(obj);
});
rl.on("close", () => {
  stdinClosed = true;
  if (!busy) {
    log({ kind: "exit", code: 0 });
    process.exit(0);
  }
});
`;
  writeFileSync(scriptPath, code, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
}

interface AgyTestHarness {
  dir: string;
  stateDir: string;
  store: MemorySessionStore;
  driver: AgyDriver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
  launch: {
    prompt: string;
    fingerprint: string;
    readonly: boolean;
    env: Record<string, string>;
    personaRevision: (() => number) | null;
    /** 给了就当 LaunchFiles.writeScope（Worker 的可写范围）。 */
    writeScope: WriteScope | null;
    /** 只读 Worker 起进程前问到的连接器清单。 */
    catalog: AgyConnectorCatalog;
  };
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  log(): FakeAgyLogEntry[];
  argvs(): string[][];
  stdinBlocks(): string[][];
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  cleanup(): Promise<void>;
}

/** 本用例建过的所有 harness（一个用例里可以建好几个，afterEach 要全清：只清最后一个的话前面的假进程会留在机器上）。 */
const harnesses: AgyTestHarness[] = [];
let nextSessionId = 1;

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function makeAgyHarness(options: { script?: FakeAgyScript; driver?: Partial<AgyDriverOptions> } = {}): AgyTestHarness {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-agy-driver-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const fakeAgyPath = join(dir, "fake-agy.mjs");
  writeFakeAgyScript(fakeAgyPath);

  const logFile = join(dir, "fake-agy.log");
  const scriptFile = join(dir, "script.json");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}));

  const store = new MemorySessionStore();
  const launch = {
    prompt: "你是 Antigravity 驱动测试里的 Agent。",
    fingerprint: "fp-1",
    readonly: false,
    env: {} as Record<string, string>,
    /** 给了就当 LaunchFiles.personaRevision（见 persona-fixture.ts）。 */
    personaRevision: null as (() => number) | null,
    writeScope: null as WriteScope | null,
    catalog: { servers: {}, unlistable: [] } as AgyConnectorCatalog,
  };

  const driver = createAgyDriver({
    executablePath: fakeAgyPath,
    store,
    prepareLaunch: async (session) => {
      const launchDir = join(stateDir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      const promptFile = join(launchDir, "prompt.md");
      const settingsFile = join(launchDir, "settings.json");
      writeFileSync(promptFile, launch.prompt);
      writeFileSync(
        settingsFile,
        JSON.stringify({
          permissions: {
            defaultMode: launch.readonly ? "dontAsk" : "auto",
            allow: ["Bash(hub:*)"],
          },
        }),
      );
      return {
        promptFile,
        settingsFile,
        env: { ...launch.env },
        fingerprint: launch.fingerprint,
        ...(launch.personaRevision ? { personaRevision: launch.personaRevision() } : {}),
        ...(launch.writeScope ? { writeScope: launch.writeScope } : {}),
        ...(launch.readonly ? { readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir }) } : {}),
      };
    },
    env: {
      FAKE_AGY_LOG: logFile,
      FAKE_AGY_SCRIPT: scriptFile,
      FAKE_AGY_STATE: dir,
    },
    // 只读 Worker：不碰真的 MCP 配置、不真包 sandbox-exec（CI 的 Linux 没有；真沙箱的用例在 write-scope.test.ts）
    connectorCatalog: async () => launch.catalog,
    readonlySpawn: (base) => ({ ...base, osSandboxed: true }),
    homeDir: dir,
    ...options.driver,
  });

  const events: AgyTestHarness["events"] = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
    for (const w of waiters.splice(0)) w();
  });

  const of = <T extends DriverEvent["type"]>(type: T) =>
    events.map((e) => e.event).filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

  const waitFor: AgyTestHarness["waitFor"] = (type, pred = () => true, count = 1) =>
    new Promise((resolve) => {
      const check = () => {
        const hits = of(type).filter(pred);
        if (hits.length >= count) resolve(hits[count - 1]!);
        else waiters.push(check);
      };
      check();
    });

  const log = (): FakeAgyLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeAgyLogEntry)
      : [];

  const stdinBlocks = () =>
    log().flatMap((e) => {
      if (e.kind !== "stdin" || !e.line) return [];
      const obj = JSON.parse(e.line) as { event: string; message?: { content: Array<{ text: string }> } };
      return obj.event === "user" && obj.message ? [obj.message.content.map((c) => c.text)] : [];
    });

  const addSession = (patch: Partial<AgentSessionRow> = {}): AgentSessionRow => {
    const id = nextSessionId++;
    const cwd = join(dir, "workspace", String(id));
    mkdirSync(cwd, { recursive: true });
    const row: AgentSessionRow = {
      id,
      role: "pm",
      conversationId: id,
      pmId: 1,
      workerId: null,
      vendor: "agy",
      vendorSessionId: "pre-generated-placeholder",
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...patch,
    };
    store.add(row);
    return row;
  };

  const harness: AgyTestHarness = {
    dir,
    stateDir,
    store,
    driver,
    events,
    launch,
    waitFor,
    of,
    log,
    argvs: () => log().flatMap((e) => (e.kind === "argv" && e.argv ? [e.argv] : [])),
    stdinBlocks,
    addSession,
    cleanup: async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

const user = (id: number, text: string, prefixes?: string[]) => ({
  messageIds: [id],
  source: "user" as const,
  text,
  ...(prefixes ? { prefixes } : {}),
});

describe("agy-protocol 纯函数", () => {
  it("buildAgyArgs：首次启动不传 --conversation，末尾固定带 --print ''，按设置切换权限模式", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-args-"));
    try {
      const settingsAuto = join(dir, "auto.json");
      writeFileSync(settingsAuto, JSON.stringify({ permissions: { defaultMode: "auto" } }));

      const session: AgentSessionRow = {
        id: 1,
        role: "worker",
        conversationId: 1,
        pmId: null,
        workerId: 1,
        vendor: "agy",
        vendorSessionId: "conv-123",
        cwd: dir,
        addDirs: ["/extra/dir1", "/extra/dir2"],
        generation: 1,
        model: "gemini-4-argon",
        effort: "high",
        pid: null,
        status: "idle",
        hasCompletedTurn: false,
        lastEventAt: null,
        rateLimit: null,
        usage: { ...EMPTY_TOKEN_USAGE },
        createdAt: 1,
        updatedAt: 1,
      };
      const filesAuto: LaunchFiles = { promptFile: join(dir, "p.md"), settingsFile: settingsAuto, env: {}, fingerprint: "f1" };
      const argsFirst = buildAgyArgs(session, filesAuto, false);
      expect(argsFirst).not.toContain("--conversation");
      expect(argsFirst).toContain("--mode");
      expect(argsFirst[argsFirst.indexOf("--mode") + 1]).toBe("auto");
      expect(argsFirst).toContain("--dangerously-skip-permissions");
      // 不带档位的模型 + 思考程度拼成完整 ID，不另传 --effort（agy 对两个都传且对不上会报错）
      expect(argsFirst[argsFirst.indexOf("--model") + 1]).toBe("gemini-4-argon-high");
      expect(argsFirst).not.toContain("--effort");
      expect(argsFirst.slice(-2)).toEqual(["--print", ""]);

      const filesPlan: LaunchFiles = {
        promptFile: join(dir, "p.md"),
        settingsFile: settingsAuto,
        env: {},
        fingerprint: "f2",
        readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/Users/u/.agent-hub/state" }),
      };
      const argsResumePlan = buildAgyArgs(session, filesPlan, true);
      expect(argsResumePlan[argsResumePlan.indexOf("--conversation") + 1]).toBe("conv-123");
      expect(argsResumePlan[argsResumePlan.indexOf("--mode") + 1]).toBe("plan");
      expect(argsResumePlan).not.toContain("--dangerously-skip-permissions");
      expect(argsResumePlan.slice(-2)).toEqual(["--print", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildAgyUserLine 与 checkAgyUserLine：构造 event=user 的 NDJSON 行并转义行分隔符", () => {
    const line = buildAgyUserLine("你好\u2028世界\u2029", [formatSystemInstructions("系统提示")]);
    expect(line).not.toContain("\u2028");
    expect(line).not.toContain("\u2029");
    expect(checkAgyUserLine(line)).toBeNull();
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      event: "user",
      message: {
        content: [
          { type: "text", text: "<system_instructions>\n系统提示\n</system_instructions>" },
          { type: "text", text: "你好\u2028世界\u2029" },
        ],
      },
    });
    expect(checkAgyUserLine(JSON.stringify({ event: "user", message: { content: [{ type: "text", text: "   " }] } }))).toBe("文字是空的");
    expect(checkAgyUserLine(JSON.stringify({ event: "other", message: { content: [{ type: "text", text: "hi" }] } }))).toMatch(/event/);
  });

  it("parseAgyUsage 与 detectAgyArgsConflict：正确解析 agy 用量字段（不重复累加 thinking_tokens）和会话不存在错误", () => {
    expect(
      parseAgyUsage({
        input_tokens: 120,
        output_tokens: 30,
        thinking_tokens: 15,
        cache_read_tokens: 40,
      }),
    ).toEqual({
      input: 120,
      cacheRead: 40,
      cacheWrite: 0,
      output: 30,
    });
    expect(detectAgyArgsConflict("Error: conversation abc not found")).toBe("no_conversation");
    expect(detectAgyArgsConflict("No conversation with id 123")).toBe("no_conversation");
    expect(detectAgyArgsConflict("some other error")).toBeNull();
  });

  it("checkWorkerToolViolation：不再有只读分支（不事后 SIGINT）：写工具不拦，只读的写靠 deny 规则和外层沙箱", () => {
    const base = { parameters: {}, fallbackScope: null, cwd: "/w" };
    for (const toolName of ["edit_file", "sed_file", "notebook_edit", "write_to_file", "view_file"]) {
      expect(checkWorkerToolViolation({ ...base, toolName })).toBeNull();
    }
  });

  it("checkWorkerToolViolation：包进了 OS 沙箱（fallbackScope 是 null）时数据目录不在这里拦", () => {
    for (const toolName of ["write_to_file", "replace_file_content", "sed_file", "run_command"]) {
      const parameters = { TargetFile: "/Users/u/.agent-hub/state/x", CommandLine: "touch /Users/u/.agent-hub/state/x" };
      expect(checkWorkerToolViolation({ toolName, parameters, fallbackScope: null, cwd: "/w" })).toBeNull();
    }
  });

  it("checkWorkerToolViolation：没有 OS 沙箱时兜底——写类工具的路径、命令行写到可写范围外就拦；读、写自己的工作目录、数据目录外不拦", () => {
    const cwd = "/Users/u/.agent-hub/worktrees/1/2";
    const fallbackScope = { dataDir: "/Users/u/.agent-hub", writableDirs: [cwd] };
    const check = (toolName: string, parameters: Record<string, unknown>) => checkWorkerToolViolation({ toolName, parameters, fallbackScope, cwd });
    expect(check("write_to_file", { TargetFile: "/Users/u/.agent-hub/state/x" })).toBe(WRITE_SCOPE_VIOLATION_MESSAGE);
    expect(check("edit_file", { file_path: "../3/a.ts" })).toBe(WRITE_SCOPE_VIOLATION_MESSAGE);
    expect(check("run_command", { CommandLine: "cd /Users/u && cd .agent-hub/state && touch x" })).toBe(WRITE_SCOPE_VIOLATION_MESSAGE);
    expect(check("run_command", { command: "ls /Users/u/.agent-hub; find /Users/u/.agent-hub/state -delete" })).toBe(WRITE_SCOPE_VIOLATION_MESSAGE);
    expect(check("view_file", { AbsolutePath: "/Users/u/.agent-hub/state/x" })).toBeNull();
    expect(check("write_to_file", { TargetFile: `${cwd}/a.ts` })).toBeNull();
    expect(check("write_to_file", { TargetFile: "/tmp/a.ts" })).toBeNull();
    expect(check("run_command", { CommandLine: "cat /Users/u/.agent-hub/state/x && echo ok > out.txt" })).toBeNull();
  });
});

describe("1. 首次启动与完整流式回合", () => {
  it("首次启动不带 --conversation、--print '' 在末尾，收到 init 更新 vendorSessionId，首条附带 promptFile 内容，完整走通 step_update.step_index 与 result 并统计 TurnUsage", async () => {
    const t = makeAgyHarness({
      script: {
        assignedConversationId: "agy-assigned-uuid-999",
        turns: [
          {
            steps: [
              {
                type: "text",
                stepId: 2,
                deltas: ["正在为您", "检查文件…"],
                usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 20 },
              },
              {
                type: "tool",
                stepId: 3,
                name: "read_file",
                parameters: { Path: "README.md" },
              },
              {
                type: "text",
                stepId: 4,
                deltas: ["检查完毕，", "一切正常！"],
                usage: { input_tokens: 150, output_tokens: 25, thinking_tokens: 10, cache_read_tokens: 30 },
              },
            ],
            result: {
              status: "SUCCESS",
              finishedReason: null,
              response: "检查完毕，一切正常！",
              usage: { input_tokens: 250, output_tokens: 35, thinking_tokens: 15, cache_read_tokens: 50 },
            },
          },
        ],
      },
    });

    const s = t.addSession({ model: "gemini-4-argon", effort: "high", addDirs: ["/tmp/extra-dir"] });
    await expect(t.driver.send(s.id, user(1, "请帮我检查 README"))).resolves.toEqual({ kind: "written" });
    await t.waitFor("turn.ended");

    // 1. 检查启动命令行参数
    const [argv] = t.argvs();
    expect(argv).toBeDefined();
    expect(argv).not.toContain("--conversation");
    expect(argv!.slice(-2)).toEqual(["--print", ""]);
    expect(argv![argv!.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(argv![argv!.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv![argv!.indexOf("--model") + 1]).toBe("gemini-4-argon-high");
    expect(argv).not.toContain("--effort");
    expect(argv![argv!.indexOf("--add-dir") + 1]).toBe("/tmp/extra-dir");

    // 2. 检查 init 更新了 vendorSessionId
    const updatedRow = t.store.get(s.id)!;
    expect(updatedRow.vendorSessionId).toBe("agy-assigned-uuid-999");
    expect(updatedRow.hasCompletedTurn).toBe(true);
    const started = t.of("session.started")[0]!;
    expect(started).toMatchObject({
      resumed: false,
      model: "gemini-4-argon",
      vendorSessionId: "agy-assigned-uuid-999",
    });

    // 3. 检查第一条消息最前面附带了 promptFile 内容
    const blocks = t.stdinBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]![0]).toBe("<system_instructions>\n你是 Antigravity 驱动测试里的 Agent。\n</system_instructions>");
    expect(blocks[0]![1]).toBe("请帮我检查 README");

    // 4. 检查流式事件顺序与去重 uuid
    const eventTypes = t.events.map((e) => e.event.type);
    expect(eventTypes).toEqual([
      "session.started",
      "message.delivered",
      "message.processing",
      "agent.text_delta",
      "agent.text_delta",
      "agent.text",
      "agent.tool",
      "agent.tool_result",
      "agent.text_delta",
      "agent.text_delta",
      "agent.text",
      "turn.ended",
    ]);
    expect(t.of("agent.text_delta").map((e) => e.delta)).toEqual(["正在为您", "检查文件…", "检查完毕，", "一切正常！"]);

    const texts = t.of("agent.text");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatchObject({
      uuid: "agy-step-agy-assigned-uuid-999-1-2-1",
      text: "正在为您检查文件…",
    });
    expect(texts[1]).toMatchObject({
      uuid: "agy-step-agy-assigned-uuid-999-1-4-3",
      text: "检查完毕，一切正常！",
    });

    const tools = t.of("agent.tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      uuid: "agy-tool-agy-assigned-uuid-999-1-3-2",
      toolUseId: "tool-1-3",
      name: "read_file",
      input: { Path: "README.md" },
    });

    const toolResults = t.of("agent.tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolUseIds).toEqual(["tool-1-3"]);

    const ended = t.of("turn.ended")[0]!;
    expect(ended).toMatchObject({
      ok: true,
      interrupted: false,
      messageIds: [1],
    });

    // 5. 检查 TurnUsage 统计（output_tokens 已含 thinking_tokens，不重复累加）
    expect(updatedRow.usage).toEqual({
      input: 250,
      cacheRead: 50,
      cacheWrite: 0,
      output: 35,
      context: 180, // 最后一步 step 4 的 150 + 30
    });
  });
});

describe("2. 长连接复用与会话恢复（--conversation）", () => {
  it("进程重启恢复后第二轮同样 step_index 的消息与工具不会与第一轮 UUID / toolUseId 冲突", async () => {
    const t = makeAgyHarness({
      script: {
        assignedConversationId: "agy-conv-uuid-check",
        turns: [
          {
            steps: [
              { type: "tool", stepId: 1, name: "read_file", parameters: { Path: "a.ts" } },
              { type: "text", stepId: 2, deltas: ["第一轮步骤2文本"] },
            ],
          },
          {
            steps: [
              { type: "tool", stepId: 1, name: "read_file", parameters: { Path: "b.ts" } },
              { type: "text", stepId: 2, deltas: ["重启后第二轮同样步骤2文本"] },
            ],
          },
        ],
      },
      driver: { idleCloseMs: 60 },
    });

    const s = t.addSession();
    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("turn.ended", undefined, 1);
    await t.waitFor("session.exited", undefined, 1);

    await t.driver.send(s.id, user(2, "第二轮（新进程 --conversation 恢复，step_index 重新从 1 开始）"));
    await t.waitFor("turn.ended", undefined, 2);

    const tools = t.of("agent.tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.uuid).not.toBe(tools[1]!.uuid);
    expect(tools[0]!.uuid).toBe("agy-tool-agy-conv-uuid-check-1-1-1");
    expect(tools[1]!.uuid).toBe("agy-tool-agy-conv-uuid-check-2-1-3");
    expect(tools[0]!.toolUseId).toBe("tool-1-1");
    expect(tools[1]!.toolUseId).toBe("tool-2-1");

    const texts = t.of("agent.text");
    expect(texts).toHaveLength(2);
    expect(texts[0]!.text).toBe("第一轮步骤2文本");
    expect(texts[1]!.text).toBe("重启后第二轮同样步骤2文本");
    expect(texts[0]!.uuid).not.toBe(texts[1]!.uuid);
    expect(texts[0]!.uuid).toBe("agy-step-agy-conv-uuid-check-1-2-2");
    expect(texts[1]!.uuid).toBe("agy-step-agy-conv-uuid-check-2-2-4");
  });

  it("第二轮直接复用长连接进程（不重发系统提示词）；空闲退出或设置变更重启后带 --conversation <agyAssignedId> 恢复", async () => {
    const t = makeAgyHarness({
      script: {
        assignedConversationId: "agy-conv-persist-42",
        defaultTurn: {
          steps: [{ type: "text", deltas: ["收到"] }],
        },
      },
      driver: { idleCloseMs: 80 },
    });

    const s = t.addSession();
    // 第一轮
    await t.driver.send(s.id, user(1, "第一轮消息"));
    await t.waitFor("turn.ended", undefined, 1);

    // 紧接着发第二轮（复用同一个进程）
    await t.driver.send(s.id, user(2, "第二轮消息"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.argvs()).toHaveLength(1);
    // 第二轮复用同一进程时不重复注入 <system_instructions>
    expect(t.stdinBlocks()[1]).toEqual(["第二轮消息"]);

    // 等待空闲退出
    await t.waitFor("session.exited", undefined, 1);
    expect(t.of("session.exited")[0]).toMatchObject({ reason: "idle" });

    // 第三轮：空闲退出后自动用 --conversation agy-conv-persist-42 恢复，且新进程首条重新注入系统提示词
    await t.driver.send(s.id, user(3, "第三轮消息"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.argvs()).toHaveLength(2);
    const secondArgv = t.argvs()[1]!;
    expect(secondArgv[secondArgv.indexOf("--conversation") + 1]).toBe("agy-conv-persist-42");
    expect(t.stdinBlocks()[2]![0]).toContain("<system_instructions>");
    expect(t.stdinBlocks()[2]![1]).toBe("第三轮消息");

    // 第四轮：修改 fingerprint 触发两轮之间重启，带 RELAUNCH_NOTE 且用 --conversation 恢复
    t.launch.fingerprint = "fp-updated-2";
    await t.driver.send(s.id, user(4, "第四轮消息"));
    await t.waitFor("turn.ended", undefined, 4);
    expect(t.argvs()).toHaveLength(3);
    const thirdArgv = t.argvs()[2]!;
    expect(thirdArgv[thirdArgv.indexOf("--conversation") + 1]).toBe("agy-conv-persist-42");
    expect(t.stdinBlocks()[3]).toEqual([
      "<system_instructions>\n你是 Antigravity 驱动测试里的 Agent。\n</system_instructions>",
      RELAUNCH_NOTE,
      "第四轮消息",
    ]);
  });

  it("--conversation 启动报 not found 时自动回退为不带 --conversation 重新启动一次", async () => {
    const t = makeAgyHarness({
      script: {
        assignedConversationId: "agy-fresh-after-fallback",
        rejectConversationOnce: true,
      },
    });
    const s = t.addSession({ hasCompletedTurn: true, vendorSessionId: "stale-conv-id" });
    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");

    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain("--conversation");
    expect(argvs[1]).not.toContain("--conversation");
    expect(t.store.get(s.id)?.vendorSessionId).toBe("agy-fresh-after-fallback");
  });
});

describe("3. interrupt() 打断与恢复", () => {
  it("interrupt() 发送 SIGINT，收到 finished_reason: interrupted 后发出 turn.ended(interrupted: true)，下一轮自动用 --conversation 恢复", async () => {
    let waitFile = "";
    const t = makeAgyHarness({
      script: {
        assignedConversationId: "agy-conv-interrupt-77",
        turns: [
          {
            steps: [{ type: "waitFile", path: "/nonexistent-will-be-replaced" }],
          },
          {
            steps: [{ type: "text", deltas: ["打断后恢复成功"] }],
          },
        ],
      },
    });
    waitFile = join(t.dir, "never-created-gate");
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        assignedConversationId: "agy-conv-interrupt-77",
        turns: [
          { steps: [{ type: "waitFile", path: waitFile }] },
          { steps: [{ type: "text", deltas: ["打断后恢复成功"] }] },
        ],
      }),
    );

    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑一个慢任务"));
    await t.waitFor("message.processing");

    await t.driver.interrupt(s.id);
    const ended1 = await t.waitFor("turn.ended", undefined, 1);
    expect(ended1).toMatchObject({
      ok: false,
      interrupted: true,
      messageIds: [1],
    });

    const exited1 = await t.waitFor("session.exited", undefined, 1);
    expect(exited1).toMatchObject({
      reason: "interrupt",
    });

    // 下一轮自动用 --conversation agy-conv-interrupt-77 恢复，且不带崩溃说明
    await t.driver.send(s.id, user(2, "换个方向继续"));
    const ended2 = await t.waitFor("turn.ended", undefined, 2);
    expect(ended2).toMatchObject({
      ok: true,
      interrupted: false,
      messageIds: [2],
    });
    const argvs = t.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[1]![argvs[1]!.indexOf("--conversation") + 1]).toBe("agy-conv-interrupt-77");
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["打断后恢复成功"]);
  });
});

describe("4. Worker 安全拦截（数据目录由 OS 沙箱管，只读模式在这里拦）", () => {
  it("Worker 通过 edit_file 修改 AGENTS.md 不被拦，这一轮正常结束（2026-11-06 用户去掉了这条限制）", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              {
                type: "tool",
                stepId: 2,
                name: "edit_file",
                parameters: { Path: "AGENTS.md", Replacement: "ok" },
                durationMs: 200,
              },
            ],
          },
        ],
      },
    });

    const s = t.addSession({ role: "worker", workerId: 10 });
    await t.driver.send(s.id, user(1, "去改 AGENTS.md"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(t.log().some((e) => e.kind === "signal" && e.signal === "SIGINT")).toBe(false);
  });

  it.runIf(canRunSandboxExec)("Worker 的可写范围：进程包在 OS 沙箱里，数据目录写不成，这一轮照常跑完；项目经理不包", async () => {
    for (const [role, scoped] of [["worker", true], ["pm", false]] as const) {
      const t = makeAgyHarness();
      const dataDir = join(realpathSync.native(t.dir), "home");
      const cwd = join(dataDir, "worktrees", "1", "2");
      mkdirSync(cwd, { recursive: true });
      const probe = join(dataDir, "probe.txt");
      t.launch.env = { FAKE_AGY_PROBE: probe };
      if (scoped) t.launch.writeScope = { dataDir, writableDirs: [cwd] };
      const s = t.addSession({ role, cwd, ...(role === "worker" ? { workerId: 11 } : {}) });
      await t.driver.send(s.id, user(1, "hi"));
      const ended = await t.waitFor("turn.ended");
      expect(ended.ok, role).toBe(true);
      expect(t.log().find((e) => e.kind === "probe"), role).toMatchObject(scoped ? { ok: false, errno: "EPERM" } : { ok: true });
      expect(existsSync(probe), role).toBe(!scoped);
      await t.cleanup();
      harnesses.splice(harnesses.indexOf(t), 1);
    }
  });

  const FAKE_CATALOG: AgyConnectorCatalog = {
    servers: {
      slack: { send_message: { readOnlyHint: false, destructiveHint: true }, read_channel: { readOnlyHint: true } },
      jenkins: { get_build: null },
      "claude-ai": { search: { readOnlyHint: true } },
    },
    unlistable: ["broken"],
  };
  const readonlyArgv = (t: AgyTestHarness): { argv: string[]; settings: { permissions: { allow: string[]; deny: string[] }; enableTerminalSandbox: boolean } } => {
    const [argv] = t.argvs();
    return { argv: argv!, settings: JSON.parse(argv![argv!.indexOf("--settings") + 1]!) };
  };
  const toolStep = (name: string, parameters: Record<string, unknown>) => ({ type: "tool" as const, stepId: 2, name, parameters, durationMs: 2000 });

  it("只读 Worker 启动：--mode plan、--settings 里放行读和命令、拒写文件，连接器里非只读的和问不到清单的服务器全拒；写工具调用不再被事后打断", async () => {
    const t = makeAgyHarness({ script: { turns: [{ steps: [toolStep("edit_file", { Path: "src/app.ts" })] }] } });
    t.launch.readonly = true;
    t.launch.catalog = FAKE_CATALOG;

    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "尝试改代码"));
    const ended = await t.waitFor("turn.ended");
    const { argv, settings } = readonlyArgv(t);
    expect(argv[argv.indexOf("--mode") + 1]).toBe("plan");
    expect(settings.enableTerminalSandbox).toBe(false);
    expect(settings.permissions.allow).toEqual(["read_file(*)", "command(*)", "read_url(*)", "mcp(slack/read_channel)", "mcp(claude-ai/search)"]);
    expect(settings.permissions.deny).toContain("write_file(*)");
    expect(settings.permissions.deny).toContain("mcp(slack/send_message)");
    expect(settings.permissions.deny).toContain("mcp(jenkins/get_build)");
    expect(settings.permissions.deny).toContain("mcp(broken/*)");
    expect(settings.permissions.deny).not.toContain("mcp(slack/read_channel)");
    expect(settings.permissions.deny).not.toContain("mcp(claude-ai/search)");
    expect(t.log().filter((e) => e.kind === "signal")).toEqual([]);
    expect(ended.ok).toBe(true);
  });

  it("只读 Worker 调了非只读的连接器工具（call_mcp_tool 和 mcp_<服务器>_<工具> 两种形式）：马上 SIGINT，这一轮以 policy_violation 结束", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["call_mcp_tool", { ServerName: "slack", ToolName: "send_message", Arguments: { text: "hi" } }],
      ["mcp_slack_send_message", { text: "hi" }],
      ["call_mcp_tool", { ServerName: "jenkins", ToolName: "get_build" }],
      ["call_mcp_tool", { ServerName: "newserver", ToolName: "anything" }],
    ];
    for (const [name, parameters] of cases) {
      const t = makeAgyHarness({ script: { turns: [{ steps: [toolStep(name, parameters)] }] } });
      t.launch.readonly = true;
      t.launch.catalog = FAKE_CATALOG;
      const s = t.addSession({ role: "worker", workerId: 12 });
      await t.driver.send(s.id, user(1, "发条消息"));
      const ended = await t.waitFor("turn.ended");
      expect(ended.ok, name).toBe(false);
      expect(ended.error?.subtype, name).toBe("policy_violation");
      expect(ended.error?.message, name).toContain("只读的连接器工具");
      expect(t.log().filter((e) => e.kind === "signal").length, name).toBeGreaterThan(0);
      await t.cleanup();
      harnesses.splice(harnesses.indexOf(t), 1);
    }
  });

  it("只读 Worker 调只读的连接器工具、内置读工具：不拦", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              { ...toolStep("call_mcp_tool", { ServerName: "slack", ToolName: "read_channel" }), stepId: 2 },
              { ...toolStep("mcp_claude_ai_search", { q: "x" }), stepId: 3 },
              { ...toolStep("view_file", { AbsolutePath: "/etc/hosts" }), stepId: 4 },
              { type: "text", deltas: ["好了"] },
            ],
          },
        ],
      },
    });
    t.launch.readonly = true;
    t.launch.catalog = FAKE_CATALOG;
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "查一下"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(t.log().filter((e) => e.kind === "signal")).toEqual([]);
  });

  it("非只读的 Worker 调任何连接器都不拦（只读才拦）", async () => {
    const t = makeAgyHarness({ script: { turns: [{ steps: [toolStep("call_mcp_tool", { ServerName: "slack", ToolName: "send_message" }), { type: "text", deltas: ["发了"] }] }] } });
    t.launch.catalog = FAKE_CATALOG;
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "发条消息"));
    expect((await t.waitFor("turn.ended")).ok).toBe(true);
    expect(t.argvs()[0]).not.toContain("--settings");
  });

  it("只读 Worker：TMPDIR 指到会话私有临时目录（进程退出后删掉），进程交给外层只读沙箱", async () => {
    const wrapped: string[][] = [];
    const t = makeAgyHarness({
      script: { turns: [{ steps: [{ type: "text", deltas: ["好"] }] }] },
      driver: {
        readonlySpawn: (base, input) => {
          wrapped.push([base.command, input.tmpDir, ...input.secretPaths.slice(0, 1)]);
          return { ...base, osSandboxed: true };
        },
      },
    });
    t.launch.readonly = true;
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    expect(wrapped).toHaveLength(1);
    const tmp = wrapped[0]![1]!;
    expect(tmp).toContain("agent-hub-ro-");
    expect(existsSync(tmp)).toBe(true);
    await t.driver.end(s.id);
    expect(existsSync(tmp)).toBe(false);
  });

  it("没有 OS 沙箱的机器上起只读 agy：直接报错说清原因，不起进程", async () => {
    const t = makeAgyHarness({ driver: { readonlySpawn: (base) => ({ ...base, osSandboxed: false }) } });
    t.launch.readonly = true;
    const s = t.addSession({ role: "worker", workerId: 12 });
    await expect(t.driver.send(s.id, user(1, "hi"))).rejects.toThrow(/需要 OS 沙箱/);
    expect(t.argvs()).toEqual([]);
  });

  it("只读 agy 问连接器清单要起 stdio 服务器：走同一个 readonlySpawn 包沙箱、env 去掉 HUB_*；没有 OS 沙箱时不起服务器", async () => {
    const marker = join(tmpdir(), `agy-probe-marker-${process.pid}-${Date.now()}`);
    const wrapped: SpawnCommand[] = [];
    const setup = (osSandboxed: boolean) => {
      const t = makeAgyHarness({
        driver: {
          connectorCatalog: undefined, // 走真的探测
          readonlySpawn: (base) => {
            wrapped.push(base);
            return { ...base, osSandboxed };
          },
        },
      });
      const cfgDir = join(t.dir, ".gemini", "config");
      mkdirSync(cfgDir, { recursive: true });
      const server = join(t.dir, "server.mjs");
      writeFileSync(server, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ hub: process.env.HUB_TOKEN ?? null }));`);
      writeFileSync(join(cfgDir, "mcp_config.json"), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [server] } } }));
      t.launch.readonly = true;
      t.launch.env = { HUB_TOKEN: "worker-token" };
      return t;
    };
    // 没有 OS 沙箱：不起探测进程，起 agy 也报错
    const none = setup(false);
    const s1 = none.addSession({ role: "worker", workerId: 12 });
    await expect(none.driver.send(s1.id, user(1, "hi"))).rejects.toThrow(/需要 OS 沙箱/);
    expect(existsSync(marker)).toBe(false);
    // 有 OS 沙箱（这里的假沙箱原样跑）：探测进程经过 readonlySpawn，环境里没有 HUB_TOKEN
    wrapped.length = 0;
    const ok = setup(true);
    const s2 = ok.addSession({ role: "worker", workerId: 13 });
    await ok.driver.send(s2.id, user(1, "hi"));
    await ok.waitFor("turn.ended");
    expect(wrapped.some((b) => b.command === process.execPath)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ hub: null });
    rmSync(marker, { force: true });
  });

  it("只读 agy 启动前扫一次 [cwd, ...addDirs] 下的 secretGlobs 并入 secretPaths，连接器探测与 agy 外层沙箱及 --settings 共用同一份结果", async () => {
    const seenSecrets: string[][] = [];
    const t = makeAgyHarness({
      driver: {
        connectorCatalog: undefined,
        readonlySpawn: (base, input) => {
          seenSecrets.push(input.secretPaths);
          return { ...base, osSandboxed: true };
        },
      },
    });
    const cfgDir = join(t.dir, ".gemini", "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: ["-e", "process.exit(0)"] } } }),
    );
    const extraDir = join(realpathSync.native(t.dir), "extra-dir");
    mkdirSync(extraDir, { recursive: true });
    const envInCwd = join(realpathSync.native(t.dir), "work", ".env");
    const envInAddDir = join(extraDir, ".env.production");
    mkdirSync(join(realpathSync.native(t.dir), "work"), { recursive: true });
    writeFileSync(envInCwd, "A=1");
    writeFileSync(envInAddDir, "B=2");

    t.launch.readonly = true;
    const s = t.addSession({ role: "worker", workerId: 14, cwd: join(realpathSync.native(t.dir), "work"), addDirs: [extraDir] });
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    // 第一次是连接器探测，第二次是 agy 本身：两次拿到的 secretPaths 都包含扫出来的 .env 与 .env.production
    expect(seenSecrets.length).toBe(2);
    for (const secrets of seenSecrets) {
      expect(secrets).toContain(envInCwd);
      expect(secrets).toContain(envInAddDir);
    }
    const { settings } = readonlyArgv(t);
    expect(settings.permissions.deny).toContain(`read_file(${envInCwd})`);
    expect(settings.permissions.deny).toContain(`read_file(${envInAddDir})`);
  });

  it("被拒后自动补一轮：result 有 denied_actions 且回复为空 → 往同一个进程补一条“被拒了，换办法”，这一轮到补的那一轮出回复才结束；最多补 AGY_DENIED_CONTINUE_MAX 次", async () => {
    const denied = [{ tool_name: "write_file" }];
    const t = makeAgyHarness({
      script: {
        turns: [
          { steps: [], result: { response: "", deniedActions: denied } },
          { steps: [], result: { response: "", deniedActions: denied } },
          { steps: [{ type: "text", deltas: ["换成只读的办法做完了"] }] },
        ],
      },
    });
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "改个文件"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(ended.messageIds).toEqual([1]);
    expect(t.of("turn.ended")).toHaveLength(1);
    const stdins = t.log().filter((e) => e.kind === "stdin");
    expect(stdins).toHaveLength(3);
    expect(stdins[1]!.line).toContain("write_file");
    expect(stdins[1]!.line).toContain("被权限拒绝");
    expect(t.of("agent.text").map((e) => e.text)).toContain("换成只读的办法做完了");
  });

  it("被拒后自动补一轮（S4 实测的真实形状）：mcp 权限被自动拒、回复为空、status=SUCCESS → 补一轮，点名 CallMcpTool", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          { steps: [toolStep("call_mcp_tool", { ServerName: "rotest", ToolName: "ro_lookup" })], result: { response: "", deniedActions: [{ action: "mcp", display_name: "CallMcpTool" }] } },
          { steps: [{ type: "text", deltas: ["换办法做完了"] }] },
        ],
      },
    });
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "查一下"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(t.of("turn.ended")).toHaveLength(1);
    const stdins = t.log().filter((e) => e.kind === "stdin");
    expect(stdins).toHaveLength(2);
    expect(stdins[1]!.line).toContain("CallMcpTool");
    expect(t.of("agent.text").map((e) => e.text)).toContain("换办法做完了");
  });

  it("被拒后补一轮到上限就停：照常以空回复结束这一轮，不死循环", async () => {
    const t = makeAgyHarness({ script: { defaultTurn: { steps: [], result: { response: "", deniedActions: ["command"] } } } });
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "做点事"));
    await t.waitFor("turn.ended");
    // 1 条原消息 + AGY_DENIED_CONTINUE_MAX 条补发
    expect(t.log().filter((e) => e.kind === "stdin")).toHaveLength(1 + AGY_DENIED_CONTINUE_MAX);
    expect(t.of("turn.ended")).toHaveLength(1);
  });

  it("没有 denied_actions、或回复不为空：不补", async () => {
    const t = makeAgyHarness({ script: { turns: [{ steps: [], result: { response: "有回复", deniedActions: ["x"] } }, { steps: [], result: { response: "" } }] } });
    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "a"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "b"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.log().filter((e) => e.kind === "stdin")).toHaveLength(2);
  });
});

describe("5. queryCommands、isRunning、end、shutdown 与 cleanupStale", () => {
  it("queryCommands 返回 null（交由 commands-catalog 走 vendor.queryCommands 查 skills），isRunning、end、shutdown 正常运作", async () => {
    const t = makeAgyHarness();
    const s = t.addSession();

    expect(t.driver.isRunning(s.id)).toBe(false);
    await expect(t.driver.queryCommands(s.id)).resolves.toBeNull();

    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");
    expect(t.driver.isRunning(s.id)).toBe(true);
    await expect(t.driver.queryCommands(s.id)).resolves.toBeNull();

    await t.driver.end(s.id);
    expect(t.driver.isRunning(s.id)).toBe(false);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });

    await expect(t.driver.send(s.id, user(2, "再发一条"))).rejects.toThrow(DriverError);
    await expect(t.driver.send(s.id, user(2, "再发一条"))).rejects.toMatchObject({ code: "session_ended" });
  });

  it.runIf(canRunPs)("cleanupStale：清理 vendor === 'agy' 的残留进程并将 pid 清零、status 置 idle", async () => {
    const t = makeAgyHarness();
    // 启动一个带 "agy" 与 "--input-format stream-json" 参数的残留子进程
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 10000)", "agy", "--input-format", "stream-json", "--conversation", "stale-agy-conv"],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    const stalePid = child.pid!;

    const s = t.addSession({
      vendor: "agy",
      vendorSessionId: "stale-agy-conv",
      pid: stalePid,
      status: "running",
    });

    try {
      await t.driver.cleanupStale();
      await realSleep(50);

      expect(t.store.get(s.id)).toMatchObject({ pid: null, status: "idle" });
      let alive = true;
      try {
        process.kill(stalePid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      try {
        process.kill(-stalePid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  });

  it("result.response 兜底补发与忙时队列合并、恢复/重发说明顺序", async () => {
    const t = makeAgyHarness();
    const gateFile = join(t.dir, "turn1-gate");
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        assignedConversationId: "agy-conv-batch-88",
        turns: [
          {
            // 第一轮：没有 agent_response step_update，仅靠 result.response 返回文字
            steps: [{ type: "waitFile", path: gateFile }],
            result: { status: "SUCCESS", response: "仅在 result 里的兜底回复" },
          },
          {
            steps: [{ type: "text", deltas: ["合并回复"] }],
          },
        ],
      }),
    );

    const s = t.addSession();
    await expect(
      t.driver.send(s.id, { messageIds: [1], source: "user", text: "首条恢复重发", recovery: true, resend: true }),
    ).resolves.toEqual({ kind: "written" });
    await expect(t.driver.send(s.id, user(2, "忙时补充一"))).resolves.toEqual({ kind: "queued" });
    await expect(t.driver.send(s.id, user(3, "忙时补充二"))).resolves.toEqual({ kind: "queued" });

    writeFileSync(gateFile, "go");
    await t.waitFor("turn.ended", undefined, 2);

    // 校验 result.response 兜底补发了 agent.text
    const texts = t.of("agent.text").map((e) => e.text);
    expect(texts).toEqual(["仅在 result 里的兜底回复", "合并回复"]);

    // 校验第一轮前缀顺序：系统提示词 → RESTART_RECOVERY_NOTE → RESEND_NOTE → 原文
    const blocks = t.stdinBlocks();
    expect(blocks[0]).toEqual([
      "<system_instructions>\n你是 Antigravity 驱动测试里的 Agent。\n</system_instructions>",
      RESTART_RECOVERY_NOTE,
      RESEND_NOTE,
      "首条恢复重发",
    ]);
    // 校验第二轮忙时用户消息合并
    expect(blocks[1]).toEqual(["【用户连发了 2 条】", "1. 忙时补充一", "2. 忙时补充二"]);
  });
});


describe("不写原始日志", () => {
  it("跑完一轮：数据目录和临时目录里没有 .jsonl，也没有 logs/sessions/（原文在厂商自己的目录里）", async () => {
    const t = makeAgyHarness({ script: { turns: [{ steps: [{ type: "text", stepId: 2, deltas: ["hi"] }], result: { status: "SUCCESS", finishedReason: null, response: "hi", usage: {} } }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const files = readdirSync(t.dir, { recursive: true }).map(String);
    expect(files.filter((f) => f.endsWith(".jsonl") || f.includes(join("logs", "sessions")))).toEqual([]);
  });
});

describe("6. 一轮中途的消息（agy 不支持，照旧排队；停止时还没取走的标已取消）", () => {
  it("不支持中途送达：忙时 send 返回 queued，这一轮结束再写", async () => {
    const t = makeAgyHarness();
    const gate = join(t.dir, "go");
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ turns: [{ steps: [{ type: "waitFile", path: gate }, { type: "text", deltas: ["一"] }] }, { steps: [{ type: "text", deltas: ["二"] }] }] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("message.processing");
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    writeFileSync(gate, "");
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(t.of("message.delivered").some((e) => e.midTurn)).toBe(false);
  });

  it("停止时：自己队列里排着的用户消息标已取消、不再发；系统消息停止后照常发", async () => {
    const t = makeAgyHarness();
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ turns: [{ steps: [{ type: "waitFile", path: join(t.dir, "never") }] }, { steps: [{ type: "text", deltas: ["收到汇报"] }] }] }));
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑"));
    await t.waitFor("message.processing");
    await expect(t.driver.send(s.id, user(2, "排着的"))).resolves.toEqual({ kind: "queued" });
    await expect(t.driver.send(s.id, { messageIds: [3], source: "system", text: "【Worker #1 的汇报】做完了" })).resolves.toEqual({ kind: "queued" });
    await t.driver.interrupt(s.id);
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    expect(await t.waitFor("turn.ended", undefined, 2)).toMatchObject({ messageIds: [3], ok: true });
  });

  for (const silentSigint of [false, true]) {
    it(`写进去了、agy 还没取走（没出 user_input）就点了停止：标已取消，不算这一轮被打断（${silentSigint ? "SIGINT 后直接退出" : "SIGINT 后先出 result"}）`, async () => {
      const t = makeAgyHarness();
      writeFileSync(join(t.dir, "script.json"), JSON.stringify({ silentSigint, turns: [{ holdUserInput: join(t.dir, "never") }] }));
      const s = t.addSession();
      await t.driver.send(s.id, user(1, "跑一个慢任务"));
      await t.waitFor("message.delivered");
      await t.driver.interrupt(s.id);
      await t.waitFor("session.exited");
      expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [1], reason: "stop" })]);
      expect(t.of("message.processing")).toEqual([]);
      expect(t.of("turn.ended").flatMap((e) => e.messageIds)).toEqual([]);
      expect(t.of("session.exited").flatMap((e) => e.messageIds)).toEqual([]);
    });
  }
});

describe("AgyDriver 性格设定、模式改了不重启（下一条前面加说明）", () => {
  let f: PersonaFixture | undefined;
  afterEach(() => {
    f?.cleanup();
    f = undefined;
  });
  const SYS = (prompt: string) => `<system_instructions>\n${prompt}\n</system_instructions>`;
  function personaHarness(script: FakeAgyScript = {}, driver: Partial<AgyDriverOptions> = {}): AgyTestHarness {
    f = makePersonaFixture();
    const t = makeAgyHarness({ script, driver: { personaNote: f.personaNote, ...driver } });
    t.launch.personaRevision = f.revision;
    t.launch.prompt = "旧提示词";
    return t;
  }
  async function turn(t: AgyTestHarness, sessionId: SessionId, id: number, text: string, n: number): Promise<void> {
    await t.driver.send(sessionId, user(id, text));
    await t.waitFor("turn.ended", undefined, n);
  }

  it("用户在资料页改：不重启，下一条前面带完整的新内容，只带一次", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "以后回复都用列表。" });
    await turn(t, s.id, 2, "二", 2);
    await turn(t, s.id, 3, "三", 3);
    expect(t.argvs()).toHaveLength(1);
    const blocks = t.stdinBlocks();
    expect(blocks[0]).toEqual([SYS("旧提示词"), "一"]);
    expect(blocks[1]).toHaveLength(2);
    expect(blocks[1]![0]).toMatch(/^【系统】你的性格设定刚更新了，以下面这份为准：/);
    expect(blocks[1]![0]).toContain("以后回复都用列表。");
    expect(blocks[1]![1]).toBe("二");
    expect(blocks[2]).toEqual(["三"]);
  });

  it("连改两次：只带最新的一份", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "第一版" });
    f!.userEdit({ text: "第二版" });
    await turn(t, s.id, 2, "二", 2);
    expect(t.stdinBlocks()[1]![0]).toContain("第二版");
    expect(t.stdinBlocks()[1]![0]).not.toContain("第一版");
  });

  it("改模型还是重启（--conversation）；新进程首条带最新的系统指令，同时改的性格设定不再带说明", async () => {
    const t = personaHarness({ assignedConversationId: "agy-conv-p" });
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "新习惯" });
    t.launch.prompt = "新提示词";
    t.store.rows.set(s.id, { ...t.store.get(s.id)!, model: "gemini-3-pro" });
    await turn(t, s.id, 2, "二", 2);
    expect(t.argvs()).toHaveLength(2);
    expect(t.argvs()[1]).toContain("--conversation");
    expect(t.stdinBlocks()[1]).toEqual([SYS("新提示词"), RELAUNCH_NOTE, "二"]);
  });

  it("闲置关闭后再起来：新进程首条带最新的系统指令，不带说明", async () => {
    const t = personaHarness({ assignedConversationId: "agy-conv-p" }, { idleCloseMs: 50 });
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    await t.waitFor("session.exited");
    f!.userEdit({ text: "新习惯" });
    t.launch.prompt = "新提示词";
    await turn(t, s.id, 2, "二", 2);
    expect(t.argvs()).toHaveLength(2);
    expect(t.stdinBlocks()[1]).toEqual([SYS("新提示词"), "二"]);
  });

  it("撤销：带撤销后的内容，不重启", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "新习惯" });
    await turn(t, s.id, 2, "二", 2);
    f!.revert();
    await turn(t, s.id, 3, "三", 3);
    expect(t.stdinBlocks()[2]![0]).toMatch(/^【系统】你的性格设定刚更新了/);
    expect(t.stdinBlocks()[2]![0]).toContain("小林的习惯");
    expect(t.argvs()).toHaveLength(1);
  });

  it("项目经理自己 hub persona edit 改的：只带一句已生效", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.selfEdit("我自己记的");
    await turn(t, s.id, 2, "二", 2);
    expect(t.stdinBlocks()[1]).toEqual(["【系统】你刚改的性格设定已生效。", "二"]);
  });

  it("忙着时排队的（agy 不能中途写）：写进去时比，带上", async () => {
    const waitFile = join(tmpdir(), `agy-persona-go-${process.pid}-${Date.now()}`);
    const t = personaHarness({ turns: [{ steps: [{ type: "waitFile", path: waitFile }, { type: "text", deltas: ["一"] }] }] });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await expect(t.driver.send(s.id, user(2, "二"))).resolves.toEqual({ kind: "queued" });
    f!.userEdit({ text: "新习惯" });
    writeFileSync(waitFile, "");
    await t.waitFor("turn.ended", undefined, 2);
    rmSync(waitFile, { force: true });
    expect(t.stdinBlocks()[1]![0]).toContain("新习惯");
    expect(t.stdinBlocks()[1]![1]).toBe("二");
    expect(t.argvs()).toHaveLength(1);
  });
});

describe("AgyDriver 换代后的开场说明（session-preamble.ts）", () => {
  const SYS = (prompt: string) => `<system_instructions>\n${prompt}\n</system_instructions>`;

  it("第一条写进去的前面带一次（在系统指令后面），之后不带；带着它的那一行处理中带 preamble 标记", async () => {
    const ledger = fakePreambleLedger();
    const t = makeAgyHarness({ driver: { sessionPreamble: ledger.sessionPreamble } });
    t.launch.prompt = "提示词";
    ledger.watch(t.driver);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "接着说"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, { messageIds: [2], source: "system", text: "汇报" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()).toEqual([[SYS("提示词"), PREAMBLE, "接着说"], ["汇报"]]);
    expect(t.of("message.processing").map((e) => e.preamble ?? false)).toEqual([true, false]);
  });
});

describe("找不到 agy 程序", () => {
  it("send 抛可重试的 DriverError(agy_not_found)，不是 claude_not_found", async () => {
    const t = makeAgyHarness({ driver: { executablePath: "/nonexistent/agy" } });
    const s = t.addSession();
    const err = await t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("agy_not_found");
    expect((err as DriverError).retryable).toBe(true);
  });
});

describe("7. 后台任务跟踪与 background.changed 事件", () => {
  const IDLE = 150;
  const HOLD = 1200;

  it("收到 background_tasks_changed 时发射 background.changed 事件，非数组 tasks 忽略", async () => {
    const t = makeAgyHarness({
      driver: { idleCloseMs: IDLE, backgroundHoldMaxMs: HOLD },
      script: {
        turns: [
          {
            steps: [{ type: "text", deltas: ["开始"] }],
            backgroundTasksAfter: [
              { afterMs: 20, tasks: ["a"] },
              { afterMs: 50, tasks: "malformed" },
              { afterMs: 80, tasks: ["a", "b"] },
              { afterMs: 120, tasks: [] },
            ],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await t.waitFor("background.changed", (e) => e.count === 0, 1);
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1, 2, 0]);
  });

  it("存在后台任务时不触发 idleCloseMs 空闲关闭，清零后才开始算空闲并关闭", async () => {
    const CLEAR = 350;
    const t = makeAgyHarness({
      driver: { idleCloseMs: IDLE, backgroundHoldMaxMs: HOLD },
      script: {
        turns: [
          {
            steps: [
              { type: "backgroundTasks", tasks: [{ task_id: "bg1", description: "sleep 30" }] },
              { type: "text", deltas: ["已放后台"] },
            ],
            backgroundTasksAfter: [{ afterMs: CLEAR, tasks: [] }],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑后台任务"));
    const ended = await t.waitFor("turn.ended");
    await realSleep(IDLE * 2);
    expect(t.of("session.exited")).toEqual([]);
    expect(t.driver.isRunning(s.id)).toBe(true);

    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "idle", exitCode: 0 });
    expect(exited.at - ended.at).toBeGreaterThanOrEqual(CLEAR + IDLE - 60);
    expect(exited.at - ended.at).toBeLessThan(HOLD);
  });

  it("工具步骤跨轮未完成（ACTIVE 未 DONE）或显式后台命令：自动跟踪并发射 background.changed，DONE 后清零", async () => {
    const t = makeAgyHarness({
      driver: { idleCloseMs: IDLE, backgroundHoldMaxMs: HOLD },
      script: {
        turns: [
          {
            steps: [
              {
                type: "tool",
                stepId: 7,
                name: "run_command",
                parameters: { CommandLine: "pnpm test", IsDaemon: true },
                doneAfterResultMs: 250,
              },
              { type: "text", deltas: ["已在后台启动"] },
            ],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "启动后台命令"));
    await t.waitFor("turn.ended");
    expect(t.of("background.changed").map((e) => e.count)).toContain(1);
    await t.waitFor("background.changed", (e) => e.count === 0, 1);
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1, 0]);
  });

  it("空闲但只剩后台任务时调 interrupt()：关闭进程并在下一轮消息前注入 stopped 说明；设置变更重启时注入 relaunch 说明", async () => {
    const t = makeAgyHarness({
      driver: { idleCloseMs: 60_000, backgroundHoldMaxMs: 60_000 },
      script: {
        turns: [
          {
            steps: [
              { type: "backgroundTasks", tasks: [{ task_id: "ci", description: "等 CI" }] },
              { type: "text", deltas: ["一"] },
            ],
          },
          {
            steps: [
              { type: "backgroundTasks", tasks: [{ task_id: "build", description: "跑构建" }] },
              { type: "text", deltas: ["二"] },
            ],
          },
          {
            steps: [{ type: "text", deltas: ["三"] }],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "一"));
    await t.waitFor("turn.ended");
    await t.driver.interrupt(s.id);
    const exited = await t.waitFor("session.exited");
    expect(exited).toMatchObject({ reason: "interrupt", messageIds: [] });

    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.stdinBlocks()[1]).toContain(backgroundTasksKilledNote("stopped", ["等 CI"]));

    t.launch.fingerprint = "fp-v2";
    await t.driver.send(s.id, user(3, "三"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinBlocks()[2]).toContain(RELAUNCH_NOTE);
    expect(t.stdinBlocks()[2]).toContain(backgroundTasksKilledNote("relaunch", ["跑构建"]));
  });

  it("长会话历史残留网络报错：本轮已正常输出 agent_response 文本但 result 带 status=ERROR（如 GOAWAY）时，turn.ended 仍判为 ok=true 且不清空 written", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [{ type: "text", stepId: 1, deltas: ["工具已跑完，这是最终回复"] }],
            result: {
              status: "ERROR",
              error: "http2: server sent GOAWAY and closed the connection; LastStreamID=51",
              response: "",
            },
          },
        ],
      },
    });
    const s = t.addSession();
    await expect(t.driver.send(s.id, user(1, "帮我查一下"))).resolves.toEqual({ kind: "written" });
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: true, interrupted: false, messageIds: [1] });
    expect(ended.error).toBeUndefined();
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["工具已跑完，这是最终回复"]);
    // written 集合未被 forgetWritten 清掉：重复 send 同一 messageId 直接幂等返回 written，不会再次写入子进程
    await expect(t.driver.send(s.id, user(1, "帮我查一下"))).resolves.toEqual({ kind: "written" });
    expect(t.stdinBlocks()).toHaveLength(1);
  });

  it("P1 真失败：无文本 + status=ERROR → ok=false", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [{ steps: [], result: { status: "ERROR", finishedReason: "error", error: "boom", response: "" } }],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({ ok: false, error: { subtype: "error", message: "boom" } });
  });

  it("P2 真失败：文本→工具→finished_reason=error → 应 ok=false", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              { type: "text", deltas: ["我先查一下"] },
              { type: "tool", name: "run_command", parameters: { CommandLine: "ls" } },
            ],
            result: { status: "ERROR", finishedReason: "error", error: "http2: GOAWAY" },
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    expect((await t.waitFor("turn.ended")).ok).toBe(false);
  });

  it("P3 真失败：文本后（没调工具）就 finished_reason=error → 应 ok=false", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [{ type: "text", deltas: ["我先看看代码，"] }],
            result: { status: "ERROR", finishedReason: "error", error: "http2: GOAWAY", response: "" },
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    expect((await t.waitFor("turn.ended")).ok).toBe(false);
  });

  it("P4 真失败：文本→工具→status=ERROR、finishedReason=null、response 为空 → 应 ok=false", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              { type: "text", deltas: ["我先查一下"] },
              { type: "tool", name: "run_command", parameters: { CommandLine: "ls" } },
            ],
            result: { status: "ERROR", error: "boom", response: "" },
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    expect((await t.waitFor("turn.ended")).ok).toBe(false);
  });

  it("P5 agy 报的后台任务与 activeToolSteps 并集跟踪：下一轮普通工具或额外后台工具 DONE 后不覆盖已上报任务", async () => {
    const t = makeAgyHarness({
      driver: { idleCloseMs: IDLE, backgroundHoldMaxMs: HOLD },
      script: {
        turns: [
          {
            steps: [
              { type: "backgroundTasks", tasks: [{ task_id: "bg1", description: "sleep 30" }] },
              { type: "text", deltas: ["已放后台"] },
            ],
          },
          {
            steps: [
              {
                type: "tool",
                stepId: 9,
                name: "run_command",
                parameters: { CommandLine: "pnpm dev", IsDaemon: true },
              },
              { type: "text", deltas: ["额外后台工具完成"] },
            ],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "y"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1, 2, 1]);
  });

  it("P5b agy 报的后台任务不被下一轮普通工具 DONE 清零，仍按 backgroundHoldMaxMs 保活并在到点关闭后带 hold_max 说明", async () => {
    const t = makeAgyHarness({
      driver: { idleCloseMs: 150, backgroundHoldMaxMs: 3000 },
      script: {
        turns: [
          {
            steps: [
              { type: "backgroundTasks", tasks: [{ task_id: "bg1", description: "sleep 30" }] },
              { type: "text", deltas: ["已放后台"] },
            ],
          },
          {
            steps: [
              { type: "tool", name: "view_file", parameters: { path: "a" } },
              { type: "text", deltas: ["看完了"] },
            ],
          },
          {
            steps: [{ type: "text", deltas: ["好"] }],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "x"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "y"));
    const ended2 = await t.waitFor("turn.ended", undefined, 2);
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1]);
    const exited = await t.waitFor("session.exited");
    expect(exited.at - ended2.at).toBeGreaterThan(2500);
    await t.driver.send(s.id, user(3, "z"));
    await t.waitFor("turn.ended", undefined, 3);
    expect(t.stdinBlocks().at(-1)).toContain(backgroundTasksKilledNote("hold_max", ["sleep 30"]));
  });
});

describe("8. 工具终态闭合与共享步骤状态（#308）", () => {
  /** 按 messages.ts applyEvent 同款规则把驱动事件喂给 LiveSession，记录每一步之后的 step 与 openTools。 */
  function replayLiveSteps(events: DriverEvent[]) {
    const live: LiveSession = {
      activity: "idle",
      currentTool: null,
      apiRetry: null,
      step: null,
      openTools: [],
    };
    const trace: Array<{ eventType: DriverEvent["type"]; label: string; openToolIds: string[] }> = [];
    for (const ev of events) {
      if (ev.type === "message.processing" || ev.type === "turn.started" || ev.type === "agent.thinking") {
        working(null)(live);
      } else if (ev.type === "agent.tool") {
        toolStarted(ev.name, ev.toolUseId, stepOfTool(ev.name, ev.input))(live);
      } else if (ev.type === "agent.tool_result") {
        toolFinished(eventToolIds(ev))(live);
      } else if (ev.type === "agent.text") {
        working(null, { type: "text" })(live);
      } else {
        continue;
      }
      trace.push({
        eventType: ev.type,
        label: describeStep(live.step),
        openToolIds: (live.openTools ?? []).map((t) => t.toolUseId),
      });
    }
    return { live, trace };
  }

  function eventToolIds(ev: Extract<DriverEvent, { type: "agent.tool_result" }>): string[] {
    return ev.toolUseIds;
  }

  it("失败工具 A → 成功工具 B → B 结束回到 Thinking（不回显残留的 Reading SKILL.md）", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              {
                type: "tool",
                stepId: 3,
                name: "read_file",
                parameters: { Path: "frontend-rules/SKILL.md" },
                endState: "ERROR",
              },
              {
                type: "tool",
                stepId: 4,
                name: "run_command",
                parameters: { CommandLine: "pnpm test" },
                endState: "DONE",
              },
              { type: "text", stepId: 5, deltas: ["排查完毕"] },
            ],
          },
        ],
      },
    });

    const s = t.addSession({ role: "worker", workerId: 308 });
    await t.driver.send(s.id, user(1, "开始排查"));
    await t.waitFor("turn.ended");

    expect(t.of("agent.tool_result").map((e) => e.toolUseIds)).toEqual([["tool-1-3"], ["tool-1-4"]]);

    const { trace } = replayLiveSteps(t.events.map((e) => e.event));
    expect(trace).toEqual([
      { eventType: "message.processing", label: "Thinking", openToolIds: [] },
      { eventType: "agent.tool", label: "Reading SKILL.md", openToolIds: ["tool-1-3"] },
      { eventType: "agent.tool_result", label: "Thinking", openToolIds: [] },
      { eventType: "agent.tool", label: "Running command", openToolIds: ["tool-1-4"] },
      { eventType: "agent.tool_result", label: "Thinking", openToolIds: [] },
      { eventType: "agent.text", label: "Writing", openToolIds: [] },
    ]);
  });

  it("各失败/取消终态（ERROR / FAILED / CANCELLED / CANCELED）与正常 DONE 均发送 agent.tool_result 并清理后台任务", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              { type: "tool", stepId: 2, name: "read_file", parameters: { Path: "a.ts" }, endState: "ERROR" },
              { type: "tool", stepId: 3, name: "read_file", parameters: { Path: "b.ts" }, endState: "FAILED" },
              { type: "tool", stepId: 4, name: "read_file", parameters: { Path: "c.ts" }, endState: "CANCELLED" },
              {
                type: "tool",
                stepId: 5,
                name: "run_command",
                parameters: { CommandLine: "pnpm dev", IsDaemon: true },
                endState: "CANCELED",
              },
              { type: "tool", stepId: 6, name: "read_file", parameters: { Path: "d.ts" }, endState: "DONE" },
              { type: "text", stepId: 7, deltas: ["全部闭合"] },
            ],
          },
        ],
      },
    });

    const s = t.addSession({ role: "worker", workerId: 308 });
    await t.driver.send(s.id, user(1, "测试所有终态"));
    await t.waitFor("turn.ended");

    expect(t.of("agent.tool_result").map((e) => e.toolUseIds)).toEqual([
      ["tool-1-2"],
      ["tool-1-3"],
      ["tool-1-4"],
      ["tool-1-5"],
      ["tool-1-6"],
    ]);
    // step 5 显式后台命令在 CANCELED 时也已从 activeToolSteps 移除并同步清零
    expect(t.of("background.changed").map((e) => e.count)).toEqual([1, 0]);
    const { live } = replayLiveSteps(t.events.map((e) => e.event));
    expect(live.openTools).toEqual([]);
  });

  it("并行工具乱序完成与重复终态事件：按完成顺序闭合且同一 step_index 重复终态只发一次 agent.tool_result", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              // 并行启动工具 A(step 2) 和工具 B(step 3)
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "ACTIVE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-a.ts" } },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 3,
                  step_type: "tool",
                  state: "ACTIVE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-b.ts" } },
                },
              },
              // B 先完成（DONE），此时 A 仍在跑，step 应回退到 A
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 3,
                  step_type: "tool",
                  state: "DONE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-b.ts" } },
                },
              },
              // B 重复发一次 DONE：应幂等忽略
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 3,
                  step_type: "tool",
                  state: "DONE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-b.ts" } },
                },
              },
              // A 后失败（ERROR），且紧接着又收到重复 ERROR 与 DONE：只发一次 tool-1-2 的 tool_result，回到 Thinking
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "ERROR",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-a.ts" } },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "ERROR",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-a.ts" } },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "DONE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "parallel-a.ts" } },
                },
              },
              { type: "text", stepId: 4, deltas: ["并行工具已全部结束"] },
            ],
          },
        ],
      },
    });

    const s = t.addSession({ role: "worker", workerId: 308 });
    await t.driver.send(s.id, user(1, "并行乱序与重复终态"));
    await t.waitFor("turn.ended");

    expect(t.of("agent.tool").map((e) => e.toolUseId)).toEqual(["tool-1-2", "tool-1-3"]);
    expect(t.of("agent.tool_result").map((e) => e.toolUseIds)).toEqual([["tool-1-3"], ["tool-1-2"]]);

    const { trace } = replayLiveSteps(t.events.map((e) => e.event));
    expect(trace).toEqual([
      { eventType: "message.processing", label: "Thinking", openToolIds: [] },
      { eventType: "agent.tool", label: "Reading parallel-a.ts", openToolIds: ["tool-1-2"] },
      { eventType: "agent.tool", label: "Reading parallel-b.ts", openToolIds: ["tool-1-2", "tool-1-3"] },
      { eventType: "agent.tool_result", label: "Reading parallel-a.ts", openToolIds: ["tool-1-2"] },
      { eventType: "agent.tool_result", label: "Thinking", openToolIds: [] },
      { eventType: "agent.text", label: "Writing", openToolIds: [] },
    ]);
  });

  it("流式工具早捕获：GENERATING/PENDING 早期帧先发 agent.tool_preview，进入 ACTIVE 及重复 ACTIVE 刷新参数只发一次正式 agent.tool", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "GENERATING",
                  tool_name: "read_file",
                  tool_info: { parameters: {} },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "ACTIVE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "early-agy.ts" } },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "ACTIVE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "early-agy.ts", StartLine: 1 } },
                },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 2,
                  step_type: "tool",
                  state: "DONE",
                  tool_name: "read_file",
                  tool_info: { parameters: { Path: "early-agy.ts" } },
                },
              },
              { type: "text", stepId: 3, deltas: ["完成"] },
            ],
          },
        ],
      },
    });

    const s = t.addSession({ role: "worker", workerId: 309 });
    await t.driver.send(s.id, user(1, "流式早捕获"));
    await t.waitFor("turn.ended");

    expect(t.of("agent.tool_preview").map((e) => ({ toolUseId: e.toolUseId, name: e.name, input: e.input }))).toEqual([
      { toolUseId: "tool-1-2", name: "read_file", input: {} },
    ]);
    // 正式入库事件绝不因早期 GENERATING 或多次 ACTIVE 重复发射
    expect(t.of("agent.tool")).toHaveLength(1);
    expect(t.of("agent.tool")[0]).toMatchObject({
      toolUseId: "tool-1-2",
      name: "read_file",
      input: { Path: "early-agy.ts" },
    });
    expect(t.of("agent.tool_result")).toHaveLength(1);
  });

  it("连接器 call_mcp_tool：GENERATING 早期帧拿到 ServerName / ToolName 就发 agent.tool_preview，状态行能写出服务和动作", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              { type: "rawStepUpdate", stepUpdate: { step_index: 4, step_type: "tool", state: "GENERATING", tool_name: "call_mcp_tool", tool_info: { parameters: {} } } },
              {
                type: "rawStepUpdate",
                stepUpdate: { step_index: 4, step_type: "tool", state: "GENERATING", tool_name: "call_mcp_tool", tool_info: { parameters: { ServerName: "linear", ToolName: "list_issues" } } },
              },
              {
                type: "rawStepUpdate",
                stepUpdate: {
                  step_index: 4,
                  step_type: "tool",
                  state: "ACTIVE",
                  tool_name: "call_mcp_tool",
                  tool_info: { parameters: { ServerName: "linear", ToolName: "list_issues", Arguments: { query: "secret" } } },
                },
              },
              { type: "rawStepUpdate", stepUpdate: { step_index: 4, step_type: "tool", state: "DONE", tool_name: "call_mcp_tool", tool_info: { parameters: {} } } },
              { type: "text", stepId: 5, deltas: ["好了"] },
            ],
          },
        ],
      },
    });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "查 issue"));
    await t.waitFor("turn.ended");

    const previews = t.of("agent.tool_preview").map((e) => e.input);
    expect(previews).toEqual([{}, { ServerName: "linear", ToolName: "list_issues" }]);
    expect(describeStep({ type: "tool_use", name: "call_mcp_tool", input: previews[1] as Record<string, string> })).toBe("Calling Linear: list issues");
    expect(t.of("agent.tool")).toHaveLength(1);
  });
});
