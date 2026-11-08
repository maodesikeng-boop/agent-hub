// OpenAI Codex App-Server 驱动层测试：覆盖握手、流式事件、恢复回退、打断与 Worker 记忆保护审批。
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_TOKEN_USAGE,
  buildReadonlyPolicy,
  buildSessionSettings,
  workerWriteScope,
  RELAUNCH_NOTE,
  type AgentSessionPatch,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
  type SessionStore,
} from "../../shared/index.ts";
import { createCodexDriver, type CodexDriver, type CodexDriverOptions } from "./codex-driver.ts";
import { buildSandboxPolicy, decideFileChangeApproval, extractFileChangePaths } from "./codex-protocol.ts";
import { makePersonaFixture, type PersonaFixture } from "./persona-fixture.ts";
import { fakePreambleLedger, PREAMBLE } from "./preamble-fixture.ts";

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

export interface FakeCodexTurnScript {
  /** 收到 turn/start 后如果为 true 则等待 turn/interrupt 才发 turn/completed(interrupted)。 */
  waitForInterrupt?: boolean;
  /** 如果为 true，收到 turn/interrupt 也不回 turn/completed（测超时强杀）。 */
  ignoreInterrupt?: boolean;
  /** 推理增量列表。 */
  reasoningDeltas?: string[];
  /** 工具调用列表。 */
  tools?: Array<{
    id: string;
    type: "commandExecution" | "fileChange" | "webSearch" | "mcpToolCall" | "collabToolCall";
    command?: string;
    cwd?: string;
    changes?: Array<{ path: string; kind?: { type: string; move_path?: string | null } }>;
    query?: string;
    server?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  }>;
  /** 工具条目的 item/completed 等反向 RPC 请求都回了再发（真 codex 的审批在条目开始和结束之间）。默认开始后马上结束。 */
  toolsCompleteAfterRequests?: boolean;
  /** 反向 RPC 请求列表（在完成本轮前发给客户端并等待响应）。 */
  serverRequests?: Array<{
    id: number | string;
    method: string;
    params: Record<string, unknown>;
  }>;
  /** agentMessage 的分段 delta。 */
  messageDeltas?: string[];
  /** 自定义 agentMessage 的 item.id（用于测跨轮相同 item.id 不撞车）。 */
  messageItemId?: string;
  /** item/completed 里的完整文本（不填则用 messageDeltas 拼接）。 */
  completedMessageText?: string;
  /** 若为 true，不发 agentMessage 的 item/completed，测 turn/completed 兜底补发。 */
  skipMessageCompleted?: boolean;
  /** token 用量通知。 */
  tokenUsage?: {
    last: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    total: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  };
  /** 额度通知。 */
  rateLimits?: {
    primary?: { usedPercent: number; windowDurationMins: number; resetsAt: number };
    secondary?: { usedPercent: number; windowDurationMins: number; resetsAt: number };
  };
  /** 结束状态，默认 completed。 */
  status?: "completed" | "interrupted" | "failed";
  /** 失败时的错误消息。 */
  errorMessage?: string;
  /**
   * 一轮中途 steer（docs/mid-turn-messages.md 第 8 节）：先出一个正在跑的命令（commandExecution item/started），等这个文件出现才算跑完
   * （item/completed），跑完后把这期间 steer 进来的各出一个 userMessage item（同一轮取走）。等的时候 turn/interrupt 就以 interrupted 结束，
   * steer 进来没取走的静默丢掉（和真 codex 一样）。
   */
  holdFile?: string;
  /** steer 收下了，但这一轮直到结束都没出它的 userMessage（模拟“收下的同一刻这一轮恰好结束”）。 */
  dropSteers?: boolean;
  /** 这一轮里的 turn/steer 一律回 “no active turn to steer”（模拟刚好结束）。 */
  rejectSteer?: boolean;
  /**
   * 这一轮里的 turn/steer 先不回，等这一轮的 turn/completed 发出去之后才回（模拟回执晚于这一轮结束）：ok 回成功、error 回
   * “no active turn to steer”。这些 steer 都没被取走（没有 userMessage）。
   */
  deferSteerReply?: "ok" | "error";
}

export interface FakeCodexScript {
  /** thread/start 返回的线程 ID，默认 "thread-new-1"。 */
  startThreadId?: string;
  /** thread/resume 是否报错（模拟 not found / no rollout found）。 */
  failResumeWith?: string;
  /** 每轮剧本（按顺序取，取完用最后一个或默认成功）。 */
  turns?: FakeCodexTurnScript[];
}

export interface FakeCodexLogEntry {
  kind: "argv" | "rpc_in" | "rpc_out" | "signal" | "probe";
  pid: number;
  /** probe：FAKE_CODEX_PROBE 写没写成。 */
  ok?: boolean;
  code?: string;
  argv?: string[];
  cwd?: string;
  msg?: Record<string, unknown>;
  signal?: string;
}

const FAKE_CODEX_SOURCE = `
const fs = require("node:fs");

const logFile = process.env.FAKE_CODEX_LOG;
const scriptFile = process.env.FAKE_CODEX_SCRIPT;
const script = scriptFile && fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : {};

function appendLog(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
}

appendLog({ kind: "argv", argv: process.argv.slice(2), cwd: process.cwd() });
// FAKE_CODEX_PROBE：启动时试着写这个文件，记下写没写成（测 Worker 的可写范围）
if (process.env.FAKE_CODEX_PROBE) {
  try {
    fs.writeFileSync(process.env.FAKE_CODEX_PROBE, "probe");
    appendLog({ kind: "probe", ok: true });
  } catch (e) {
    appendLog({ kind: "probe", ok: false, code: e.code });
  }
}

function send(obj) {
  appendLog({ kind: "rpc_out", msg: obj });
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

process.on("SIGINT", () => {
  appendLog({ kind: "signal", signal: "SIGINT" });
  process.exit(0);
});

let turnIndex = 0;
let activeTurn = null;
/** 正在跑的一轮（turn/start 到 turn/completed 之间），turn/steer 只认它。 */
let currentTurn = null;
/** steer 进来还没取走的。 */
let steered = [];
/** deferSteerReply：还没回的 turn/steer（这一轮结束后回）。 */
let deferredSteers = [];
let userMessageSeq = 0;

function echoUserMessage(threadId, turnId, input) {
  const item = { id: "um-" + ++userMessageSeq, type: "userMessage", content: input };
  send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, item } });
  send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item } });
}

/** 当前命令跑完（或这次模型回复写完）：steer 进来的各出一个 userMessage item，同一轮取走。 */
function takeSteers(threadId, turnId, turnScript) {
  if (turnScript.dropSteers) return false;
  const taken = steered.splice(0);
  for (const s of taken) echoUserMessage(threadId, turnId, s.input);
  return taken.length > 0;
}

function completeTurn(threadId, turnId, status, errorMessage) {
  currentTurn = null;
  steered = [];
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status, ...(errorMessage ? { error: { message: errorMessage } } : {}) } },
  });
  for (const d of deferredSteers.splice(0)) {
    if (d.reply === "ok") send({ jsonrpc: "2.0", id: d.id, result: { turnId } });
    else send({ jsonrpc: "2.0", id: d.id, error: { code: -32600, message: "no active turn to steer" } });
  }
}
let currentThreadId = script.startThreadId || "thread-new-1";
const pendingServerRequests = new Map();

function runTurn(turnId, threadId, turnScript, input) {
  const me = (currentTurn = { turnId, threadId, turnScript, holding: false, aborted: false });
  echoUserMessage(threadId, turnId, input || []);
  const stepReasoning = () => {
    const deltas = turnScript.reasoningDeltas || [];
    if (deltas.length > 0) {
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: { threadId, turnId, item: { id: "reason-1", type: "reasoning" } },
      });
      deltas.forEach((delta, i) => {
        send({
          jsonrpc: "2.0",
          method: "item/reasoning/summaryTextDelta",
          params: { threadId, turnId, itemId: "reason-1", summaryIndex: 0, delta },
        });
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: { threadId, turnId, item: { id: "reason-1", type: "reasoning" } },
      });
    }
  };

  const stepTools = () => {
    const tools = turnScript.tools || [];
    for (const tool of tools) {
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: { threadId, turnId, item: { ...tool, status: "inProgress" } },
      });
      if (!turnScript.toolsCompleteAfterRequests) completeTool(tool);
    }
  };
  const completeTool = (tool) =>
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId, turnId, item: { ...tool, status: "completed" } },
    });

  const finishTurn = () => {
    const deltas = turnScript.messageDeltas || [];
    const msgId = turnScript.messageItemId || \`msg-\${turnId}\`;
    if (deltas.length > 0 || turnScript.completedMessageText) {
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: { threadId, turnId, item: { id: msgId, type: "agentMessage" } },
      });
      for (const delta of deltas) {
        send({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId: msgId, delta },
        });
      }
      if (!turnScript.skipMessageCompleted) {
        const finalText =
          typeof turnScript.completedMessageText === "string"
            ? turnScript.completedMessageText
            : deltas.join("");
        send({
          jsonrpc: "2.0",
          method: "item/completed",
          params: { threadId, turnId, item: { id: msgId, type: "agentMessage", text: finalText } },
        });
      }
    }

    if (turnScript.tokenUsage) {
      send({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: turnScript.tokenUsage },
      });
    }

    if (turnScript.rateLimits) {
      send({
        jsonrpc: "2.0",
        method: "account/rateLimits/updated",
        params: { rateLimits: turnScript.rateLimits },
      });
    }

    // 这次模型回复写完时还有 steer 进来的：同一轮读到，再回一句
    if (takeSteers(threadId, turnId, turnScript)) {
      const ackId = "msg-ack-" + turnId;
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, item: { id: ackId, type: "agentMessage" } } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: { id: ackId, type: "agentMessage", text: "ack" } } });
    }

    if (turnScript.waitForInterrupt) {
      activeTurn = { turnId, threadId, turnScript };
      return;
    }

    activeTurn = null;
    completeTurn(threadId, turnId, turnScript.status || "completed", turnScript.errorMessage);
  };

  const afterHold = () => {
    stepTools();
    const reqs = [...(turnScript.serverRequests || [])];
    const sendNextReq = () => {
      if (me.aborted) return;
      if (reqs.length === 0) {
        if (turnScript.toolsCompleteAfterRequests) for (const tool of turnScript.tools || []) completeTool(tool);
        finishTurn();
        return;
      }
      const req = reqs.shift();
      pendingServerRequests.set(req.id, () => sendNextReq());
      send({
        jsonrpc: "2.0",
        id: req.id,
        method: req.method,
        params: { threadId, turnId, ...req.params },
      });
    };
    sendNextReq();
  };

  stepReasoning();
  if (turnScript.holdFile) {
    const hold = { id: "hold-" + turnId, type: "commandExecution", command: "sleep 8", cwd: process.cwd() };
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, item: { ...hold, status: "inProgress" } } });
    me.holding = true;
    const timer = setInterval(() => {
      if (me.aborted) return clearInterval(timer);
      if (!fs.existsSync(turnScript.holdFile)) return;
      clearInterval(timer);
      me.holding = false;
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: { ...hold, status: "completed" } } });
      takeSteers(threadId, turnId, turnScript);
      afterHold();
    }, 20);
    return;
  }
  afterHold();
}


function handleMessage(msg) {
  appendLog({ kind: "rpc_in", msg });

  // Client response to server request
  if (msg.id !== undefined && msg.method === undefined) {
    const next = pendingServerRequests.get(msg.id);
    if (next) {
      pendingServerRequests.delete(msg.id);
      next(msg);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { userAgent: "codex/0.160.0", codexHome: process.cwd() },
    });
    return;
  }

  if (msg.method === "initialized") {
    return;
  }

  if (msg.method === "thread/start") {
    currentThreadId = script.startThreadId || "thread-new-1";
    send({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: currentThreadId } },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { thread: { id: currentThreadId, model: msg.params?.model || "gpt-5.4" } },
    });
    return;
  }

  if (msg.method === "thread/resume") {
    if (script.failResumeWith) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32600, message: script.failResumeWith },
      });
      return;
    }
    currentThreadId = msg.params?.threadId || currentThreadId;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { thread: { id: currentThreadId, model: msg.params?.model || "gpt-5.4" } },
    });
    return;
  }

  if (msg.method === "turn/start") {
    const idx = turnIndex++;
    const turns = script.turns || [];
    const turnScript = turns[idx] || turns[turns.length - 1] || { messageDeltas: ["ok"] };
    const turnId = \`turn-\${idx + 1}\`;
    const threadId = msg.params?.threadId || currentThreadId;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    runTurn(turnId, threadId, turnScript, msg.params?.input);
    return;
  }

  if (msg.method === "turn/steer") {
    const p = msg.params || {};
    if (!currentTurn || currentTurn.turnScript.rejectSteer) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no active turn to steer" } });
      return;
    }
    if (currentTurn.turnScript.deferSteerReply) {
      deferredSteers.push({ id: msg.id, reply: currentTurn.turnScript.deferSteerReply });
      return;
    }
    if (p.expectedTurnId !== currentTurn.turnId) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "expected active turn id " + p.expectedTurnId + " but found " + currentTurn.turnId } });
      return;
    }
    steered.push({ input: p.input || [] });
    send({ jsonrpc: "2.0", id: msg.id, result: { turnId: currentTurn.turnId } });
    return;
  }

  if (msg.method === "turn/interrupt") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    if (activeTurn && !activeTurn.turnScript.ignoreInterrupt) {
      const { turnId, threadId } = activeTurn;
      activeTurn = null;
      completeTurn(threadId, turnId, "interrupted");
    } else if (currentTurn && currentTurn.holding && !currentTurn.turnScript.ignoreInterrupt) {
      // 命令跑着时打断：这一轮以 interrupted 结束，steer 进来没取走的静默丢了
      currentTurn.aborted = true;
      completeTurn(currentTurn.threadId, currentTurn.turnId, "interrupted");
    }
    return;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handleMessage(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
`;

interface CodexTestHarness {
  dir: string;
  stateDir: string;
  store: MemorySessionStore;
  driver: CodexDriver;
  events: Array<{ sessionId: SessionId; event: DriverEvent }>;
  waitFor<T extends DriverEvent["type"]>(
    type: T,
    pred?: (e: Extract<DriverEvent, { type: T }>) => boolean,
    count?: number,
  ): Promise<Extract<DriverEvent, { type: T }>>;
  of<T extends DriverEvent["type"]>(type: T): Array<Extract<DriverEvent, { type: T }>>;
  log(): FakeCodexLogEntry[];
  rpcIn(): Array<Record<string, unknown>>;
  addSession(patch?: Partial<AgentSessionRow>): AgentSessionRow;
  setReadonly(sessionId: SessionId, readonly: boolean): void;
  cleanup(): Promise<void>;
}

let activeHarness: CodexTestHarness | undefined;
let nextSessionId = 1;

afterEach(async () => {
  await activeHarness?.cleanup();
  activeHarness = undefined;
});

function makeCodexHarness(
  options: {
    script?: FakeCodexScript;
    driver?: Partial<CodexDriverOptions>;
    personaRevision?: () => number;
    /** 数据目录放在临时目录下的这个子目录里（默认就是临时目录本身）：真包 OS 沙箱时，假 codex 的日志、剧本得在数据目录外。 */
    dataDirName?: string;
    /** 假 codex 启动时试着往数据目录里写这个文件（FAKE_CODEX_PROBE），结果记进日志。 */
    probeInDataDir?: string;
  } = {},
): CodexTestHarness {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-codex-driver-")));
  const dataDir = options.dataDirName ? join(dir, options.dataDirName) : dir;
  const stateDir = join(dataDir, "state");
  mkdirSync(stateDir, { recursive: true });

  const logFile = join(dir, "fake-codex.log");
  const scriptFile = join(dir, "script.json");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}));

  const fakeCodexBin = join(dir, "fake-codex");
  writeFileSync(fakeCodexBin, `#!${process.execPath}\n${FAKE_CODEX_SOURCE}`);
  chmodSync(fakeCodexBin, 0o755);

  const store = new MemorySessionStore();
  const readonlyMap = new Map<SessionId, boolean>();

  const driver = createCodexDriver({
    codexPath: fakeCodexBin,
    store,
    prepareLaunch: async (session) => {
      const launchDir = join(stateDir, "launch", String(session.id));
      mkdirSync(launchDir, { recursive: true });
      const promptFile = join(launchDir, "prompt.md");
      writeFileSync(promptFile, `你是 ${session.role}。`);
      const readonly = readonlyMap.get(session.id) ?? false;
      const settingsFile = join(launchDir, "settings.json");
      const settings = buildSessionSettings({
        role: session.role === "worker" ? "worker" : "pm",
        hubSock: join(dir, "run", "hub.sock"),
        stateDir,
        osSandboxed: false,
      });
      writeFileSync(settingsFile, JSON.stringify(settings));
      const files: LaunchFiles = {
        promptFile,
        settingsFile,
        env: {
          HUB_TOKEN: `tok-${session.id}`,
          HUB_SOCK: join(dir, "run", "hub.sock"),
          PATH: `/custom/bin:${process.env.PATH ?? ""}`,
        },
        fingerprint: `fp-${session.role}-${readonly ? "ro" : "rw"}`,
      };
      if (options.personaRevision) files.personaRevision = options.personaRevision();
      // 数据目录默认是临时目录本身：state/、别的会话的 workspace/<编号> 都在里面（和 launch.ts 一样用 workerWriteScope）
      const writeScope = workerWriteScope({ role: session.role, dataDir, cwd: session.cwd });
      if (writeScope !== null) files.writeScope = writeScope;
      if (readonly) files.readonly = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir });
      return files;
    },
    env: {
      FAKE_CODEX_LOG: logFile,
      FAKE_CODEX_SCRIPT: scriptFile,
      ...(options.probeInDataDir ? { FAKE_CODEX_PROBE: join(dataDir, options.probeInDataDir) } : {}),
    },
    // 默认按没有 OS 沙箱的系统跑（codex 自己的沙箱加审批兜底），跟本机是不是 macOS 无关；真包沙箱的用例自己传 darwin
    platform: "linux",
    ...options.driver,
  });

  const events: CodexTestHarness["events"] = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
    for (const w of waiters.splice(0)) w();
  });

  const of = <T extends DriverEvent["type"]>(type: T) =>
    events.map((e) => e.event).filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type);

  const waitFor: CodexTestHarness["waitFor"] = (type, pred = () => true, count = 1) =>
    new Promise((resolve) => {
      const check = () => {
        const hits = of(type).filter(pred);
        if (hits.length >= count) resolve(hits[count - 1]!);
        else waiters.push(check);
      };
      check();
    });

  const log = (): FakeCodexLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCodexLogEntry)
      : [];

  const addSession = (patch: Partial<AgentSessionRow> = {}): AgentSessionRow => {
    const id = nextSessionId++;
    const cwd = join(dataDir, "workspace", String(id));
    mkdirSync(cwd, { recursive: true });
    const row: AgentSessionRow = {
      id,
      role: "pm",
      conversationId: id,
      pmId: 1,
      workerId: null,
      vendor: "codex",
      vendorSessionId: `initial-uuid-${id}`,
      cwd,
      addDirs: [],
      generation: 1,
      model: "gpt-5.4",
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

  activeHarness = {
    dir,
    stateDir,
    store,
    driver,
    events,
    waitFor,
    of,
    log,
    rpcIn: () => log().flatMap((e) => (e.kind === "rpc_in" && e.msg ? [e.msg] : [])),
    addSession,
    setReadonly: (sessionId, ro) => readonlyMap.set(sessionId, ro),
    cleanup: async () => {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return activeHarness;
}

const user = (id: number, text: string, extra: Partial<{ prefixes: string[]; resend: boolean; recovery: boolean }> = {}) => ({
  messageIds: [id],
  source: "user" as const,
  text,
  ...extra,
});

describe("CodexDriver 首次启动握手与完整一轮事件流", () => {
  it("完成 initialize → initialized → thread/start 握手、更新 vendorSessionId、发送 turn/start 并处理完整事件流", async () => {
    const t = makeCodexHarness({
      script: {
        startThreadId: "thr_codex_001",
        turns: [
          {
            reasoningDeltas: ["先分析", "再实现"],
            tools: [
              { id: "call-cmd-1", type: "commandExecution", command: "pnpm typecheck", cwd: "/tmp/work" },
              { id: "call-file-1", type: "fileChange", changes: [{ path: "src/index.ts" }] },
              { id: "call-web-1", type: "webSearch", query: "codex jsonrpc" },
            ],
            messageDeltas: ["你好，", "我是 ", "Codex！"],
            tokenUsage: {
              last: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 45 },
              total: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 45 },
            },
            rateLimits: {
              primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1793619600 },
              secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793646000 },
            },
          },
        ],
      },
    });

    const s = t.addSession({ addDirs: ["/tmp/extra-dir"], model: "gpt-5.4", effort: "high" });
    await expect(t.driver.send(s.id, user(10, "请帮我检查代码"))).resolves.toEqual({ kind: "written" });

    const ended = await t.waitFor("turn.ended");
    expect(ended).toMatchObject({
      ok: true,
      interrupted: false,
      messageIds: [10],
    });

    // 1. 检查启动命令参数
    const argvEntry = t.log().find((e) => e.kind === "argv");
    expect(argvEntry?.argv).toEqual(["app-server", "--listen", "stdio://"]);

    // 2. 检查握手与请求顺序
    const rpcs = t.rpcIn();
    expect(rpcs.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);

    expect(rpcs[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "agent-hub", title: "Agent Hub", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });

    expect(rpcs[2]).toMatchObject({
      jsonrpc: "2.0",
      method: "thread/start",
      params: {
        cwd: s.cwd,
        model: "gpt-5.4",
        developerInstructions: "你是 pm。",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        config: {
          "shell_environment_policy.inherit": "all",
          "shell_environment_policy.set": expect.objectContaining({
            HUB_TOKEN: `tok-${s.id}`,
          }),
        },
      },
    });

    expect(rpcs[3]).toMatchObject({
      jsonrpc: "2.0",
      method: "turn/start",
      params: {
        threadId: "thr_codex_001",
        input: [{ type: "text", text: "请帮我检查代码" }],
        cwd: s.cwd,
        model: "gpt-5.4",
        effort: "high",
        summary: "detailed",
        sandboxPolicy: {
          type: "workspaceWrite",
          networkAccess: true,
          writableRoots: [s.cwd, "/tmp/extra-dir"],
        },
      },
    });

    // 3. 检查 vendorSessionId 更新与事件
    const updatedRow = t.store.get(s.id)!;
    expect(updatedRow.vendorSessionId).toBe("thr_codex_001");
    expect(updatedRow.hasCompletedTurn).toBe(true);

    expect(t.of("session.started")[0]).toMatchObject({
      resumed: false,
      model: "gpt-5.4",
    });
    expect(t.of("message.delivered")[0]!.messageIds).toEqual([10]);
    expect(t.of("message.processing")[0]!.messageIds).toEqual([10]);

    // 4. reasoning -> agent.thinking（带跨轮唯一且本轮稳定的 uuid）
    const thinkings = t.of("agent.thinking");
    expect(thinkings.length).toBeGreaterThanOrEqual(1);
    expect(thinkings[0]!.uuid).toBe("turn-1:1:reason-1");

    // 5. tools -> agent.tool & agent.tool_result
    const tools = t.of("agent.tool");
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      uuid: "turn-1:1:call-cmd-1",
      toolUseId: "call-cmd-1",
      name: "commandExecution",
      input: { command: "pnpm typecheck", cwd: "/tmp/work" },
    });
    expect(tools[1]).toMatchObject({
      uuid: "turn-1:1:call-file-1",
      toolUseId: "call-file-1",
      name: "fileChange",
      input: expect.objectContaining({ file_path: "src/index.ts" }),
    });
    expect(tools[2]).toMatchObject({
      uuid: "turn-1:1:call-web-1",
      toolUseId: "call-web-1",
      name: "webSearch",
      input: { query: "codex jsonrpc" },
    });

    const toolResults = t.of("agent.tool_result");
    expect(toolResults.map((r) => r.toolUseIds)).toEqual([["call-cmd-1"], ["call-file-1"], ["call-web-1"]]);

    // 6. agentMessage delta 累加，只在 item/completed 发出完整的一条 agent.text
    const texts = t.of("agent.text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({
      uuid: "turn-1:1:msg-turn-1",
      text: "你好，我是 Codex！",
    });

    // 7. tokenUsage 与 rateLimits
    expect(updatedRow.usage).toEqual({
      input: 120,
      cacheRead: 30,
      cacheWrite: 0,
      output: 45,
      context: 150,
    });
    expect(updatedRow.rateLimit).toEqual({
      status: "allowed",
      resetsAt: 1793619600,
      windows: {
        five_hour: { utilization: 0.35, resetsAt: 1793619600, status: "allowed" },
        seven_day: { utilization: 0.6, resetsAt: 1793646000, status: "allowed" },
      },
    });
    expect(t.of("rate_limit")[0]!.info).toEqual(updatedRow.rateLimit);
  });
});

describe("CodexDriver 会话恢复与失败回退", () => {
  it("已跑完过一轮的会话走 thread/resume", async () => {
    const t = makeCodexHarness({
      script: {
        turns: [{ messageDeltas: ["继续工作"] }],
      },
    });
    const s = t.addSession({
      hasCompletedTurn: true,
      vendorSessionId: "thr_existing_99",
    });

    await t.driver.send(s.id, user(1, "接着做"));
    await t.waitFor("turn.ended");

    const rpcs = t.rpcIn();
    expect(rpcs.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(rpcs[2]).toMatchObject({
      method: "thread/resume",
      params: expect.objectContaining({
        threadId: "thr_existing_99",
        cwd: s.cwd,
      }),
    });
    expect(t.of("session.started")[0]).toMatchObject({ resumed: true });
    expect(t.store.get(s.id)!.vendorSessionId).toBe("thr_existing_99");
  });

  it("会话没选模型：thread/start 显式带上名单里的默认模型（不让 codex 用 config.toml 里钉死的）；选了的以选的为准", async () => {
    const t = makeCodexHarness({
      script: { turns: [{ messageDeltas: ["ok"] }] },
      driver: { defaultModel: async () => "gpt-6-luna" },
    });
    const s = t.addSession({ model: null });
    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");
    expect(t.rpcIn().find((r) => r.method === "thread/start")).toMatchObject({ params: { model: "gpt-6-luna" } });
    // 不改库里的 model：界面仍显示“默认”，也不会因为它被判成“启动参数变了”而反复重启
    expect(t.store.get(s.id)!.model).toBeNull();

    const t2 = makeCodexHarness({
      script: { turns: [{ messageDeltas: ["ok"] }] },
      driver: { defaultModel: async () => "gpt-6-luna" },
    });
    const s2 = t2.addSession({ model: "gpt-5.6-terra" });
    await t2.driver.send(s2.id, user(1, "你好"));
    await t2.waitFor("turn.ended");
    expect(t2.rpcIn().find((r) => r.method === "thread/start")).toMatchObject({ params: { model: "gpt-5.6-terra" } });
  });

  it("名单里没有默认模型（问不到）：thread/start 不带 model，交给 codex 自己", async () => {
    const t = makeCodexHarness({
      script: { turns: [{ messageDeltas: ["ok"] }] },
      driver: { defaultModel: async () => null },
    });
    const s = t.addSession({ model: null });
    await t.driver.send(s.id, user(1, "你好"));
    await t.waitFor("turn.ended");
    expect(t.rpcIn().find((r) => r.method === "thread/start")?.params).not.toHaveProperty("model");
  });

  it("thread/resume 报错找不到线程时自动回退 thread/start 并更新 vendorSessionId", async () => {
    const t = makeCodexHarness({
      script: {
        failResumeWith: "thread not found: no rollout found for thr_missing",
        startThreadId: "thr_fallback_new",
        turns: [{ messageDeltas: ["新线程已启动"] }],
      },
    });
    const s = t.addSession({
      hasCompletedTurn: true,
      vendorSessionId: "thr_missing",
    });

    await t.driver.send(s.id, user(1, "你好"));
    const ended = await t.waitFor("turn.ended");
    expect(ended.ok).toBe(true);

    const rpcs = t.rpcIn();
    expect(rpcs.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
      "turn/start",
    ]);
    expect(rpcs[4]).toMatchObject({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thr_fallback_new",
      }),
    });
    expect(t.store.get(s.id)!.vendorSessionId).toBe("thr_fallback_new");
    expect(t.of("session.started")[0]).toMatchObject({ resumed: false });
    expect(t.of("agent.text")[0]!.text).toBe("新线程已启动");
  });
});

describe("CodexDriver 打断（interrupt）", () => {
  it("interrupt() 发送 turn/interrupt RPC 并正常收到 turn/completed(interrupted)，进程无需重启即可继续下一轮", async () => {
    const t = makeCodexHarness({
      script: {
        startThreadId: "thr_int_1",
        turns: [
          {
            messageDeltas: ["写了一半"],
            skipMessageCompleted: true,
            waitForInterrupt: true,
          },
          {
            messageDeltas: ["第二轮正常完成"],
          },
        ],
      },
    });
    const s = t.addSession();

    await t.driver.send(s.id, user(1, "第一轮长任务"));
    await t.waitFor("message.processing");
    const firstPid = t.store.get(s.id)!.pid;
    expect(firstPid).toBeGreaterThan(0);

    await t.driver.interrupt(s.id);
    const firstEnded = await t.waitFor("turn.ended");
    expect(firstEnded).toMatchObject({
      ok: false,
      interrupted: true,
      messageIds: [1],
    });
    // 未发 item/completed 的残留 delta 在 turn/completed 时被补发
    expect(t.of("agent.text")[0]).toMatchObject({ text: "写了一半" });

    // 确认发了 turn/interrupt 请求且未杀死进程
    const interruptRpc = t.rpcIn().find((r) => r.method === "turn/interrupt");
    expect(interruptRpc).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thr_int_1", turnId: "turn-1" },
    });
    expect(t.of("session.exited")).toEqual([]);
    expect(t.store.get(s.id)!.pid).toBe(firstPid);

    // 继续发下一轮，复用同一个进程
    await expect(t.driver.send(s.id, user(2, "第二轮消息"))).resolves.toEqual({ kind: "written" });
    const secondEnded = await t.waitFor("turn.ended", undefined, 2);
    expect(secondEnded).toMatchObject({
      ok: true,
      interrupted: false,
      messageIds: [2],
    });
    expect(t.store.get(s.id)!.pid).toBe(firstPid);
    expect(t.log().filter((e) => e.kind === "argv")).toHaveLength(1);
    expect(t.of("agent.text").map((e) => e.text)).toEqual(["写了一半", "第二轮正常完成"]);
  });
});

describe("CodexDriver 反向 RPC 审批拦截（Worker 的可写范围与只读模式；记忆文件不拦）", () => {
  it("Worker 收到审批：改数据目录（state/、新建目录、别的会话的目录）返回 decline，改 AGENTS.md、自己目录、普通文件返回 accept", async () => {
    const t = makeCodexHarness({
      script: {
        turns: [
          {
            serverRequests: [
              {
                id: 901,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-1", changes: [{ path: "AGENTS.md" }] },
              },
              {
                id: 902,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-2", filePath: "nested/.claude/settings.json" },
              },
              {
                id: 903,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-3", paths: ["src/feature.ts"] },
              },
              {
                id: 904,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-1", command: "echo hack > AGENTS.md" },
              },
              {
                id: 905,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-2", command: "pnpm vitest run" },
              },
              {
                id: 906,
                method: "item/tool/requestUserInput",
                params: { itemId: "ask-1", questions: [{ id: "q1", question: "choose" }] },
              },
            ],
            messageDeltas: ["Worker 执行完毕"],
          },
        ],
      },
    });

    const worker = t.addSession({ role: "worker", workerId: 1 });
    // 动态加几条往数据目录（临时目录本身）里写的审批请求
    const stateFile = join(t.stateDir, "personas", "pm-1.md");
    const otherSession = join(t.dir, "workspace", "999", "a.ts");
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [
          {
            serverRequests: [
              {
                id: 901,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-1", changes: [{ path: "AGENTS.md" }] },
              },
              {
                id: 902,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-2", filePath: stateFile },
              },
              {
                id: 903,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-3", paths: ["src/feature.ts"] },
              },
              {
                id: 904,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-1", command: "echo hack > AGENTS.md" },
              },
              {
                id: 905,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-2", command: "pnpm vitest run" },
              },
              {
                id: 906,
                method: "item/tool/requestUserInput",
                params: { itemId: "ask-1", questions: [{ id: "q1", question: "choose" }] },
              },
              {
                id: 907,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-3", command: ["/bin/zsh", "-lc", `mkdir -p ${join(t.dir, "shots")}`] },
              },
              {
                id: 908,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-4", filePath: otherSession },
              },
              {
                id: 909,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-4", command: `echo ok > ${join(worker.cwd, "ok.txt")} && git commit -am x` },
              },
              {
                id: 910,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-5", command: "touch x", cwd: t.dir },
              },
            ],
            messageDeltas: ["Worker 执行完毕"],
          },
        ],
      } satisfies FakeCodexScript),
    );

    await t.driver.send(worker.id, user(1, "开始干活"));
    await t.waitFor("turn.ended");

    const responses = t
      .rpcIn()
      .filter((r) => r.id !== undefined && r.method === undefined)
      .map((r) => ({ id: r.id, result: r.result }));

    expect(responses).toEqual([
      { id: 901, result: { decision: "accept" } },
      { id: 902, result: { decision: "decline" } },
      { id: 903, result: { decision: "accept" } },
      { id: 904, result: { decision: "accept" } },
      { id: 905, result: { decision: "accept" } },
      { id: 906, result: { answers: {} } },
      { id: 907, result: { decision: "decline" } },
      { id: 908, result: { decision: "decline" } },
      { id: 909, result: { decision: "accept" } },
      { id: 910, result: { decision: "decline" } },
    ]);
  });

  it("真 codex 的改文件审批只带 itemId：按这一条 item/started 里的路径判断；不知道改哪些文件的 Worker 一律 decline", async () => {
    const t = makeCodexHarness();
    const worker = t.addSession({ role: "worker", workerId: 4 });
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [
          {
            tools: [
              { id: "fc-out", type: "fileChange", changes: [{ path: join(t.dir, "shots", "a.png"), kind: { type: "add" } }] },
              { id: "fc-in", type: "fileChange", changes: [{ path: join(worker.cwd, "ok.txt"), kind: { type: "add" } }] },
            ],
            toolsCompleteAfterRequests: true,
            serverRequests: [
              { id: 951, method: "item/fileChange/requestApproval", params: { itemId: "fc-out", reason: null, grantRoot: null } },
              { id: 952, method: "item/fileChange/requestApproval", params: { itemId: "fc-in", reason: null, grantRoot: null } },
              { id: 953, method: "item/fileChange/requestApproval", params: { itemId: "fc-unknown" } },
            ],
            messageDeltas: ["done"],
          },
        ],
      } satisfies FakeCodexScript),
    );
    await t.driver.send(worker.id, user(1, "干活"));
    await t.waitFor("turn.ended");
    const decisions = t
      .rpcIn()
      .filter((r) => r.id !== undefined && r.method === undefined)
      .map((r) => ({ id: r.id, result: r.result }));
    expect(decisions).toEqual([
      { id: 951, result: { decision: "decline" } },
      { id: 952, result: { decision: "accept" } },
      { id: 953, result: { decision: "decline" } },
    ]);
  });

  it("改名的目标（kind.move_path，*** Move to:）也判断；grantRoot 在范围外就拒；条目结束后记下的路径删掉", async () => {
    const t = makeCodexHarness();
    const worker = t.addSession({ role: "worker", workerId: 5 });
    const own = (name: string) => join(worker.cwd, name);
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [
          {
            tools: [
              { id: "fc-mv-out", type: "fileChange", changes: [{ path: own("a.txt"), kind: { type: "update", move_path: join(t.stateDir, "hub.sqlite") } }] },
              { id: "fc-mv-in", type: "fileChange", changes: [{ path: own("b.txt"), kind: { type: "update", move_path: own("c.txt") } }] },
              { id: "fc-grant", type: "fileChange", changes: [{ path: own("d.txt"), kind: { type: "add" } }] },
            ],
            toolsCompleteAfterRequests: true,
            serverRequests: [
              { id: 961, method: "item/fileChange/requestApproval", params: { itemId: "fc-mv-out" } },
              { id: 962, method: "item/fileChange/requestApproval", params: { itemId: "fc-mv-in" } },
              { id: 963, method: "item/fileChange/requestApproval", params: { itemId: "fc-grant", grantRoot: t.stateDir } },
              { id: 964, method: "item/fileChange/requestApproval", params: { itemId: "fc-grant", grantRoot: worker.cwd } },
            ],
            messageDeltas: ["done"],
          },
          {
            // 上一轮的条目已经结束：同一个 itemId 再来审批，路径已经删了，不知道改哪些文件 → decline
            serverRequests: [{ id: 971, method: "item/fileChange/requestApproval", params: { itemId: "fc-mv-in" } }],
            messageDeltas: ["again"],
          },
        ],
      } satisfies FakeCodexScript),
    );
    await t.driver.send(worker.id, user(1, "干活"));
    await t.waitFor("turn.ended");
    await t.driver.send(worker.id, user(2, "再来"));
    await t.waitFor("turn.ended", undefined, 2);
    const decisions = t
      .rpcIn()
      .filter((r) => r.id !== undefined && r.method === undefined)
      .map((r) => ({ id: r.id, result: r.result }));
    expect(decisions).toEqual([
      { id: 961, result: { decision: "decline" } },
      { id: 962, result: { decision: "accept" } },
      { id: 963, result: { decision: "decline" } },
      { id: 964, result: { decision: "accept" } },
      { id: 971, result: { decision: "decline" } },
    ]);
  });

  it("越出沙箱的命令：审查找到的两个绕法（只读命令打头、cd 换进数据目录）都拒", async () => {
    const t = makeCodexHarness();
    const worker = t.addSession({ role: "worker", workerId: 6 });
    // 数据目录是临时目录本身：先 cd 到它的上一级，再用相对路径 cd 进 state/（像 cd ~ && cd .agent-hub/state）
    const parent = dirname(t.dir);
    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [
          {
            serverRequests: [
              { id: 981, method: "item/commandExecution/requestApproval", params: { itemId: "c1", command: `ls ${t.dir}; find ${t.stateDir} -delete`, cwd: worker.cwd } },
              { id: 982, method: "item/commandExecution/requestApproval", params: { itemId: "c2", command: `cd ${parent} && cd ${basename(t.dir)}/state && touch x`, cwd: worker.cwd } },
              { id: 983, method: "item/commandExecution/requestApproval", params: { itemId: "c3", command: `ls ${t.dir}; echo ok > out.txt`, cwd: worker.cwd } },
            ],
            messageDeltas: ["done"],
          },
        ],
      } satisfies FakeCodexScript),
    );
    await t.driver.send(worker.id, user(1, "干活"));
    await t.waitFor("turn.ended");
    const decisions = t
      .rpcIn()
      .filter((r) => r.id !== undefined && r.method === undefined)
      .map((r) => ({ id: r.id, result: r.result }));
    expect(decisions).toEqual([
      { id: 981, result: { decision: "decline" } },
      { id: 982, result: { decision: "decline" } },
      { id: 983, result: { decision: "accept" } },
    ]);
  });

  it.runIf(process.platform === "darwin")("macOS：Worker 的进程包进 sandbox-exec（数据目录写不了），turn 用 externalSandbox；项目经理、只读 Worker 不包", async () => {
    const t = makeCodexHarness({ dataDirName: "home", probeInDataDir: "probe.txt", driver: { platform: "darwin" } });
    const probe = join(t.dir, "home", "probe.txt");
    const worker = t.addSession({ role: "worker", workerId: 7 });
    await t.driver.send(worker.id, user(1, "干活"));
    await t.waitFor("turn.ended");
    const pm = t.addSession({ role: "pm" });
    await t.driver.send(pm.id, user(2, "看看"));
    await t.waitFor("turn.ended", undefined, 2);
    const ro = t.addSession({ role: "worker", workerId: 8 });
    t.setReadonly(ro.id, true);
    await t.driver.send(ro.id, user(3, "只读"));
    await t.waitFor("turn.ended", undefined, 3);
    const probes = t.log().filter((e) => e.kind === "probe");
    expect(probes.map((e) => e.ok)).toEqual([false, true, true]);
    expect(probes[0]?.code).toBe("EPERM");
    expect(existsSync(probe)).toBe(true); // 项目经理写成的
    const policies = t.rpcIn().filter((r) => r.method === "turn/start").map((r) => (r.params as { sandboxPolicy: unknown }).sandboxPolicy);
    expect(policies[0]).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
    expect(policies[1]).toMatchObject({ type: "workspaceWrite" });
    expect(policies[2]).toEqual({ type: "readOnly", networkAccess: true });
  });

  it("Worker 的 turn/start 沙箱：writableRoots 只留自己的目录和数据目录外的附加目录", async () => {
    const t = makeCodexHarness();
    const outside = mkdtempSync(join(tmpdir(), "agent-hub-codex-outside-"));
    const worker = t.addSession({ role: "worker", workerId: 3, addDirs: [join(t.dir, "workspace"), outside] });
    await t.driver.send(worker.id, user(1, "干活"));
    await t.waitFor("turn.ended");
    const turnStart = t.rpcIn().find((r) => r.method === "turn/start") as { params: { sandboxPolicy: unknown } } | undefined;
    expect(turnStart?.params.sandboxPolicy).toEqual({ type: "workspaceWrite", networkAccess: true, writableRoots: [worker.cwd, outside] });
    rmSync(outside, { recursive: true, force: true });
  });

  it("PM 会话修改 AGENTS.md 时审批返回 accept（项目经理没有可写范围）；只读 Worker 一律返回 decline 且用 readOnly 沙箱", async () => {
    const t = makeCodexHarness({
      script: {
        turns: [
          {
            serverRequests: [
              {
                id: 801,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-pm", changes: [{ path: "AGENTS.md" }] },
              },
            ],
            messageDeltas: ["PM 改完了"],
          },
        ],
      },
    });

    const pm = t.addSession({ role: "pm" });
    await t.driver.send(pm.id, user(1, "更新 AGENTS.md"));
    await t.waitFor("turn.ended");

    writeFileSync(
      join(t.dir, "script.json"),
      JSON.stringify({
        turns: [
          {
            serverRequests: [
              {
                id: 802,
                method: "item/fileChange/requestApproval",
                params: { itemId: "fc-ro", paths: ["src/normal.ts"] },
              },
              {
                id: 803,
                method: "item/commandExecution/requestApproval",
                params: { itemId: "cmd-ro", command: "ls -la" },
              },
            ],
            messageDeltas: ["只读 Worker 看完了"],
          },
        ],
      } satisfies FakeCodexScript),
    );

    const roWorker = t.addSession({ role: "worker", workerId: 2 });
    t.setReadonly(roWorker.id, true);
    await t.driver.send(roWorker.id, user(2, "只读审查"));
    await t.waitFor("turn.ended", undefined, 2);

    const rpcs = t.rpcIn();
    const pmResp = rpcs.find((r) => r.id === 801 && r.method === undefined);
    expect(pmResp?.result).toEqual({ decision: "accept" });

    const roFileResp = rpcs.find((r) => r.id === 802 && r.method === undefined);
    const roCmdResp = rpcs.find((r) => r.id === 803 && r.method === undefined);
    expect(roFileResp?.result).toEqual({ decision: "decline" });
    expect(roCmdResp?.result).toEqual({ decision: "decline" });

    // 检查只读 Worker 的 thread/start 与 turn/start 沙箱策略
    const threadStarts = rpcs.filter((r) => r.method === "thread/start");
    expect(threadStarts[1]?.params).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    const turnStarts = rpcs.filter((r) => r.method === "turn/start");
    expect(turnStarts[1]?.params).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
  });
});

describe("CodexDriver 跨轮 item.id 防撞车与残留进程清理", () => {
  it("不同轮次即使 codex 复用相同的 item.id，发出的 agent.text / agent.tool uuid 仍跨轮唯一", async () => {
    const t = makeCodexHarness({
      script: {
        turns: [
          {
            messageItemId: "item_shared_1",
            messageDeltas: ["第一轮回复"],
            tools: [{ id: "tool_shared_1", type: "commandExecution", command: "ls" }],
          },
          {
            messageItemId: "item_shared_1",
            messageDeltas: ["第二轮回复"],
            tools: [{ id: "tool_shared_1", type: "commandExecution", command: "pwd" }],
          },
        ],
      },
    });
    const s = t.addSession();

    await t.driver.send(s.id, user(1, "第一轮"));
    await t.waitFor("turn.ended", undefined, 1);

    await t.driver.send(s.id, user(2, "第二轮"));
    await t.waitFor("turn.ended", undefined, 2);

    const texts = t.of("agent.text");
    expect(texts).toHaveLength(2);
    expect(texts[0]!.uuid).not.toBe(texts[1]!.uuid);
    expect(texts.map((e) => e.text)).toEqual(["第一轮回复", "第二轮回复"]);

    const tools = t.of("agent.tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.uuid).not.toBe(tools[1]!.uuid);
  });

  it("cleanupStale() 识别并清理残留的 codex app-server 进程且将 pid 置空", async () => {
    const t = makeCodexHarness();
    const fakeCodexBin = join(t.dir, "fake-codex");
    const staleChild = spawn(fakeCodexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      staleChild.once("spawn", resolve);
      staleChild.once("error", reject);
    });
    const stalePid = staleChild.pid!;
    expect(stalePid).toBeGreaterThan(0);

    const s = t.addSession({ pid: stalePid, status: "running" });
    await t.driver.cleanupStale();

    expect(t.store.get(s.id)!.pid).toBeNull();
    expect(t.store.get(s.id)!.status).toBe("idle");
  });
});

describe("不写原始日志", () => {
  it("跑完一轮：数据目录和临时目录里没有 .jsonl，也没有 logs/sessions/（原文在厂商自己的目录里）", async () => {
    const t = makeCodexHarness({ script: { turns: [{ messageDeltas: ["hi"] }] } });
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "hi"));
    await t.waitFor("turn.ended");
    const files = readdirSync(t.dir, { recursive: true }).map(String);
    expect(files.filter((f) => f.endsWith(".jsonl") || f.includes(join("logs", "sessions")))).toEqual([]);
  });
});

// ---- 一轮中途交给 codex（turn/steer，docs/mid-turn-messages.md 第 8、9 节）----

describe("CodexDriver 一轮中途用 turn/steer 交给 agent", () => {
  /** 一轮：跑一条卡在 go 文件上的命令，跑完回一句。 */
  const holdTurn = (dir: string, extra: Partial<FakeCodexTurnScript> = {}): FakeCodexTurnScript => ({
    holdFile: join(dir, "go"),
    messageDeltas: ["完"],
    ...extra,
  });
  const release = (dir: string) => writeFileSync(join(dir, "go"), "");
  /** 先建好 harness（拿到目录）再写剧本：假 codex 每次启动才读剧本。 */
  function steerHarness(turns: (dir: string) => FakeCodexTurnScript[]): CodexTestHarness {
    const t = makeCodexHarness();
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ turns: turns(t.dir) }));
    return t;
  }
  const methods = (t: CodexTestHarness) => t.rpcIn().map((r) => r.method);

  it("忙时发 turn/steer（expectedTurnId 是这一轮），回执成功算已送达（midTurn）；命令跑完出它的 userMessage → 处理中；同一轮一个 turn.ended 带两条", async () => {
    const t = steerHarness((dir) => [holdTurn(dir)]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "跑 3 条命令"));
    await t.waitFor("agent.tool");
    await expect(t.driver.send(s.id, user(2, "停下，只跑一条"))).resolves.toEqual({ kind: "written", midTurn: true });
    const steer = t.rpcIn().find((r) => r.method === "turn/steer");
    expect(steer).toMatchObject({ params: { threadId: "thread-new-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "停下，只跑一条" }] } });
    expect(t.of("message.delivered").map((e) => [e.messageIds, e.midTurn])).toEqual([
      [[1], undefined],
      [[2], true],
    ]);
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1]]);
    release(t.dir);
    expect(await t.waitFor("turn.ended")).toMatchObject({ ok: true, messageIds: [1, 2] });
    expect(t.of("message.processing").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(methods(t).filter((m) => m === "turn/start")).toHaveLength(1);
  });

  it("连发两条：各一个 turn/steer，不拼成一条，同一轮都取走", async () => {
    const t = steerHarness((dir) => [holdTurn(dir)]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await t.driver.send(s.id, user(2, "再告诉我 2+2"));
    await t.driver.send(s.id, user(3, "最后带 PINEAPPLE"));
    const steers = t.rpcIn().filter((r) => r.method === "turn/steer");
    expect(steers.map((r) => (r.params as { input: Array<{ text: string }> }).input[0]!.text)).toEqual(["再告诉我 2+2", "最后带 PINEAPPLE"]);
    release(t.dir);
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1, 2, 3] });
  });

  it("报 no active turn to steer（这一轮正好结束）：退回驱动层自己的队列（queued），下一轮用 turn/start 发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { rejectSteer: true }), { messageDeltas: ["收到"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "queued" });
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
    release(t.dir);
    await t.waitFor("turn.ended", () => true, 2);
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
    expect(methods(t).filter((m) => m === "turn/start")).toHaveLength(2);
  });

  it("steer 收下了，但这一轮结束都没读到：message.requeued，再 send 用 turn/start 真的再发一次（不加重发说明）", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { dropSteers: true }), { messageDeltas: ["收到"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t.dir);
    expect(await t.waitFor("turn.ended")).toMatchObject({ ok: true, messageIds: [1] });
    expect(t.of("message.requeued")).toEqual([expect.objectContaining({ messageIds: [2] })]);
    // 账本重新登记的 session.send
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written" });
    expect(await t.waitFor("turn.ended", () => true, 2)).toMatchObject({ messageIds: [2] });
    const starts = t.rpcIn().filter((r) => r.method === "turn/start");
    expect((starts[1]!.params as { input: Array<{ text: string }> }).input).toEqual([{ type: "text", text: "插一句" }]);
  });

  it("停止：turn/completed interrupted 时 steer 了没读到的标已取消（message.cancelled stop），不重发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir), { messageDeltas: ["不该跑"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await t.driver.send(s.id, user(2, "以后每条都以 KIWI 结尾"));
    await t.driver.interrupt(s.id);
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1], interrupted: true });
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    await realSleepCodex(150);
    expect(methods(t).filter((m) => m === "turn/start")).toHaveLength(1);
    expect(t.of("message.requeued")).toEqual([]);
  });

  it("停止时：自己队列里排着的用户消息标已取消、不再发；系统消息照常发；steer 了没读到的系统消息收回", async () => {
    const t = steerHarness((dir) => [holdTurn(dir), { messageDeltas: ["收到"] }]);
    const s = t.addSession();
    const system = (id: number, text: string) => ({ messageIds: [id], source: "system" as const, text });
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await expect(t.driver.send(s.id, system(2, "【Worker #1 的汇报】A"))).resolves.toEqual({ kind: "written", midTurn: true });
    await expect(t.driver.send(s.id, user(3, "/compact"))).resolves.toEqual({ kind: "queued" });
    await expect(t.driver.send(s.id, system(4, "【Worker #2 的汇报】B"))).resolves.toEqual({ kind: "queued" });
    await t.driver.interrupt(s.id);
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1], interrupted: true });
    expect(t.of("message.cancelled").flatMap((e) => e.messageIds)).toEqual([3]);
    expect(t.of("message.requeued").flatMap((e) => e.messageIds)).toEqual([2]);
    expect(await t.waitFor("turn.ended", () => true, 2)).toMatchObject({ messageIds: [4] });
    const inputs = t.rpcIn().filter((r) => r.method === "turn/start").map((r) => (r.params as { input: Array<{ text: string }> }).input[0]!.text);
    expect(inputs).toEqual(["开始", "【Worker #2 的汇报】B"]);
  });

  it("点了停止、这一轮还没收尾：新消息排队，不 steer", async () => {
    const t = steerHarness((dir) => [holdTurn(dir), { messageDeltas: ["好"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    const stopping = t.driver.interrupt(s.id);
    await expect(t.driver.send(s.id, user(2, "换个做法"))).resolves.toEqual({ kind: "queued" });
    await stopping;
    await t.waitFor("turn.ended", () => true, 2);
    expect(methods(t)).not.toContain("turn/steer");
    expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1], [2]]);
  });

  it("进程崩了：处理中的那条照旧算崩溃，steer 了没读到的出 message.requeued", async () => {
    const t = steerHarness((dir) => [holdTurn(dir), { messageDeltas: ["好"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await t.driver.send(s.id, user(2, "插一句"));
    process.kill(t.store.get(s.id)!.pid!, "SIGKILL");
    expect(await t.waitFor("session.exited")).toMatchObject({ reason: "crash", messageIds: [1] });
    expect(t.of("message.requeued")).toEqual([expect.objectContaining({ messageIds: [2] })]);
    expect(t.of("message.cancelled")).toEqual([]);
  });

  it("设置在这一轮里变了：steer 照旧发给现在的进程（不重启）；这一轮结束后下一条才重启", async () => {
    const t = steerHarness((dir) => [holdTurn(dir), { messageDeltas: ["好"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    t.setReadonly(s.id, true);
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    release(t.dir);
    await t.waitFor("turn.ended");
    expect(t.log().filter((e) => e.kind === "argv")).toHaveLength(1);
    await t.driver.send(s.id, user(3, "下一条"));
    await t.waitFor("turn.ended", () => true, 2);
    expect(t.log().filter((e) => e.kind === "argv")).toHaveLength(2);
  });

  for (const reply of ["ok", "error"] as const) {
    it(`steer 的回执晚于这一轮的 turn/completed（回执${reply === "ok" ? "成功" : "报错"}）：end 照样返回，进程关掉；这条没送达`, async () => {
      const t = steerHarness((dir) => [holdTurn(dir, { deferSteerReply: reply }), { messageDeltas: ["收到"] }]);
      const s = t.addSession();
      await t.driver.send(s.id, user(1, "开始"));
      await t.waitFor("agent.tool");
      // 先挂上断言：send 会在 end 返回之前就 reject
      const sent = expect(t.driver.send(s.id, user(2, "插一句"))).rejects.toMatchObject({ code: "session_ended" });
      const ending = t.driver.end(s.id);
      release(t.dir);
      await ending;
      expect(t.store.get(s.id)!.status).toBe("ended");
      await sent;
      expect(t.of("turn.ended").map((e) => e.messageIds)).toEqual([[1]]);
      expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
      expect(methods(t).filter((m) => m === "turn/start")).toHaveLength(1);
    });
  }

  it("steer 的回执晚于这一轮结束、没有 end：这条退回自己的队列，下一轮用 turn/start 发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { deferSteerReply: "ok" }), { messageDeltas: ["收到"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    const sending = t.driver.send(s.id, user(2, "插一句"));
    release(t.dir);
    // 回执到时这一轮已经结束：放回待发队列，马上用 turn/start 发（执行器下次再问就是 written）
    await expect(sending).resolves.toEqual({ kind: "queued" });
    expect(await t.waitFor("turn.ended", () => true, 2)).toMatchObject({ ok: true, messageIds: [2] });
    expect(t.of("message.delivered").map((e) => [e.messageIds, e.midTurn])).toEqual([
      [[1], undefined],
      [[2], undefined],
    ]);
  });

  it("停止时 steer 的回执还没到，回执（成功）在 turn/completed interrupted 之后才来：用户消息标已取消、send 返回 cancelled，不再发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { deferSteerReply: "ok" }), { messageDeltas: ["不该跑"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    const sending = t.driver.send(s.id, user(2, "插一句"));
    await t.driver.interrupt(s.id);
    await expect(sending).resolves.toEqual({ kind: "cancelled" });
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1], interrupted: true });
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    await realSleepCodex(150);
    expect(methods(t).filter((m) => m === "turn/start")).toHaveLength(1);
    expect(t.of("message.delivered").map((e) => e.messageIds)).toEqual([[1]]);
    expect(t.of("message.requeued")).toEqual([]);
  });

  it("停止时 steer 的回执还没到（回执报错）：系统消息（Worker 汇报）不取消，停止后照常用 turn/start 发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { deferSteerReply: "error" }), { messageDeltas: ["收到汇报"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    const sending = t.driver.send(s.id, { messageIds: [2], source: "system" as const, text: "【Worker #1 的汇报】A" });
    await t.driver.interrupt(s.id);
    await expect(sending).resolves.toEqual({ kind: "queued" });
    expect(await t.waitFor("turn.ended", () => true, 2)).toMatchObject({ ok: true, messageIds: [2] });
    expect(t.of("message.cancelled")).toEqual([]);
  });

  it("点了停止、turn/interrupt 还没结果时进程崩了：steer 了没读到的用户消息标已取消，不收回重发", async () => {
    const t = steerHarness((dir) => [holdTurn(dir, { ignoreInterrupt: true }), { messageDeltas: ["不该跑"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    const stopping = t.driver.interrupt(s.id);
    process.kill(t.store.get(s.id)!.pid!, "SIGKILL");
    await stopping;
    expect(await t.waitFor("session.exited")).toMatchObject({ reason: "crash", messageIds: [1] });
    expect(t.of("message.cancelled")).toEqual([expect.objectContaining({ messageIds: [2], reason: "stop" })]);
    expect(t.of("message.requeued")).toEqual([]);
  });
});

const realSleepCodex = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("CodexDriver 性格设定、模式改了不重启（下一条前面加说明）", () => {
  let f: PersonaFixture | undefined;
  afterEach(() => {
    f?.cleanup();
    f = undefined;
  });
  function personaHarness(turns: (dir: string) => FakeCodexTurnScript[] = () => [], driver: Partial<CodexDriverOptions> = {}): CodexTestHarness {
    f = makePersonaFixture();
    const t = makeCodexHarness({ driver: { personaNote: f.personaNote, ...driver }, personaRevision: f.revision });
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ turns: turns(t.dir) }));
    return t;
  }
  /** 交给 codex 的每一条（turn/start、turn/steer）的文字。 */
  const inputs = (t: CodexTestHarness) =>
    t
      .rpcIn()
      .filter((r) => r.method === "turn/start" || r.method === "turn/steer")
      .map((r) => (r.params as { input: Array<{ text: string }> }).input[0]!.text);
  const procs = (t: CodexTestHarness) => t.log().filter((e) => e.kind === "argv");
  async function turn(t: CodexTestHarness, sessionId: SessionId, id: number, text: string, n: number): Promise<void> {
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
    expect(procs(t)).toHaveLength(1);
    const [, second, third] = inputs(t);
    expect(second).toMatch(/^【系统】你的性格设定刚更新了，以下面这份为准：/);
    expect(second).toContain("以后回复都用列表。");
    expect(second!.endsWith("\n\n二")).toBe(true);
    expect(third).toBe("三");
  });

  it("连改两次：只带最新的一份", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "第一版" });
    f!.userEdit({ text: "第二版" });
    await turn(t, s.id, 2, "二", 2);
    expect(inputs(t)[1]).toContain("第二版");
    expect(inputs(t)[1]).not.toContain("第一版");
  });

  it("改模型还是重启（thread/resume）；恢复的线程按沿用最初的说明算，同时改的性格设定照样带", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "新习惯" });
    t.store.rows.set(s.id, { ...t.store.get(s.id)!, model: "gpt-5.5" });
    await turn(t, s.id, 2, "二", 2);
    expect(procs(t)).toHaveLength(2);
    expect(t.rpcIn().filter((r) => r.method === "thread/resume")).toHaveLength(1);
    expect(inputs(t)[1]!.startsWith(`${RELAUNCH_NOTE}\n\n【系统】你的性格设定刚更新了`)).toBe(true);
    expect(inputs(t)[1]).toContain("新习惯");
  });

  it("闲置关闭后 thread/resume 再起来：照样带说明、只带一次", async () => {
    const t = personaHarness(() => [], { idleCloseMs: 50 });
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    await t.waitFor("session.exited");
    f!.userEdit({ text: "新习惯" });
    await turn(t, s.id, 2, "二", 2);
    await turn(t, s.id, 3, "三", 3);
    expect(procs(t)).toHaveLength(2);
    expect(t.rpcIn().filter((r) => r.method === "thread/resume")).toHaveLength(1);
    expect(inputs(t)[1]).toContain("新习惯");
    expect(inputs(t)[2]).toBe("三");
    expect(t.store.get(s.id)!.personaRevision).toBe(f!.revision());
  });

  it("新线程（thread/start；thread/resume 找不到线程退回 thread/start 也算）：按最新的拼，不带说明", async () => {
    const t = personaHarness(() => [], { idleCloseMs: 50 });
    const s = t.addSession();
    f!.userEdit({ text: "第一版" });
    await turn(t, s.id, 1, "一", 1);
    expect(inputs(t)[0]).toBe("一");
    await t.waitFor("session.exited");
    f!.userEdit({ text: "第二版" });
    writeFileSync(join(t.dir, "script.json"), JSON.stringify({ failResumeWith: "no rollout found" }));
    await turn(t, s.id, 2, "二", 2);
    expect(t.rpcIn().filter((r) => r.method === "thread/start")).toHaveLength(2);
    // 拼这一条时还以为会恢复，带上了说明（多带一次无害）；之后的不再带
    await turn(t, s.id, 3, "三", 3);
    expect(inputs(t)[2]).toBe("三");
  });

  it("撤销：带撤销后的内容", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.userEdit({ text: "新习惯" });
    await turn(t, s.id, 2, "二", 2);
    f!.revert();
    await turn(t, s.id, 3, "三", 3);
    expect(inputs(t)[2]).toMatch(/^【系统】你的性格设定刚更新了/);
    expect(inputs(t)[2]).toContain("小林的习惯");
    expect(procs(t)).toHaveLength(1);
  });

  it("项目经理自己 hub persona edit 改的：只带一句已生效", async () => {
    const t = personaHarness();
    const s = t.addSession();
    await turn(t, s.id, 1, "一", 1);
    f!.selfEdit("我自己记的");
    await turn(t, s.id, 2, "二", 2);
    expect(inputs(t)[1]).toBe("【系统】你刚改的性格设定已生效。\n\n二");
  });

  it("turn/steer 中途交的那条带上；停止时没读到，下一条再带", async () => {
    const t = personaHarness((dir) => [{ holdFile: join(dir, "go1"), messageDeltas: ["完"] }, { holdFile: join(dir, "go2"), messageDeltas: ["完"] }, { messageDeltas: ["好"] }]);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "开始"));
    await t.waitFor("agent.tool");
    f!.userEdit({ text: "第一版" });
    await expect(t.driver.send(s.id, user(2, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(inputs(t)[1]).toContain("第一版");
    writeFileSync(join(t.dir, "go1"), "");
    expect(await t.waitFor("turn.ended")).toMatchObject({ messageIds: [1, 2] });
    await t.driver.send(s.id, user(3, "再开始"));
    await t.waitFor("agent.tool", undefined, 2);
    f!.userEdit({ text: "第二版" });
    await expect(t.driver.send(s.id, user(4, "插一句"))).resolves.toEqual({ kind: "written", midTurn: true });
    expect(inputs(t)[3]).toContain("第二版");
    await t.driver.interrupt(s.id);
    await t.waitFor("message.cancelled");
    await t.waitFor("turn.ended", undefined, 2);
    await turn(t, s.id, 5, "五", 3);
    expect(inputs(t).at(-1)).toContain("第二版");
    expect(inputs(t).at(-1)!.endsWith("\n\n五")).toBe(true);
    expect(procs(t)).toHaveLength(1);
  });
});

describe("codex-protocol 可写范围纯函数", () => {
  const scope = { dataDir: "/Users/u/.agent-hub", writableDirs: ["/Users/u/.agent-hub/worktrees/1/2"] };
  const context = { readonly: false, writeScope: scope, cwd: "/Users/u/.agent-hub/worktrees/1/2" };

  it("改名（*** Move to:）的目标也算要改的文件：源在自己的工作目录、目标是 state/hub.sqlite → decline（审查用 tsx 复现过 accept）", () => {
    const item = { changes: [{ path: "/Users/u/.agent-hub/worktrees/1/2/a.txt", kind: { type: "update", move_path: "/Users/u/.agent-hub/state/hub.sqlite" } }] };
    expect(extractFileChangePaths(item)).toEqual(["/Users/u/.agent-hub/worktrees/1/2/a.txt", "/Users/u/.agent-hub/state/hub.sqlite"]);
    expect(decideFileChangeApproval(item, context)).toBe("decline");
    expect(decideFileChangeApproval({ changes: [{ path: "a.txt", kind: { type: "update", move_path: "b.txt" } }] }, context)).toBe("accept");
    expect(decideFileChangeApproval({ changes: [{ path: "a.txt", kind: { type: "update", move_path: null } }] }, context)).toBe("accept");
  });

  it("grantRoot 落在范围外就拒", () => {
    expect(decideFileChangeApproval({ paths: ["a.txt"], grantRoot: "/Users/u/.agent-hub" }, context)).toBe("decline");
    expect(decideFileChangeApproval({ paths: ["a.txt"], grantRoot: "/Users/u/.agent-hub/worktrees/1/2" }, context)).toBe("accept");
    expect(decideFileChangeApproval({ paths: ["a.txt"], grantRoot: "/tmp" }, context)).toBe("accept");
  });

  it("sandboxPolicy：包进了 OS 沙箱用 externalSandbox；只读照用 readOnly；没包用 workspaceWrite", () => {
    const session = { cwd: "/Users/u/.agent-hub/worktrees/1/2", addDirs: ["/Users/u/.agent-hub/worktrees/1/3", "/x"] };
    expect(buildSandboxPolicy(session, false, scope, true)).toEqual({ type: "externalSandbox", networkAccess: "enabled" });
    expect(buildSandboxPolicy(session, true, scope, true)).toEqual({ type: "readOnly", networkAccess: true });
    expect(buildSandboxPolicy(session, false, scope, false)).toEqual({ type: "workspaceWrite", networkAccess: true, writableRoots: [session.cwd, "/x"] });
  });
});

describe("CodexDriver 换代后的开场说明（session-preamble.ts）", () => {
  /** 交给 codex 的每一条（turn/start、turn/steer）的文字。 */
  const inputs = (t: CodexTestHarness) =>
    t
      .rpcIn()
      .filter((r) => r.method === "turn/start" || r.method === "turn/steer")
      .map((r) => (r.params as { input: Array<{ text: string }> }).input[0]!.text);

  it("第一条写进去的前面带一次，之后不带；带着它的那一行处理中带 preamble 标记", async () => {
    const ledger = fakePreambleLedger();
    const t = makeCodexHarness({ driver: { sessionPreamble: ledger.sessionPreamble } });
    ledger.watch(t.driver);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "接着说"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, { messageIds: [2], source: "system", text: "汇报" });
    await t.waitFor("turn.ended", undefined, 2);
    expect(inputs(t)).toEqual([`${PREAMBLE}\n\n接着说`, "汇报"]);
    expect(t.of("message.processing").map((e) => e.preamble ?? false)).toEqual([true, false]);
  });

  it("命令那一行不带，留给下一条", async () => {
    const ledger = fakePreambleLedger();
    const t = makeCodexHarness({ driver: { sessionPreamble: ledger.sessionPreamble } });
    ledger.watch(t.driver);
    const s = t.addSession();
    await t.driver.send(s.id, user(1, "/compact"));
    await t.waitFor("turn.ended");
    await t.driver.send(s.id, user(2, "二"));
    await t.waitFor("turn.ended", undefined, 2);
    expect(inputs(t).at(-1)).toBe(`${PREAMBLE}\n\n二`);
  });
});

describe("找不到 codex 程序", () => {
  it("send 抛可重试的 DriverError(codex_not_found)，不是 claude_not_found", async () => {
    const t = makeCodexHarness({ driver: { codexPath: "/nonexistent/codex" } });
    activeHarness = t;
    const s = t.addSession();
    const err = await t.driver.send(s.id, user(1, "hi")).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("codex_not_found");
    expect((err as { retryable?: boolean }).retryable).toBe(true);
  });
});
