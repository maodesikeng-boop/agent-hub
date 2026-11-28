import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonLog } from "../../../../test/append-log.ts";
import { writeExecutableNodeScript } from "../../../../test/fake-cli-shim.ts";

interface FakePiToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  argDeltas?: string[];
  partialShape?: boolean;
  output?: string;
  isError?: boolean;
}

interface FakePiTurnScript {
  disposition?: "started" | "handled";
  failPromptError?: string;
  thinkingDeltas?: string[];
  tools?: FakePiToolCall[];
  holdFile?: string;
  waitForAbort?: boolean;
  abortOnSigint?: boolean;
  ignoreAbort?: boolean;
  blockingUiMethod?: "select" | "confirm" | "input" | "editor";
  autoRetry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
  textDeltas?: string[];
  finalText?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  contextTokens?: number | null;
  errorMessage?: string;
  dropSteers?: boolean;
  rejectSteer?: boolean;
}

export interface FakePiScript {
  listModelsStdout?: string;
  listModelsStderr?: string;
  listModelsExitCode?: number;
  listModelsDelayMs?: number;
  failForkNotFound?: boolean;
  hangOnStart?: boolean;
  exitBeforeReadyCode?: number;
  exitBeforeReadyStderr?: string;
  failGetStateError?: string;
  activeModel?: { provider: string; id: string } | string;
  commands?: Array<{ name: string; description?: string; source?: string; argumentHint?: string }>;
  hangGetCommands?: boolean;
  initialTokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  initialContextTokens?: number | null;
  writeSessionFile?: boolean;
  turns?: FakePiTurnScript[];
  ignoreStdinEnd?: boolean;
  ignoreSigint?: boolean;
}

export interface FakePiLogEntry {
  kind: "argv" | "rpc_in" | "rpc_out" | "signal";
  pid: number;
  argv?: string[];
  cwd?: string;
  envSnapshot?: Record<string, string | undefined>;
  msg?: Record<string, unknown>;
  signal?: string;
}

const FAKE_PI_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const logFile = process.env.FAKE_PI_LOG;
const scriptFile = process.env.FAKE_PI_SCRIPT;
const script = scriptFile && fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : {};

function appendLog(entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  } catch {}
}

const argv = process.argv.slice(2);
appendLog({
  kind: "argv",
  argv,
  cwd: process.cwd(),
  envSnapshot: {
    HUB_TOKEN: process.env.HUB_TOKEN,
    HUB_SOCK: process.env.HUB_SOCK,
    TMPDIR: process.env.TMPDIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  },
});

if (argv.includes("--list-models")) {
  const finishList = () => {
    if (script.listModelsStderr) process.stderr.write(String(script.listModelsStderr));
    if (typeof script.listModelsStdout === "string") {
      process.stdout.write(script.listModelsStdout);
    } else {
      process.stdout.write("No models available. Use /login to log into a provider via OAuth or API key.\n");
    }
    process.exit(typeof script.listModelsExitCode === "number" ? script.listModelsExitCode : 0);
  };
  if (typeof script.listModelsDelayMs === "number" && script.listModelsDelayMs > 0) {
    setTimeout(finishList, script.listModelsDelayMs);
  } else {
    finishList();
  }
  return;
}

const forkIdx = argv.indexOf("--fork");
if (forkIdx >= 0 && script.failForkNotFound) {
  const target = argv[forkIdx + 1] || "";
  process.stderr.write("Error: No session found matching '" + target + "'\n");
  process.exit(1);
}

if (typeof script.exitBeforeReadyCode === "number") {
  if (script.exitBeforeReadyStderr) process.stderr.write(String(script.exitBeforeReadyStderr));
  process.exit(script.exitBeforeReadyCode);
}

process.on("SIGINT", () => {
  appendLog({ kind: "signal", signal: "SIGINT" });
  if (script.ignoreSigint) return;
  if (currentTurn?.turnScript.abortOnSigint) abortCurrentTurn();
  process.stdout.write("", () => process.exit(0));
});

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function encodeDirName(cwd) {
  return "--" + cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") + "--";
}

function resolveSessionsRoot() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  const cfg = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(cfg, "sessions");
}

const explicitSessionPath = argValue("--session");
let sessionId = argValue("--session-id") || "pi-default-session";
if (explicitSessionPath) {
  const base = path.basename(explicitSessionPath, ".jsonl");
  const us = base.lastIndexOf("_");
  if (us >= 0) sessionId = base.slice(us + 1);
}

let sessionFile = explicitSessionPath;
if (!sessionFile) {
  const dir = path.join(resolveSessionsRoot(), encodeDirName(process.cwd()));
  sessionFile = path.join(dir, "2026-11-11T00-00-00-000Z_" + sessionId + ".jsonl");
}

if (script.writeSessionFile !== false && !argv.includes("--no-session")) {
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n",
      );
    }
  } catch {}
}

function send(obj) {
  appendLog({ kind: "rpc_out", msg: obj });
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const cumulativeTokens = {
  input: script.initialTokens?.input || 0,
  output: script.initialTokens?.output || 0,
  cacheRead: script.initialTokens?.cacheRead || 0,
  cacheWrite: script.initialTokens?.cacheWrite || 0,
};
let currentContextTokens =
  typeof script.initialContextTokens === "number" ? script.initialContextTokens : null;

let turnCursor = 0;
let currentTurn = null;
let steeredQueue = [];
let waitingUiResolver = null;

function pickTurnScript() {
  const turns = Array.isArray(script.turns) ? script.turns : [];
  if (turns.length === 0) {
    return { textDeltas: ["ok"], usage: { input: 10, output: 5 }, contextTokens: 15 };
  }
  const idx = Math.min(turnCursor, turns.length - 1);
  turnCursor += 1;
  return turns[idx];
}

function abortCurrentTurn() {
  if (!currentTurn || currentTurn.aborted) return;
  if (currentTurn.turnScript.ignoreAbort) return;
  currentTurn.aborted = true;
  if (currentTurn.pollTimer) clearInterval(currentTurn.pollTimer);
  const partialMsg = {
    role: "assistant",
    content: [],
    stopReason: "aborted",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  send({ type: "message_end", message: partialMsg });
  send({ type: "turn_end", message: partialMsg, toolResults: [] });
  send({ type: "agent_end", messages: [partialMsg], willRetry: false });
  currentTurn = null;
  steeredQueue = [];
  send({ type: "agent_settled", aborted: true });
}

async function executeTurn(promptText, turnScript) {
  const state = { turnScript, aborted: false, pollTimer: null };
  currentTurn = state;

  send({ type: "agent_start" });
  send({ type: "turn_start" });
  const userMsg = { role: "user", content: promptText, timestamp: Date.now() };
  send({ type: "message_start", message: userMsg });
  send({ type: "message_end", message: userMsg });

  if (turnScript.autoRetry) {
    send({
      type: "auto_retry_start",
      attempt: turnScript.autoRetry.attempt,
      maxAttempts: turnScript.autoRetry.maxAttempts,
      delayMs: turnScript.autoRetry.delayMs,
      errorMessage: turnScript.autoRetry.errorMessage,
    });
  }

  if (turnScript.blockingUiMethod) {
    const uiId = "ui-req-1";
    await new Promise((resolve) => {
      waitingUiResolver = { id: uiId, resolve };
      send({
        type: "extension_ui_request",
        id: uiId,
        method: turnScript.blockingUiMethod,
        title: "Untrusted confirmation",
      });
    });
    if (state.aborted) return;
  }

  send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });

  const thinkingDeltas = turnScript.thinkingDeltas || [];
  let contentIndex = 0;
  const contentBlocks = [];

  if (thinkingDeltas.length > 0) {
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex } });
    for (const d of thinkingDeltas) {
      send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: d } });
    }
    const fullThinking = thinkingDeltas.join("");
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex, content: fullThinking } });
    contentBlocks.push({ type: "thinking", thinking: fullThinking });
    contentIndex += 1;
  }

  const tools = turnScript.tools || [];
  for (const t of tools) {
    const args = t.arguments || {};
    if (t.partialShape) {
      const partialBlocks = [...contentBlocks, { type: "toolCall", id: t.id, name: t.name, arguments: {} }];
      send({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex,
          partial: { role: "assistant", content: partialBlocks },
        },
      });
    } else {
      send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex, id: t.id, toolName: t.name } });
    }
    for (const d of t.argDeltas || []) {
      send({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta: d },
      });
    }
    send({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex,
        toolCall: { type: "toolCall", id: t.id, name: t.name, arguments: args },
      },
    });
    contentBlocks.push({ type: "toolCall", id: t.id, name: t.name, arguments: args });
    contentIndex += 1;
    send({ type: "tool_execution_start", toolCallId: t.id, toolName: t.name, args });
    if (!turnScript.holdFile && !turnScript.waitForAbort) {
      send({
        type: "tool_execution_end",
        toolCallId: t.id,
        toolName: t.name,
        result: { content: [{ type: "text", text: t.output || "ok" }], details: {} },
        isError: Boolean(t.isError),
        durationMs: 2,
      });
    }
  }

  if (turnScript.waitForAbort) {
    await new Promise((resolve) => {
      state.pollTimer = setInterval(() => {
        if (state.aborted) {
          clearInterval(state.pollTimer);
          resolve();
        }
      }, 10);
    });
    return;
  }

  if (turnScript.holdFile) {
    await new Promise((resolve) => {
      state.pollTimer = setInterval(() => {
        if (state.aborted || fs.existsSync(turnScript.holdFile)) {
          clearInterval(state.pollTimer);
          resolve();
        }
      }, 10);
    });
    if (state.aborted) return;
    for (const t of tools) {
      send({
        type: "tool_execution_end",
        toolCallId: t.id,
        toolName: t.name,
        result: { content: [{ type: "text", text: t.output || "ok" }], details: {} },
        isError: Boolean(t.isError),
        durationMs: 5,
      });
    }
  }

  // 若工具运行期间有中途 steer 排队且不丢弃，作为同一轮后续 user message 消费
  if (steeredQueue.length > 0 && !turnScript.dropSteers) {
    const taken = steeredQueue.splice(0);
    for (const s of taken) {
      const steerMsg = { role: "user", content: s.message, timestamp: Date.now() };
      send({ type: "message_start", message: steerMsg });
      send({ type: "message_end", message: steerMsg });
    }
  }

  const textDeltas = turnScript.textDeltas || [];
  const finalText = typeof turnScript.finalText === "string" ? turnScript.finalText : textDeltas.join("");
  const usageRaw = {
    input: turnScript.usage?.input ?? 12,
    output: turnScript.usage?.output ?? 6,
    cacheRead: turnScript.usage?.cacheRead ?? 0,
    cacheWrite: turnScript.usage?.cacheWrite ?? 0,
  };

  if (textDeltas.length > 0 || finalText !== "") {
    send({ type: "message_update", usage: usageRaw, assistantMessageEvent: { type: "text_start", contentIndex } });
    for (const d of textDeltas) {
      send({ type: "message_update", usage: usageRaw, assistantMessageEvent: { type: "text_delta", contentIndex, delta: d } });
    }
    send({ type: "message_update", usage: usageRaw, assistantMessageEvent: { type: "text_end", contentIndex, content: finalText } });
    contentBlocks.push({ type: "text", text: finalText });
  }

  cumulativeTokens.input += usageRaw.input;
  cumulativeTokens.output += usageRaw.output;
  cumulativeTokens.cacheRead += usageRaw.cacheRead;
  cumulativeTokens.cacheWrite += usageRaw.cacheWrite;
  if (turnScript.contextTokens !== undefined) {
    currentContextTokens = turnScript.contextTokens;
  } else {
    currentContextTokens = usageRaw.input + usageRaw.cacheRead + usageRaw.cacheWrite + usageRaw.output;
  }

  const assistantMsg = {
    role: "assistant",
    content: contentBlocks,
    usage: usageRaw,
    stopReason: turnScript.errorMessage ? "error" : "stop",
    ...(turnScript.errorMessage ? { errorMessage: turnScript.errorMessage } : {}),
  };
  send({ type: "message_end", message: assistantMsg });
  send({ type: "turn_end", message: assistantMsg, toolResults: [] });
  send({ type: "agent_end", messages: [assistantMsg], willRetry: false });

  currentTurn = null;
  steeredQueue = [];
  send({ type: "agent_settled", aborted: false });
}

function handleRpc(msg) {
  appendLog({ kind: "rpc_in", msg });

  if (msg.type === "extension_ui_response") {
    if (waitingUiResolver && waitingUiResolver.id === msg.id) {
      const r = waitingUiResolver.resolve;
      waitingUiResolver = null;
      r(msg);
    }
    return;
  }

  const id = msg.id;

  switch (msg.type) {
    case "get_state": {
      if (script.hangOnStart) return;
      if (script.failGetStateError) {
        send({ id, type: "response", command: "get_state", success: false, error: script.failGetStateError });
        return;
      }
      send({
        id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId,
          sessionFile,
          model: script.activeModel || { provider: "deepseek", id: "deepseek-v4-pro" },
        },
      });
      return;
    }

    case "get_session_stats": {
      const total =
        cumulativeTokens.input +
        cumulativeTokens.output +
        cumulativeTokens.cacheRead +
        cumulativeTokens.cacheWrite;
      send({
        id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: {
          sessionId,
          sessionFile,
          tokens: { ...cumulativeTokens, total },
          ...(currentContextTokens !== null
            ? { contextUsage: { tokens: currentContextTokens, contextWindow: 1000000, percent: 10 } }
            : {}),
        },
      });
      return;
    }

    case "get_commands": {
      if (script.hangGetCommands) return;
      const cmds = script.commands || [
        { name: "skill:demo-skill", description: "Demo skill", source: "skill" },
        { name: "review", description: "Code review template", argumentHint: "<file>" },
      ];
      send({ id, type: "response", command: "get_commands", success: true, data: { commands: cmds } });
      return;
    }

    case "clear_queue": {
      const cleared = steeredQueue.splice(0).map((s) => s.message);
      send({
        id,
        type: "response",
        command: "clear_queue",
        success: true,
        data: { steering: cleared, followUp: [] },
      });
      return;
    }

    case "abort": {
      abortCurrentTurn();
      send({ id, type: "response", command: "abort", success: true });
      return;
    }

    case "compact": {
      send({ type: "compaction_start", reason: "manual" });
      const result = {
        summary: "Compacted conversation" + (msg.customInstructions ? ": " + msg.customInstructions : ""),
        tokensBefore: currentContextTokens || 180000,
        estimatedTokensAfter: 24000,
      };
      currentContextTokens = 24000;
      send({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      send({ id, type: "response", command: "compact", success: true, data: result });
      return;
    }

    case "prompt": {
      if (currentTurn) {
        if (msg.streamingBehavior === "steer") {
          if (currentTurn.turnScript.rejectSteer) {
            send({ id, type: "response", command: "prompt", success: false, error: "Steer rejected" });
            return;
          }
          steeredQueue.push({ message: msg.message });
          send({ id, type: "response", command: "prompt", success: true, data: { disposition: "queued" } });
          return;
        }
        send({
          id,
          type: "response",
          command: "prompt",
          success: false,
          error: "Agent is already streaming; specify streamingBehavior",
        });
        return;
      }

      const turnScript = pickTurnScript();
      if (turnScript.failPromptError) {
        send({ id, type: "response", command: "prompt", success: false, error: turnScript.failPromptError });
        return;
      }
      const disposition = turnScript.disposition || "started";
      send({ id, type: "response", command: "prompt", success: true, data: { disposition } });
      if (disposition === "handled") return;
      setImmediate(() => {
        void executeTurn(msg.message, turnScript);
      });
      return;
    }
  }
}

// 严格按 \n 切分 JSONL（不将 U+2028 / U+2029 视作行边界）
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.trim() !== "") {
      handleRpc(JSON.parse(line));
    }
  }
});
process.stdin.on("end", () => {
  if (script.ignoreStdinEnd) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
`;

export interface FakePiFiles {
  binPath: string;
  scriptPath: string;
  logPath: string;
  updateScript(next: FakePiScript): void;
  readLogs(): FakePiLogEntry[];
}

export function writeFakePiBinary(dir: string, initialScript: FakePiScript = {}): FakePiFiles {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "fake-pi-script.json");
  const logPath = join(dir, "fake-pi.log");
  writeFileSync(scriptPath, JSON.stringify(initialScript));
  const binPath = writeExecutableNodeScript(join(dir, "fake-pi"), FAKE_PI_SOURCE);

  return {
    binPath,
    scriptPath,
    logPath,
    updateScript(next: FakePiScript) {
      writeFileSync(scriptPath, JSON.stringify(next));
    },
    readLogs(): FakePiLogEntry[] {
      return readJsonLog<FakePiLogEntry>(logPath);
    },
  };
}
