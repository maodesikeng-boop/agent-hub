// 多厂商守护进程集成单测：验证 startDaemon 组装 claude / agy / codex 三家模型目录、驱动分发、PM 对话与跨厂商派 Worker。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  API_PATHS,
  ENV_HOME,
  ENV_PORT,
  HUB_COMMAND,
  REPORT_END,
  REPORT_START,
  vendorSpec,
  workerEventOf,
  type ModelsResponse,
} from "../shared/index.ts";
import { Client, agentTexts, messagesOf, waitForStatus, waitUntil } from "../../test/e2e/harness.ts";
import { PARENT_SESSION_ENV } from "./driver/protocol.ts";
import { SANDBOX_EXEC, osSandboxAvailable } from "./driver/write-scope.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";

const canNestOsSandbox =
  process.platform === "darwin"
    ? (() => {
        try {
          execFileSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })()
    : osSandboxAvailable();

/** 只有 Worker 的提示词里有的一句（daemon/prompt.ts 的 buildWorkerPrompt）：假 agy、codex 靠它认出自己是 Worker。 */
const WORKER_PROMPT_MARK = "# 你的规矩";

function shortTmp(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync("/tmp") ? base : "/tmp";
}

function writeExecutable(path: string, source: string): string {
  return writeExecutableNodeScript(path, source);
}

describe("daemon 多厂商集成（claude + agy + codex）", () => {
  let dir: string;
  let daemon: RunningDaemon | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(shortTmp(), "ah-mv-test-"));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function createFakeVendors(binDir: string, projectDir: string) {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const claudePath = writeExecutable(
      join(binDir, "fake-claude"),
      `
const { createInterface } = require("node:readline");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const argv = process.argv.slice(2);
const sessionIdx = argv.indexOf("--session-id") !== -1 ? argv.indexOf("--session-id") : argv.indexOf("--resume");
const sessionId = sessionIdx !== -1 ? argv[sessionIdx + 1] : randomUUID();

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "initialize") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            models: [
              { value: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", supportedEffortLevels: ["low", "medium", "high"] },
            ],
            commands: [{ name: "compact", description: "Compact context", builtin: true }],
          },
        },
      });
    }
    return;
  }
  if (msg.type === "user") {
    out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5-5", uuid: randomUUID() });
    out({ type: "user", isReplay: true, message: msg.message, uuid: randomUUID() });
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content.map((c) => c.text || "") : [];
    const lastText = blocks[blocks.length - 1] || "";
    const allText = blocks.join("\\n");
    let reply = "Claude PM 收到：" + lastText;
    if (lastText.startsWith("DISPATCH_CROSS_VENDOR:")) {
      execFileSync("${HUB_COMMAND}", [" project", "create", "--folder", ${JSON.stringify(projectDir)}, "--name", "跨厂商项目"].map((s) => s.trim()), {
        input: "",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      execFileSync("${HUB_COMMAND}", ["worker", "start", "--title", "Agy子任务", "--vendor", "agy", "--no-worktree", "--stdin"], {
        input: "请用 agy 完成任务",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      execFileSync("${HUB_COMMAND}", ["worker", "start", "--title", "Codex子任务", "--vendor", "codex", "--no-worktree", "--stdin"], {
        input: "请用 codex 完成任务",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      reply = "已派出 agy 与 codex 两个 Worker";
    } else if (allText.includes("【Worker #")) {
      reply = "Claude PM 已验收汇报：" + allText.slice(0, 60);
    }
    out({
      type: "assistant",
      uuid: randomUUID(),
      message: { id: "msg-" + randomUUID(), content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: reply,
      session_id: sessionId,
      uuid: randomUUID(),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }
});
`,
    );

    const agyPath = writeExecutable(
      join(binDir, "fake-agy"),
      `
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const argv = process.argv.slice(2);
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

if (argv.includes("models")) {
  out({
    command: {
      name: "models",
      data: {
        models: [
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", currently_selected: true },
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ],
      },
    },
  });
  process.exit(0);
}

if (argv.includes("/skills")) {
  out({ response: "Available skills:\\n- agy-review (workspace): Review with Agy\\n" });
  process.exit(0);
}

const convIdx = argv.indexOf("--conversation");
const convId = convIdx !== -1 ? argv[convIdx + 1] : "agy-conv-" + randomUUID();
// 是不是 Worker 看 --add-dir 里的常驻规则：P4 起 Worker 专用的环境变量只有 claude 的 Worker 才设（A15）
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
let isWorker = argv.some((arg, i) => {
  if (arg !== "--add-dir") return false;
  const dir = join(argv[i + 1], ".agents", "rules");
  return existsSync(dir) && readdirSync(dir).some((name) => readFileSync(join(dir, name), "utf8").includes(${JSON.stringify(WORKER_PROMPT_MARK)}));
});
let inited = false;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.event !== "user" && msg.type !== "user") return;
  if (!inited) {
    inited = true;
    out({ event: "init", init: { conversation_id: convId, model: "gemini-4-argon" } });
  }
  out({ event: "step_update", step_update: { step_index: 0, step_type: "user_input", state: "DONE" } });
  const blocks = Array.isArray(msg.message?.content) ? msg.message.content.map((c) => c.text || "") : [];
  const lastText = blocks[blocks.length - 1] || "";
  if (blocks.join("\\n").includes(${JSON.stringify(WORKER_PROMPT_MARK)})) isWorker = true;
  const reply = isWorker
    ? "Agy Worker 执行完毕\\n\\n${REPORT_START}\\n状态: 做完了\\n摘要: Agy Worker 顺利完成\\n提交: 无\\n测试: 通过\\n问题: 无\\n${REPORT_END}"
    : "Agy PM 收到：" + lastText;
  const stepId = "step-" + randomUUID();
  out({
    event: "step_update",
    step_update: {
      step_id: stepId,
      step_index: 1,
      step_type: "agent_response",
      state: "DONE",
      text_delta: reply,
    },
  });
  out({
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: convId,
      response: reply,
      usage: { input_tokens: 12, output_tokens: 6, thinking_tokens: 0, cache_read_tokens: 0 },
    },
  });
});
`,
    );

    const codexPath = writeExecutable(
      join(binDir, "fake-codex"),
      `
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
// 是不是 Worker 看 thread/start 的 developerInstructions（提示词）：P4 起 Worker 专用的环境变量只有 claude 的 Worker 才设（A15）
let isWorker = false;
let threadId = "thr-codex-" + randomUUID();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    out({ jsonrpc: "2.0", id: req.id, result: { userAgent: "fake-codex/0.1" } });
    return;
  }
  if (req.method === "model/list") {
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        data: [
          { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        ],
      },
    });
    return;
  }
  if (req.method === "account/read") {
    out({ jsonrpc: "2.0", id: req.id, result: { account: { type: "chatgpt", email: "fake@example.com" }, requiresOpenaiAuth: true } });
    return;
  }
  // 项目经理会话握手后先挂产品技能目录（任务图手册，codex/driver.ts），回了才建线程
  if (req.method === "skills/extraRoots/set") {
    out({ jsonrpc: "2.0", id: req.id, result: {} });
    return;
  }
  if (req.method === "skills/list") {
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        data: [{ cwd: process.cwd(), skills: [{ name: "codex-check", description: "Codex check", enabled: true }] }],
      },
    });
    return;
  }
  if (req.method === "thread/start" || req.method === "thread/resume") {
    if (req.params?.threadId) threadId = req.params.threadId;
    if ((req.params?.developerInstructions || "").includes(${JSON.stringify(WORKER_PROMPT_MARK)})) isWorker = true;
    out({ jsonrpc: "2.0", id: req.id, result: { thread: { id: threadId }, model: "gpt-5.4" } });
    out({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
    return;
  }
  if (req.method === "turn/start") {
    const turnId = "turn-" + randomUUID();
    const itemId = "msg-" + randomUUID();
    const inputText = (req.params?.input || []).map((i) => i.text || "").join("\\n");
    const lastLine = inputText.split("\\n").pop() || "";
    const reply = isWorker
      ? "Codex Worker 执行完毕\\n\\n${REPORT_START}\\n状态: 做完了\\n摘要: Codex Worker 顺利完成\\n提交: 无\\n测试: 通过\\n问题: 无\\n${REPORT_END}"
      : "Codex PM 收到：" + lastLine;
    out({ jsonrpc: "2.0", id: req.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    out({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    out({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "" } } });
    out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: reply } });
    out({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: itemId, text: reply } } });
    out({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: { inputTokens: 15, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0, totalTokens: 23 },
          total: { inputTokens: 15, cachedInputTokens: 0, outputTokens: 8, reasoningOutputTokens: 0, totalTokens: 23 },
        },
      },
    });
    out({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
    });
  }
});
`,
    );

    const deepseekPath = writeExecutable(
      join(binDir, "fake-dsh"),
      `
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let sessionId = "dsh-sess-" + randomUUID();

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
        agentInfo: { name: "fake-dsh", version: "0.2.2-rc.1" },
        agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {}, close: {} } },
      },
    });
    return;
  }
  if (req.method === "session/new" || req.method === "session/resume") {
    if (req.params?.sessionId) sessionId = req.params.sessionId;
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        ...(req.method === "session/new" ? { sessionId } : {}),
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "[\\"deepseek-official\\",\\"deepseek-v4-pro\\"]",
            options: [{ value: "[\\"deepseek-official\\",\\"deepseek-v4-pro\\"]", name: "DeepSeek V4 Pro" }],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "off", name: "Off" },
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
              { value: "max", name: "Max" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (req.method === "session/set_config_option") {
    out({ jsonrpc: "2.0", id: req.id, result: { configOptions: [] } });
    return;
  }
  if (req.method === "session/prompt") {
    const blocks = (req.params?.prompt || []).map((b) => b.text || "");
    const lastText = blocks[blocks.length - 1] || "";
    const reply = "DeepSeek PM 收到：" + lastText;
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
    });
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
    });
  }
});
`,
    );

    const cursorPath = writeExecutable(
      join(binDir, "fake-cursor"),
      `
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");

const argv = process.argv.slice(2);
if (argv[0] === "models") {
  process.stdout.write("Available models\\n\\nauto - Auto (current, default)\\ncomposer-2.5 - Composer 2.5\\ncomposer-2.5-fast - Composer 2.5 Fast\\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\\n");
  process.exit(0);
}
if (argv[0] === "status") {
  process.stdout.write(JSON.stringify({ authenticated: true, email: "cursor@example.com" }) + "\\n");
  process.exit(0);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let sessionId = "";
let isWorker = false;
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    out({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (req.method === "session/new") {
    sessionId = "cursor-sess-" + randomUUID();
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "default[]",
            options: [
              { value: "default[]", name: "Auto" },
              { value: "composer-2.5[fast=true]", name: "composer-2.5" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (req.method === "session/load" || req.method === "session/set_config_option" || req.method === "session/set_mode") {
    if (req.params?.sessionId) sessionId = req.params.sessionId;
    out({ jsonrpc: "2.0", id: req.id, result: {} });
    return;
  }
  if (req.method === "session/prompt") {
    const blocks = Array.isArray(req.params?.prompt) ? req.params.prompt.map((b) => b.text || "") : [];
    const joined = blocks.join("\\n");
    if (joined.includes(${JSON.stringify(WORKER_PROMPT_MARK)})) isWorker = true;
    const lastLine = joined.split("\\n").filter(Boolean).pop() || "";
    const reply = isWorker
      ? ["Cursor Worker 已完成", "${REPORT_START}", "状态: 做完了", "摘要: Cursor Worker 顺利完成", "提交: 无", "测试: 无", "问题: 无", "${REPORT_END}"].join("\\n")
      : "Cursor PM 收到：" + lastLine;
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
      },
    });
    out({
      jsonrpc: "2.0",
      id: req.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 } },
    });
  }
});
`,
    );

    return { claudePath, agyPath, codexPath, deepseekPath, cursorPath };
  }

  async function bootMultiVendorDaemon() {
    const binDir = join(dir, "bin");
    const projectDir = join(dir, "project");
    const userHome = join(dir, "user-home");
    const hubHome = join(dir, "hub-home");
    mkdirSync(userHome, { recursive: true });
    const { claudePath, agyPath, codexPath, deepseekPath, cursorPath } = createFakeVendors(binDir, projectDir);

    const cleanEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!PARENT_SESSION_ENV.includes(k)) cleanEnv[k] = v;
    }
    cleanEnv[ENV_HOME] = hubHome;
    cleanEnv[ENV_PORT] = "0";
    for (const v of AGENT_VENDORS) {
      cleanEnv[vendorSpec(v).cli.envVar] = join(binDir, `missing-${v}`);
    }
    cleanEnv[vendorSpec("claude").cli.envVar] = claudePath;
    cleanEnv[vendorSpec("agy").cli.envVar] = agyPath;
    cleanEnv[vendorSpec("codex").cli.envVar] = codexPath;
    cleanEnv[vendorSpec("deepseek").cli.envVar] = deepseekPath;
    cleanEnv[vendorSpec("cursor").cli.envVar] = cursorPath;

    daemon = await startDaemon({ userHome, env: cleanEnv });
    const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(daemon.url);
    if (!tokenMatch) throw new Error(`missing token in ${daemon.url}`);
    const authRes = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.auth}?token=${tokenMatch[1]}`, {
      redirect: "manual",
    });
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    const client = new Client(daemon.port, cookie);
    return { client, projectDir };
  }

  it("GET /api/models 按 AGENT_VENDORS 顺序返回各家厂商的模型目录", async () => {
    const { client } = await bootMultiVendorDaemon();
    const res = await client.get(API_PATHS.models);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsResponse;
    expect(body.catalogs.map((c) => c.vendor)).toEqual([...AGENT_VENDORS]);

    const [claudeCat, agyCat, codexCat] = body.catalogs;
    expect(claudeCat!.source).toBe("vendor");
    expect(claudeCat!.models.some((m) => m.id === "claude-sonnet-5-5")).toBe(true);

    expect(agyCat!.source).toBe("vendor");
    expect(agyCat!.models.find((m) => m.id === "gemini-4-argon")?.efforts).toEqual(["high"]);
    expect(agyCat!.defaultModel).toBe("Gemini 4 Argon");

    expect(codexCat!.source).toBe("vendor");
    expect(codexCat!.models.some((m) => m.id === "gpt-5.4")).toBe(true);
    expect(codexCat!.defaultModel).toBe("GPT-5.4");

    const deepseekCat = body.catalogs.find((c) => c.vendor === "deepseek");
    expect(deepseekCat?.source).toBe("bundled");
    expect(deepseekCat?.models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);

    // cursor 名单按家族归并：composer-2.5 与 composer-2.5-fast 并成一项，默认固定 Auto
    const cursorCat = body.catalogs.find((c) => c.vendor === "cursor");
    expect(cursorCat?.source).toBe("vendor");
    expect(cursorCat?.models.map((m) => m.id)).toEqual(["composer-2.5", "claude-opus-5-5"]);
    expect(cursorCat?.defaultModel).toBe("Auto");
  });

  it("可创建 vendor 为 agy、codex、deepseek、cursor 的 PM，发消息路由到对应驱动层并收到回复", async () => {
    const { client } = await bootMultiVendorDaemon();

    const agyPm = await client.createPm({
      name: "阿吉PM",
      mode: "hands_on",
      vendor: "agy",
      defaultModel: "gemini-4-argon",
      effort: "high",
      persona: "你是阿吉。",
    });
    const agyMsgId = await client.post(agyPm.conversationId, "你好阿吉");
    await waitForStatus(client, agyMsgId, "replied");
    expect(agentTexts(await client.state(), agyPm.conversationId)).toEqual(["Agy PM 收到：你好阿吉"]);

    const codexPm = await client.createPm({
      name: "小科PM",
      mode: "hands_on",
      vendor: "codex",
      defaultModel: "gpt-5.4",
      effort: "medium",
      persona: "你是小科。",
    });
    const codexMsgId = await client.post(codexPm.conversationId, "你好小科");
    await waitForStatus(client, codexMsgId, "replied");
    expect(agentTexts(await client.state(), codexPm.conversationId)).toEqual(["Codex PM 收到：你好小科"]);

    const deepseekPm = await client.createPm({
      name: "小深PM",
      mode: "hands_on",
      vendor: "deepseek",
      defaultModel: "deepseek-v4-pro",
      effort: "high",
      persona: "你是小深。",
    });
    const deepseekMsgId = await client.post(deepseekPm.conversationId, "你好小深");
    await waitForStatus(client, deepseekMsgId, "replied");
    expect(agentTexts(await client.state(), deepseekPm.conversationId)).toEqual(["DeepSeek PM 收到：你好小深"]);

    const cursorPm = await client.createPm({
      name: "小游PM",
      mode: "hands_on",
      vendor: "cursor",
      defaultModel: "composer-2.5",
      effort: null,
      persona: "你是小游。",
    });
    const cursorMsgId = await client.post(cursorPm.conversationId, "你好小游");
    await waitForStatus(client, cursorMsgId, "replied");
    expect(agentTexts(await client.state(), cursorPm.conversationId)).toEqual(["Cursor PM 收到：你好小游"]);
  });

  it.skipIf(!canNestOsSandbox)("claude PM 可通过 hub worker start --vendor agy / codex 跨厂商派 Worker 并收到汇报", async () => {
    const { client } = await bootMultiVendorDaemon();
    const initial = await client.state();
    const claudeConvId = initial.conversations[0]!.conversation.id;

    const msgId = await client.post(claudeConvId, "DISPATCH_CROSS_VENDOR:");
    await waitForStatus(client, msgId, "replied");

    // 等待两个跨厂商 Worker 都完成汇报并由 Claude PM 收到
    const reports = await waitUntil(
      "agy & codex worker reports delivered to claude PM",
      async () => {
        const st = await client.state();
        const completed = messagesOf(st, claudeConvId)
          .map((m) => workerEventOf(m))
          .filter((w) => w !== null && w.event === "report" && w.status === "done");
        return completed.length >= 2 ? completed : undefined;
      },
      15_000,
    );

    const summaries = reports.map((r) => r!.summary);
    expect(summaries).toContain("Agy Worker 顺利完成");
    expect(summaries).toContain("Codex Worker 顺利完成");

    const finalState = await client.state();
    const workerConvs = new Set(reports.map((r) => r!.workerConversationId));
    const workerVendors = finalState.sessions
      .filter((s) => s.conversationId !== null && workerConvs.has(s.conversationId))
      .map((s) => s.vendor)
      .sort();
    expect(workerVendors).toEqual(["agy", "codex"]);
  });
});
import { writeExecutableNodeScript } from "../../test/fake-cli-shim.ts";
