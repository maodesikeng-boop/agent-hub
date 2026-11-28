import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonLog } from "../../../test/append-log.ts";
import { wrapScriptAsPlatformCli, writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { writeExecutableFileAtomicSync } from "../platform/index.ts";
import {
  EMPTY_TOKEN_USAGE,
  type AgentSessionRow,
  type AgentVendor,
  type ConversationId,
  type Driver,
  type DriverEvent,
  type LaunchFiles,
  type SessionId,
} from "../../shared/index.ts";
import type { FakeAcpScript } from "../../vendors/_common/acp/fixtures/fake-acp-agent.ts";
import { createCodexDriver, type CodexDriver, type CodexDriverOptions } from "../../vendors/codex/driver.ts";
import { createCursorDriver } from "../../vendors/cursor/driver.ts";
import { createDeepSeekDriver } from "../../vendors/deepseek/driver.ts";
import { createKimiDriver } from "../../vendors/kimi/driver.ts";
import { createOpenCodeDriver } from "../../vendors/opencode/driver.ts";
import { createPiDriver, type PiDriver, type PiDriverOptions } from "../../vendors/pi/driver.ts";
import { writeFakePiBinary, type FakePiLogEntry, type FakePiScript } from "../../vendors/pi/fixtures/fake-pi.ts";
import { MemorySessionStore } from "./test-helpers.ts";

const FAKE_ACP_AGENT = fileURLToPath(new URL("../../vendors/_common/acp/fixtures/fake-acp-agent.ts", import.meta.url));

export type OtherAcpVendor = "cursor" | "deepseek" | "kimi" | "opencode";

export interface FakeCodexStopTurn {
  waitForInterrupt?: boolean;
  ignoreInterrupt?: boolean;
  holdTurnStartFile?: string;
  failTurnStartError?: string;
  replyText?: string;
}

export interface FakeCodexStopScript {
  ignoreSigint?: boolean;
  turns?: FakeCodexStopTurn[];
}

export interface FakeCodexStopLog {
  kind: "rpc_in" | "signal";
  method?: string;
  signal?: string;
}

const FAKE_CODEX_STOP_SOURCE = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");

const logFile = process.env.FAKE_CODEX_LOG;
const scriptFile = process.env.FAKE_CODEX_SCRIPT;
const script = scriptFile && fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : {};

function appendLog(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

process.on("SIGINT", () => {
  appendLog({ kind: "signal", signal: "SIGINT" });
  if (script.ignoreSigint) return;
  process.stdout.write("", () => process.exit(0));
});

let threadId = "thread-stop-1";
let turnIndex = 0;
let activeTurn = null;

function runTurn(reqId, turnScript) {
  const turnId = "turn-" + turnIndex;
  send({ jsonrpc: "2.0", id: reqId, result: { turn: { id: turnId } } });
  send({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } });
  send({
    jsonrpc: "2.0",
    method: "item/started",
    params: { threadId, turnId, item: { id: "msg-" + turnId, type: "agentMessage" } },
  });
  send({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "msg-" + turnId, delta: turnScript.replyText || "working" },
  });
  if (turnScript.waitForInterrupt || turnScript.ignoreInterrupt) {
    activeTurn = { turnId, turnScript };
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId, turnId, item: { id: "msg-" + turnId, type: "agentMessage", text: turnScript.replyText || "ok" } },
  });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  appendLog({ kind: "rpc_in", method: msg.method });
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex/0.169.0", codexHome: process.cwd() } });
    return;
  }
  if (msg.method === "skills/extraRoots/set") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "thread/start") {
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, model: "gpt-5.4" } } });
    return;
  }
  if (msg.method === "turn/start") {
    const turns = Array.isArray(script.turns) ? script.turns : [];
    const turnScript = turns[Math.min(turnIndex, Math.max(0, turns.length - 1))] || {};
    turnIndex += 1;
    const respond = () => {
      if (turnScript.failTurnStartError) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: turnScript.failTurnStartError } });
        return;
      }
      runTurn(msg.id, turnScript);
    };
    if (turnScript.holdTurnStartFile) {
      const timer = setInterval(() => {
        if (!fs.existsSync(turnScript.holdTurnStartFile)) return;
        clearInterval(timer);
        respond();
      }, 10);
      return;
    }
    respond();
    return;
  }
  if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (activeTurn && !activeTurn.turnScript.ignoreInterrupt) {
      const { turnId } = activeTurn;
      activeTurn = null;
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } });
    }
  }
});
rl.on("close", () => process.exit(0));
`;

export function makeSessionRow(id: SessionId, vendor: AgentVendor, cwd: string): AgentSessionRow {
  const now = Date.now();
  return {
    id,
    conversationId: id as unknown as ConversationId,
    role: "pm",
    pmId: 1,
    workerId: null,
    vendor,
    vendorSessionId: "",
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
  };
}

export function createEventCollector(driver: Driver) {
  const events: DriverEvent[] = [];
  const waiters: Array<(ev: DriverEvent) => void> = [];
  driver.onEvent((_id, ev) => {
    events.push(ev);
    for (const w of [...waiters]) w(ev);
  });
  const waitFor = <T extends DriverEvent["type"]>(
    type: T,
    pred: (e: Extract<DriverEvent, { type: T }>) => boolean = () => true,
    count = 1,
  ): Promise<Extract<DriverEvent, { type: T }>> => {
    const match = () => events.filter((e): e is Extract<DriverEvent, { type: T }> => e.type === type && pred(e as never));
    const existing = match();
    if (existing.length >= count) return Promise.resolve(existing[count - 1]!);
    return new Promise((resolve) => {
      const check = () => {
        const hits = match();
        if (hits.length >= count) {
          const idx = waiters.indexOf(check);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(hits[count - 1]!);
        }
      };
      waiters.push(check);
    });
  };
  return { events, waitFor };
}

export function makeCodexStopHarness(options: {
  script?: FakeCodexStopScript;
  driver?: Partial<CodexDriverOptions>;
  prepareLaunch?: CodexDriverOptions["prepareLaunch"];
} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bellwood-codex-stop-")));
  const cwd = join(dir, "workspace");
  const promptFile = join(dir, "prompt.md");
  const scriptFile = join(dir, "script.json");
  const logFile = join(dir, "codex.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(promptFile, "Follow rules.", "utf8");
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}), "utf8");
  const binPath = writeExecutableNodeScript(join(dir, "fake-codex"), FAKE_CODEX_STOP_SOURCE, { cjs: true });
  const store = new MemorySessionStore();
  const driver: CodexDriver = createCodexDriver({
    executablePath: binPath,
    store,
    prepareLaunch:
      options.prepareLaunch ??
      (async (row) => ({ promptFile, env: {}, fingerprint: `fp-${row.id}` })),
    env: { FAKE_CODEX_SCRIPT: scriptFile, FAKE_CODEX_LOG: logFile },
    writeScopeSpawn: (base) => ({ ...base, osSandboxed: false }),
    ...options.driver,
  });
  const collector = createEventCollector(driver);
  const log = () => readJsonLog<FakeCodexStopLog>(logFile);
  return {
    dir,
    cwd,
    promptFile,
    store,
    driver,
    ...collector,
    log,
    async cleanup() {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makePiStopHarness(options: {
  script?: FakePiScript;
  driver?: Partial<PiDriverOptions>;
  prepareLaunch?: PiDriverOptions["prepareLaunch"];
} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bellwood-pi-stop-")));
  const cwd = join(dir, "workspace");
  const agentDir = join(dir, ".pi", "agent");
  const promptFile = join(dir, "prompt.md");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(promptFile, "Follow rules.", "utf8");
  const fake = writeFakePiBinary(dir, options.script ?? {});
  const store = new MemorySessionStore();
  const driver: PiDriver = createPiDriver({
    executablePath: fake.binPath,
    homeDir: dir,
    store,
    prepareLaunch:
      options.prepareLaunch ??
      (async (row) => ({ promptFile, env: { PI_CODING_AGENT_DIR: agentDir }, fingerprint: `fp-${row.id}` })),
    env: { FAKE_PI_LOG: fake.logPath, FAKE_PI_SCRIPT: fake.scriptPath, PI_CODING_AGENT_DIR: agentDir },
    writeScopeSpawn: (base) => ({ ...base, osSandboxed: true }),
    readonlySpawn: (base) => ({ ...base, osSandboxed: true }),
    ...options.driver,
  });
  const collector = createEventCollector(driver);
  const log = () => readJsonLog<FakePiLogEntry>(fake.logPath);
  return {
    dir,
    cwd,
    promptFile,
    store,
    driver,
    ...collector,
    log,
    async cleanup() {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeOtherAcpVendorHarness(
  vendor: OtherAcpVendor,
  options: {
    script?: FakeAcpScript;
    interruptGraceMs?: number;
    shutdownGraceMs?: number;
    prepareLaunch?: (row: AgentSessionRow) => Promise<LaunchFiles>;
  } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `bellwood-${vendor}-stop-`)));
  const cwd = join(dir, "workspace");
  const logDir = join(dir, "logs");
  const stateDir = join(dir, "state");
  const promptFile = join(dir, "prompt.md");
  const scriptFile = join(logDir, "script.json");
  const logFile = join(logDir, "fake-acp.jsonl");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(promptFile, "Follow rules.", "utf8");
  const script: FakeAcpScript = {
    modes: {
      currentModeId: "yolo",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "yolo", name: "Yolo" },
      ],
    },
    ...options.script,
  };
  writeFileSync(scriptFile, JSON.stringify(script), "utf8");
  const exePath =
    process.platform === "win32"
      ? wrapScriptAsPlatformCli(FAKE_ACP_AGENT, dir, `fake-${vendor}`)
      : (() => {
          const launcher = join(dir, `fake-${vendor}.mjs`);
          writeExecutableFileAtomicSync(
            launcher,
            `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(FAKE_ACP_AGENT).href)});\n`,
            { mode: 0o755 },
          );
          return launcher;
        })();
  const store = new MemorySessionStore();
  const baseOptions = {
    executablePath: exePath,
    store,
    env: {
      FAKE_ACP_SCRIPT: scriptFile,
      FAKE_ACP_LOG: logFile,
      FAKE_ACP_STATE: stateDir,
      KIMI_HOME: join(dir, ".kimi"),
      DSH_HOME: join(dir, ".dsh"),
    },
    prepareLaunch:
      options.prepareLaunch ??
      (async (row: AgentSessionRow): Promise<LaunchFiles> => ({
        promptFile,
        env: {},
        fingerprint: `fp-${row.id}`,
      })),
    interruptGraceMs: options.interruptGraceMs ?? 2_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 200,
    idleCloseMs: 60_000,
  };
  const driver: Driver =
    vendor === "cursor"
      ? createCursorDriver(baseOptions)
      : vendor === "deepseek"
        ? createDeepSeekDriver(baseOptions)
        : vendor === "kimi"
          ? createKimiDriver(baseOptions)
          : createOpenCodeDriver(baseOptions);
  const collector = createEventCollector(driver);
  return {
    dir,
    cwd,
    promptFile,
    store,
    driver,
    ...collector,
    async cleanup() {
      await driver.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
