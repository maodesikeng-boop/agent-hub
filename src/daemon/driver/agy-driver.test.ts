// AgyDriver 与 agy-protocol 单元测试（TDD：覆盖协议纯函数、首轮完整流式交互、长连接复用与恢复、SIGINT 打断、Worker 安全拦截、生命周期管理）。
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DriverError,
  EMPTY_TOKEN_USAGE,
  RELAUNCH_NOTE,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
  type SessionStore,
} from "../../shared/index.ts";
import { createAgyDriver, type AgyDriver, type AgyDriverOptions } from "./agy-driver.ts";
import {
  buildAgyArgs,
  buildAgyUserLine,
  checkAgyUserLine,
  checkWorkerToolViolation,
  detectAgyArgsConflict,
  formatSystemInstructions,
  parseAgyUsage,
} from "./agy-protocol.ts";

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

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
    | { type: "tool"; stepId?: number; name: string; parameters?: Record<string, unknown>; durationMs?: number }
    | { type: "sleep"; ms: number }
    | { type: "waitFile"; path: string }
  >;
  result?: {
    status?: "SUCCESS" | "ERROR";
    finishedReason?: string | null;
    response?: string;
    usage?: Record<string, number>;
    error?: string;
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
  kind: "argv" | "stdin" | "signal" | "exit";
  pid: number;
  argv?: string[];
  cwd?: string;
  line?: string;
  signal?: string;
  code?: number;
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
    } else if (step.type === "tool") {
      const sid = step.stepId ?? stepCounter++;
      emit({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: sid,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: step.name,
          tool_info: { parameters: step.parameters ?? {} },
        },
      });
      if (step.durationMs) {
        await sleep(step.durationMs);
      }
      if (interrupted) return;
      emit({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: sid,
          step_type: "tool",
          state: "DONE",
          tool_name: step.name,
          tool_info: { parameters: step.parameters ?? {} },
        },
      });
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
    },
  });
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

let activeHarness: AgyTestHarness | undefined;
let nextSessionId = 1;

afterEach(async () => {
  await activeHarness?.cleanup();
  activeHarness = undefined;
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
  };

  const driver = createAgyDriver({
    agyPath: fakeAgyPath,
    stateDir,
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
      };
    },
    env: {
      FAKE_AGY_LOG: logFile,
      FAKE_AGY_SCRIPT: scriptFile,
      FAKE_AGY_STATE: dir,
    },
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

  activeHarness = {
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
  return activeHarness;
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
      const settingsPlan = join(dir, "plan.json");
      writeFileSync(settingsAuto, JSON.stringify({ permissions: { defaultMode: "auto" } }));
      writeFileSync(settingsPlan, JSON.stringify({ permissions: { defaultMode: "dontAsk" } }));

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

      const filesPlan: LaunchFiles = { promptFile: join(dir, "p.md"), settingsFile: settingsPlan, env: {}, fingerprint: "f2" };
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

  const stateDir = "/Users/u/.agent-hub/state";
  const cwd = "/Users/u/.agent-hub/worktrees/1/2";

  it("checkWorkerToolViolation：只读 Worker 写文件被拦（含 sed_file、notebook_edit）；非只读 Worker 不拦", () => {
    for (const toolName of ["edit_file", "sed_file", "notebook_edit", "write_to_file"]) {
      expect(checkWorkerToolViolation({ toolName, parameters: { Path: "src/index.ts" }, readonly: true, stateDir, cwd })).toBe(
        "只读 Worker 不能修改文件",
      );
      expect(checkWorkerToolViolation({ toolName, parameters: { Path: "src/index.ts" }, readonly: false, stateDir, cwd })).toBeNull();
    }
    expect(checkWorkerToolViolation({ toolName: "view_file", parameters: { AbsolutePath: "src/index.ts" }, readonly: true, stateDir, cwd })).toBeNull();
  });

  it("checkWorkerToolViolation：写类工具和写命令碰 state/ 被拦，读 state/ 不拦", () => {
    const statePath = `${stateDir}/personas/pm-1.md`;
    for (const toolName of ["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]) {
      expect(checkWorkerToolViolation({ toolName, parameters: { TargetFile: statePath }, readonly: false, stateDir, cwd })).toBe(
        "Worker 不能修改系统数据目录",
      );
    }
    for (const toolName of ["view_file", "read_file", "grep_search", "list_dir"]) {
      expect(checkWorkerToolViolation({ toolName, parameters: { AbsolutePath: statePath, SearchPath: statePath, DirectoryPath: stateDir }, readonly: false, stateDir, cwd })).toBeNull();
    }
    expect(checkWorkerToolViolation({ toolName: "run_command", parameters: { CommandLine: `echo x > ${statePath}` }, readonly: false, stateDir, cwd })).toBe(
      "Worker 不能修改系统数据目录",
    );
    expect(checkWorkerToolViolation({ toolName: "run_command", parameters: { CommandLine: `cat ${statePath}` }, readonly: false, stateDir, cwd })).toBeNull();
  });

  it("checkWorkerToolViolation：Worker 改记忆文件不再拦（2026-11-06 用户去掉了这条限制）", () => {
    const memoryPaths = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".claude/settings.json"];
    for (const p of memoryPaths) {
      for (const toolName of ["view_file", "write_to_file", "replace_file_content", "sed_file", "notebook_edit"]) {
        expect(checkWorkerToolViolation({ toolName, parameters: { TargetFile: p, Path: p }, readonly: false, stateDir, cwd })).toBeNull();
      }
    }
    for (const commandLine of ["echo x > CLAUDE.md", "cat AGENTS.md", "sed -i s/a/b/ .claude/settings.json"]) {
      expect(checkWorkerToolViolation({ toolName: "run_command", parameters: { CommandLine: commandLine }, readonly: false, stateDir, cwd })).toBeNull();
    }
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
      "agent.text",
      "agent.tool",
      "agent.tool_result",
      "agent.text",
      "turn.ended",
    ]);

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

describe("4. Worker 安全拦截（系统数据目录 state/ 与只读模式拦截）", () => {
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

  it("Worker 试图修改 stateDir 下的文件时被驱动层拦截并报错", async () => {
    const t = makeAgyHarness();
    const targetInState = join(t.stateDir, "personas", "pm-1.md");
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [{ steps: [{ type: "tool", stepId: 2, name: "edit_file", parameters: { TargetFile: targetInState }, durationMs: 2000 }] }],
      }),
    );
    const s = t.addSession({ role: "worker", workerId: 11 });
    await t.driver.send(s.id, user(1, "修改性格设定文件"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(false);
    expect(ended.interrupted).toBe(false);
    expect(ended.error?.message).toContain("Worker 不能修改系统数据目录");
  });

  it("只读 Worker 启动带 --mode plan，试图调用写文件工具修改普通文件时被驱动层拦截并报错", async () => {
    const t = makeAgyHarness({
      script: {
        turns: [
          {
            steps: [
              {
                type: "tool",
                stepId: 2,
                name: "edit_file",
                parameters: { Path: "src/app.ts" },
                durationMs: 2000,
              },
            ],
          },
        ],
      },
    });
    t.launch.readonly = true;

    const s = t.addSession({ role: "worker", workerId: 12 });
    await t.driver.send(s.id, user(1, "尝试改代码"));
    const ended = await t.waitFor("turn.ended");
    const [argv] = t.argvs();
    expect(argv![argv!.indexOf("--mode") + 1]).toBe("plan");
    expect(ended.ok).toBe(false);
    expect(ended.interrupted).toBe(false);
    expect(ended.error?.message).toContain("只读 Worker 不能修改文件");
  });
});

describe("5. queryCommands、isRunning、end、shutdown 与 cleanupStale", () => {
  it("queryCommands 返回 []，isRunning、end、shutdown 正常运作", async () => {
    const t = makeAgyHarness();
    const s = t.addSession();

    expect(t.driver.isRunning(s.id)).toBe(false);
    await expect(t.driver.queryCommands(s.id)).resolves.toEqual([]);

    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");
    expect(t.driver.isRunning(s.id)).toBe(true);
    await expect(t.driver.queryCommands(s.id)).resolves.toEqual([]);

    await t.driver.end(s.id);
    expect(t.driver.isRunning(s.id)).toBe(false);
    expect(t.store.get(s.id)).toMatchObject({ status: "ended", pid: null });

    await expect(t.driver.send(s.id, user(2, "再发一条"))).rejects.toThrow(DriverError);
    await expect(t.driver.send(s.id, user(2, "再发一条"))).rejects.toMatchObject({ code: "session_ended" });
  });

  it("cleanupStale：清理 vendor === 'agy' 的残留进程并将 pid 清零、status 置 idle", async () => {
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
