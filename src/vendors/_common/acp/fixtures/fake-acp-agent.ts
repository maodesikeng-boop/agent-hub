#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentContext,
  type AvailableCommand,
  type PermissionOption,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type StopReason,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk/unstable";

export interface FakeAcpToolStep {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: ToolKind;
  rawInput?: unknown;
  locations?: Array<{ path: string }>;
  requestPermission?: {
    kind?: ToolKind;
    name?: string;
    title?: string;
    meta?: Record<string, unknown>;
    options?: PermissionOption[];
  };
  probeWritePath?: string;
  resultContent?: unknown;
  rawOutput?: unknown;
}

export interface FakeAcpTurnScript {
  thoughtChunks?: string[];
  textChunks?: Array<string | { text: string; messageId?: string }>;
  unterminatedOutputBytes?: number;
  toolCalls?: FakeAcpToolStep[];
  extensionRequests?: Array<{ method: string; params?: unknown }>;
  elicitation?: boolean;
  customUpdates?: Array<{ sessionUpdate: string; payload?: Record<string, unknown> }>;
  commandsUpdate?: Array<{ name: string; description: string; hint?: string }>;
  usageUpdate?: { used: number; size: number };
  waitForCancel?: boolean;
  ignoreCancel?: boolean;
  sleepMs?: number;
  spawnChildPidFile?: string;
  crashExitCode?: number;
  throwRpcError?: { code: number; message: string };
  stopReason?: StopReason;
  usage?: Usage;
}

export interface FakeAcpScript {
  loadSessionCapability?: boolean;
  resumeCapability?: boolean;
  closeCapability?: boolean;
  systemPromptCapability?: boolean;
  additionalDirectoriesCapability?: boolean;
  requireAuth?: boolean;
  failAuth?: boolean;
  authMethods?: Array<{ id: string; name: string }>;
  loadNotFound?: boolean;
  resumeNotFound?: boolean;
  knownSessions?: string[];
  modes?: SessionModeState;
  // OpenCode 2.3+ returns no modes field and exposes the mode only as a config option.
  omitModes?: boolean;
  initialConfigOptions?: SessionConfigOption[];
  // OpenCode answers an unlisted select value with -32602.
  rejectUnlistedConfigValues?: boolean;
  dynamicEffortForModel?: string;
  commandsOnSessionStart?: Array<{ name: string; description: string; hint?: string }>;
  replayOnLoad?: {
    userTexts?: string[];
    agentTexts?: string[];
    thoughtTexts?: string[];
    toolTitle?: string;
    commands?: Array<{ name: string; description: string; hint?: string }>;
  };
  hangOnInitialize?: boolean;
  hangOnAuthenticate?: boolean;
  hangOnNew?: boolean;
  resumeUnsupported?: boolean;
  cancelDelayMs?: number;
  ignoreSigint?: boolean;
  turns?: FakeAcpTurnScript[];
}

export interface FakeAcpLogEntry {
  event: string;
  pid: number;
  [key: string]: unknown;
}

const scriptPath = process.env.FAKE_ACP_SCRIPT;
const logPath = process.env.FAKE_ACP_LOG;
const stateDir = process.env.FAKE_ACP_STATE;

const script: FakeAcpScript =
  scriptPath && existsSync(scriptPath)
    ? (JSON.parse(readFileSync(scriptPath, "utf8")) as FakeAcpScript)
    : {};

function writeLog(entry: Omit<FakeAcpLogEntry, "pid">): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, "utf8");
  } catch {
  }
}

function sessionStateFile(sessionId: string): string | null {
  if (!stateDir) return null;
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    return null;
  }
  return join(stateDir, `session-${encodeURIComponent(sessionId)}.json`);
}

function hasSavedSession(sessionId: string): boolean {
  if (script.knownSessions?.includes(sessionId)) return true;
  const f = sessionStateFile(sessionId);
  return f !== null && existsSync(f);
}

function saveSession(sessionId: string, data: Record<string, unknown>): void {
  const f = sessionStateFile(sessionId);
  if (!f) return;
  try {
    writeFileSync(f, JSON.stringify(data), "utf8");
  } catch {
  }
}

function nextTurnIndex(sessionId: string): number {
  const f = sessionStateFile(`turns-${sessionId}`);
  if (!f) {
    const cur = inMemoryTurnCounts.get(sessionId) ?? 0;
    inMemoryTurnCounts.set(sessionId, cur + 1);
    return cur;
  }
  let cur = 0;
  try {
    if (existsSync(f)) {
      cur = Number(readFileSync(f, "utf8")) || 0;
    }
    writeFileSync(f, String(cur + 1), "utf8");
  } catch {
    cur = inMemoryTurnCounts.get(sessionId) ?? 0;
    inMemoryTurnCounts.set(sessionId, cur + 1);
  }
  return cur;
}

const inMemoryTurnCounts = new Map<string, number>();
let sessionSeq = 0;
let authenticated = false;

const DEFAULT_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-always", name: "Always Allow", kind: "allow_always" },
  { optionId: "allow-once", name: "Allow Once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject Once", kind: "reject_once" },
];

function flattenSelectValues(option: Extract<SessionConfigOption, { type: "select" }>): string[] {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options.map((o) => o.value) : [entry.value]));
}

function defaultConfigOptions(): SessionConfigOption[] {
  if (script.initialConfigOptions) return structuredClone(script.initialConfigOptions);
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "default-fast",
      options: [
        { value: "default-fast", name: "Default Fast" },
        { value: "reasoner-pro", name: "Reasoner Pro" },
      ],
    },
  ];
}

let currentConfigOptions: SessionConfigOption[] = defaultConfigOptions();
let currentModes: SessionModeState = script.modes
  ? structuredClone(script.modes)
  : {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "auto", name: "Auto" },
      ],
    };

const activeTurnAbort = new Map<string, AbortController>();

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<"done" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("done");
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toAvailableCommands(
  list: Array<{ name: string; description: string; hint?: string }>,
): AvailableCommand[] {
  return list.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.hint ? { input: { hint: c.hint } } : {}),
  }));
}

writeLog({ event: "spawn", argv: process.argv.slice(2) });

process.on("SIGINT", () => {
  writeLog({ event: "signal", signal: "SIGINT" });
  if (!script.ignoreSigint) process.exit(0);
});

process.stdin.on("end", () => {
  writeLog({ event: "stdin_eof" });
  setTimeout(() => process.exit(0), 10).unref();
});

function notifyUpdate(client: AgentContext, sessionId: string, update: SessionNotification["update"]): Promise<void> {
  return client.notify(methods.client.session.update, { sessionId, update });
}

async function playPrelude(client: AgentContext, sessionId: string, turnScript: FakeAcpTurnScript): Promise<void> {
  if (turnScript.commandsUpdate) {
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: toAvailableCommands(turnScript.commandsUpdate),
    });
  }

  for (const custom of turnScript.customUpdates ?? []) {
    const rawNotification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: custom.sessionUpdate,
          ...(custom.payload ?? {}),
        },
      },
    };
    process.stdout.write(`${JSON.stringify(rawNotification)}\n`);
  }

  for (const thought of turnScript.thoughtChunks ?? []) {
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: thought },
    });
  }

  for (const ext of turnScript.extensionRequests ?? []) {
    try {
      const res = await client.request(ext.method, ext.params);
      writeLog({ event: "extension_response", method: ext.method, result: res });
    } catch (err) {
      writeLog({
        event: "extension_error",
        method: ext.method,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (turnScript.elicitation) {
    const elicitationRes = await client.request(methods.client.elicitation.create, {
      sessionId,
      mode: "form",
      message: "Please fill out interactive form",
      requestedSchema: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
      },
    });
    writeLog({ event: "elicitation_response", result: elicitationRes });
  }
}

async function askToolPermission(client: AgentContext, sessionId: string, tool: FakeAcpToolStep): Promise<boolean> {
  const perm = tool.requestPermission;
  if (!perm) return true;
  const permRes = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: {
      toolCallId: tool.toolCallId,
      title: perm.title ?? tool.title,
      ...(perm.name !== undefined
        ? { name: perm.name }
        : tool.name !== undefined
          ? { name: tool.name }
          : {}),
      ...(perm.kind !== undefined
        ? { kind: perm.kind }
        : tool.kind !== undefined
          ? { kind: tool.kind }
          : {}),
      ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      ...(perm.meta ? { _meta: perm.meta } : {}),
    },
    options: perm.options ?? DEFAULT_PERMISSION_OPTIONS,
  });
  writeLog({
    event: "permission_outcome",
    toolCallId: tool.toolCallId,
    outcome: permRes.outcome,
  });
  return (
    permRes.outcome.outcome === "selected" &&
    (permRes.outcome.optionId === "allow-always" || permRes.outcome.optionId === "allow-once")
  );
}

function probeWrite(path: string): void {
  try {
    writeFileSync(path, "probe", "utf8");
    writeLog({ event: "probe_write", path, ok: true });
  } catch (err) {
    writeLog({
      event: "probe_write",
      path,
      ok: false,
      code: (err as NodeJS.ErrnoException).code ?? "ERR",
    });
  }
}

async function playToolCall(client: AgentContext, sessionId: string, tool: FakeAcpToolStep): Promise<void> {
  const allowed = await askToolPermission(client, sessionId, tool);

  await notifyUpdate(client, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: tool.toolCallId,
    title: tool.title,
    ...(tool.name !== undefined ? { name: tool.name } : {}),
    ...(tool.kind !== undefined ? { kind: tool.kind } : {}),
    status: "in_progress",
    ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
    ...(tool.locations !== undefined ? { locations: tool.locations } : {}),
  });

  if (allowed && tool.probeWritePath) probeWrite(tool.probeWritePath);

  await notifyUpdate(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: tool.toolCallId,
    status: allowed ? "completed" : "failed",
    ...(tool.resultContent !== undefined ? { content: tool.resultContent } : {}),
    ...(tool.rawOutput !== undefined ? { rawOutput: tool.rawOutput } : {}),
  } as SessionNotification["update"]);
}

async function playReply(client: AgentContext, sessionId: string, turnScript: FakeAcpTurnScript): Promise<void> {
  for (const chunk of turnScript.textChunks ?? []) {
    const text = typeof chunk === "string" ? chunk : chunk.text;
    const messageId = typeof chunk === "string" ? undefined : chunk.messageId;
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      ...(messageId !== undefined ? { messageId } : {}),
    });
  }

  if (turnScript.usageUpdate) {
    await notifyUpdate(client, sessionId, {
      sessionUpdate: "usage_update",
      used: turnScript.usageUpdate.used,
      size: turnScript.usageUpdate.size,
    });
  }

  if (turnScript.spawnChildPidFile) {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
      stdio: "ignore",
    });
    if (sleeper.pid) {
      writeFileSync(turnScript.spawnChildPidFile, String(sleeper.pid), "utf8");
    }
  }
}

async function endScriptedTurn(
  turnScript: FakeAcpTurnScript,
  cancelCtrl: AbortController,
): Promise<{ stopReason: StopReason; usage?: Usage }> {
  if (turnScript.crashExitCode !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.exit(turnScript.crashExitCode);
  }

  if (turnScript.waitForCancel) {
    if (turnScript.ignoreCancel) {
      await new Promise(() => {});
    }
    await sleepWithAbort(turnScript.sleepMs ?? 30_000, cancelCtrl.signal);
    return { stopReason: "cancelled" };
  }

  if (turnScript.sleepMs) {
    const res = await sleepWithAbort(turnScript.sleepMs, cancelCtrl.signal);
    if (res === "aborted") {
      return { stopReason: "cancelled" };
    }
  }

  if (turnScript.throwRpcError) {
    throw new RequestError(turnScript.throwRpcError.code, turnScript.throwRpcError.message);
  }

  return {
    stopReason: turnScript.stopReason ?? "end_turn",
    ...(turnScript.usage ? { usage: turnScript.usage } : {}),
  };
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

const app = agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, async (ctx) => {
    writeLog({ event: "initialize", params: ctx.params });
    if (script.hangOnInitialize) {
      await new Promise(() => {});
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      authMethods: script.authMethods ?? [{ id: "test_login", name: "Test Login" }],
      agentCapabilities: {
        loadSession: script.loadSessionCapability ?? true,
        sessionCapabilities: {
          ...(script.resumeCapability ? { resume: {} } : {}),
          ...(script.closeCapability ? { close: {} } : {}),
          ...(script.systemPromptCapability ? { systemPrompt: {} } : {}),
          ...(script.additionalDirectoriesCapability ? { additionalDirectories: {} } : {}),
        },
      },
    };
  })
  .onRequest(methods.agent.authenticate, async (ctx) => {
    writeLog({ event: "authenticate", methodId: ctx.params.methodId });
    if (script.hangOnAuthenticate) await new Promise(() => {});
    if (script.failAuth) {
      throw new RequestError(-32000, "Authentication rejected by fake agent");
    }
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, async (ctx) => {
    if (script.requireAuth && !authenticated) {
      throw new RequestError(-32000, "Authentication required before session/new");
    }
    if (script.hangOnNew) {
      writeLog({ event: "new_pending" });
      await new Promise(() => {});
    }
    sessionSeq += 1;
    const sessionId = `fake-sess-${process.pid}-${sessionSeq}`;
    saveSession(sessionId, { cwd: ctx.params.cwd, createdAt: Date.now() });
    writeLog({ event: "session/new", sessionId, params: ctx.params });

    if (script.commandsOnSessionStart) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: toAvailableCommands(script.commandsOnSessionStart),
        },
      });
    }

    return {
      sessionId,
      ...(script.omitModes ? {} : { modes: currentModes }),
      configOptions: currentConfigOptions,
    };
  })
  .onRequest(methods.agent.session.load, async (ctx) => {
    const { sessionId } = ctx.params;
    writeLog({ event: "session/load", sessionId, params: ctx.params });
    if (script.loadNotFound || !hasSavedSession(sessionId)) {
      throw new RequestError(-32002, `Resource not found: session ${sessionId}`);
    }

    const replay = script.replayOnLoad;
    if (replay) {
      for (const ut of replay.userTexts ?? []) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: ut },
          },
        });
      }
      for (const th of replay.thoughtTexts ?? []) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: th },
          },
        });
      }
      if (replay.toolTitle) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "replayed-tool-1",
            title: replay.toolTitle,
            kind: "read",
            status: "completed",
          },
        });
      }
      for (const at of replay.agentTexts ?? []) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: at },
          },
        });
      }
      if (replay.commands) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: toAvailableCommands(replay.commands),
          },
        });
      }
    }

    return {
      ...(script.omitModes ? {} : { modes: currentModes }),
      configOptions: currentConfigOptions,
    };
  })
  .onRequest(methods.agent.session.resume, async (ctx) => {
    const { sessionId } = ctx.params;
    writeLog({ event: "session/resume", sessionId, params: ctx.params });
    if (script.resumeUnsupported) throw RequestError.methodNotFound("session/resume");
    if (script.resumeNotFound || !hasSavedSession(sessionId)) {
      throw new RequestError(-32002, `Resource not found: session ${sessionId}`);
    }
    return {
      ...(script.omitModes ? {} : { modes: currentModes }),
      configOptions: currentConfigOptions,
    };
  })
  .onRequest(methods.agent.session.close, async (ctx) => {
    writeLog({ event: "session/close", sessionId: ctx.params.sessionId });
    return {};
  })
  .onRequest(methods.agent.session.setMode, async (ctx) => {
    writeLog({ event: "session/set_mode", sessionId: ctx.params.sessionId, modeId: ctx.params.modeId });
    currentModes = { ...currentModes, currentModeId: ctx.params.modeId };
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, async (ctx) => {
    const { configId, value } = ctx.params;
    writeLog({ event: "session/set_config_option", sessionId: ctx.params.sessionId, configId, value });
    const target = currentConfigOptions.find((opt) => opt.id === configId);
    if (script.rejectUnlistedConfigValues && target?.type === "select" && !flattenSelectValues(target).includes(String(value))) {
      throw RequestError.invalidParams({ configId, value }, `model not found: ${String(value)}`);
    }
    if (typeof value === "string") {
      currentConfigOptions = currentConfigOptions.map((opt) =>
        opt.id === configId && opt.type === "select" ? { ...opt, currentValue: value } : opt,
      );
      const triggerModel = script.dynamicEffortForModel ?? "reasoner-pro";
      if (configId === "model" && value === triggerModel) {
        const hasEffort = currentConfigOptions.some((o) => o.id === "reasoning_effort");
        if (!hasEffort) {
          currentConfigOptions.push({
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          });
        }
      }
    }
    return { configOptions: currentConfigOptions };
  })
  .onNotification(methods.agent.session.cancel, async (ctx) => {
    writeLog({ event: "session/cancel", sessionId: ctx.params.sessionId });
    const ctrl = activeTurnAbort.get(ctx.params.sessionId);
    if (ctrl) {
      if (script.cancelDelayMs) await new Promise((resolve) => setTimeout(resolve, script.cancelDelayMs));
      ctrl.abort();
    }
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const turnIdx = nextTurnIndex(sessionId);
    const turnScript: FakeAcpTurnScript = script.turns?.[turnIdx] ?? {
      textChunks: [`reply-${turnIdx + 1}`],
    };

    const blocks = prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`));
    writeLog({ event: "session/prompt", sessionId, turnIdx, blocks });

    const cancelCtrl = new AbortController();
    if (!turnScript.ignoreCancel) {
      activeTurnAbort.set(sessionId, cancelCtrl);
    }

    try {
      if (turnScript.unterminatedOutputBytes) {
        process.stdout.write("x".repeat(turnScript.unterminatedOutputBytes));
        await new Promise(() => {});
      }
      await playPrelude(ctx.client, sessionId, turnScript);
      for (const tool of turnScript.toolCalls ?? []) {
        await playToolCall(ctx.client, sessionId, tool);
      }
      await playReply(ctx.client, sessionId, turnScript);
      return await endScriptedTurn(turnScript, cancelCtrl);
    } finally {
      activeTurnAbort.delete(sessionId);
    }
  });

app.connect(stream);
