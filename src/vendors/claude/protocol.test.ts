// 不起进程的部分：写入的那一行、拼消息、读 assistant 事件、额度、启动参数和环境。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_API_RETRY_ERROR_CHARS, buildReadonlyPolicy, type AgentSessionRow } from "../../shared/index.ts";
import {
  CLAUDE_PERMISSION_PROMPT_TOOL,
  buildClaudeArgs,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  detectArgsConflict,
  interruptCancelled,
  isInterruptMarker,
  parseApiRetry,
  parseAssistant,
  parseStreamEvent,
  parseCapabilities,
  parseLifecycle,
  parseToolResults,
  parseRateLimit,
} from "./protocol.ts";
import { StreamingToolPreviewTracker, buildChildEnv, lineUuid, mergeUserTexts } from "../../daemon/driver/protocol.ts";

describe("写进标准输入的一行", () => {
  it("固定结构：type=user、role=user、一段 text", () => {
    const line = buildUserLine("你好\n第二行");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "你好\n第二行" }] } });
    expect(checkUserLine(line)).toBeNull();
  });

  it("校验：不是 JSON、role 不对、type 不对、没有文字、带换行，都不合格", () => {
    expect(checkUserLine("not json")).toMatch(/JSON/);
    expect(checkUserLine(JSON.stringify({ type: "user", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }))).toMatch(/role/);
    expect(checkUserLine(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "x" }] } }))).toMatch(/role/);
    expect(checkUserLine(JSON.stringify({ type: "control_request", message: { role: "user", content: [] } }))).toMatch(/type/);
    expect(checkUserLine(buildUserLine(""))).toMatch(/空/);
    expect(checkUserLine(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image" }] } }))).toMatch(/text/);
    expect(checkUserLine(`${buildUserLine("a")}\n${buildUserLine("b")}`)).toMatch(/换行/);
  });

  it("U+2028、U+2029 转义成 \\u2028、\\u2029：按这两个字符切行的读法也只看到一行", () => {
    const line = buildUserLine("上\u2028下\u2029完");
    expect(line).not.toMatch(/[\u2028\u2029]/);
    expect(line).toContain("\\u2028");
    expect(line).toContain("\\u2029");
    expect(JSON.parse(line).message.content[0].text).toBe("上\u2028下\u2029完");
    expect(checkUserLine(line)).toBeNull();
    // 没转义的直接不合格
    const raw = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "a\u2028b" }] } });
    expect(checkUserLine(raw)).toMatch(/U\+2028/);
  });

  it("打断控制消息照抄 M0", () => {
    expect(JSON.parse(buildInterruptLine("int-1"))).toEqual({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
  });
});

describe("忙时连发的用户消息", () => {
  it("一条不拼", () => {
    expect(mergeUserTexts(["只有一条"])).toEqual({ prefixes: [], text: "只有一条" });
  });
  it("几条拼成一条：“【用户连发了 N 条】”和每条（带编号）各一块，最后一条放 text", () => {
    expect(mergeUserTexts(["一", "二", "三"])).toEqual({ prefixes: ["【用户连发了 3 条】", "1. 一", "2. 二"], text: "3. 三" });
  });
});

describe("我们加的字和用户原文分块（docs/composer-commands.md 的 T4）", () => {
  it("加的字每项一个 text 块在前，原文单独放最后一块，原文以 / 开头不变", () => {
    const line = buildUserLine("/x 参数", ["【系统】重发说明", "【用户直接对你说】"]);
    expect(JSON.parse(line).message.content).toEqual([
      { type: "text", text: "【系统】重发说明" },
      { type: "text", text: "【用户直接对你说】" },
      { type: "text", text: "/x 参数" },
    ]);
    expect(checkUserLine(line)).toBeNull();
  });

  it("空白的块不放（API 不收空的 text 块）；全是空白时按“文字是空的”拒绝", () => {
    expect(JSON.parse(buildUserLine("hi", ["", "  "])).message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(JSON.parse(buildUserLine(" ", ["标签"])).message.content).toEqual([{ type: "text", text: "标签" }]);
    expect(checkUserLine(buildUserLine("", [""]))).toMatch(/空/);
  });
});

describe("去重键", () => {
  it("原始事件有 uuid 就照抄，没有就是 line:<sha256 前 32 位>", () => {
    const raw = '{"type":"assistant"}';
    expect(lineUuid({ uuid: "abc" }, raw)).toBe("abc");
    expect(lineUuid({}, raw)).toBe(`line:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`);
    expect(lineUuid({ uuid: "" }, raw)).toMatch(/^line:[0-9a-f]{32}$/);
  });
});

describe("assistant 事件", () => {
  it("几段文字拼成一个 agent.text，每个工具调用一个 agent.tool，uuid 相同", () => {
    const obj = {
      type: "assistant",
      uuid: "u1",
      message: {
        content: [
          { type: "text", text: "先看看" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
          { type: "text", text: "再改" },
          { type: "tool_use", id: "toolu_2", name: "Edit", input: {} },
          { type: "thinking", thinking: "…" },
        ],
      },
    };
    const out = parseAssistant(obj, JSON.stringify(obj), 123);
    expect(out).toEqual([
      { type: "agent.thinking", uuid: "u1", at: 123 },
      { type: "agent.text", uuid: "u1", text: "先看看\n\n再改", at: 123 },
      { type: "agent.tool", uuid: "u1", toolUseId: "toolu_1", name: "Read", input: { file_path: "a.ts" }, at: 123 },
      { type: "agent.tool", uuid: "u1", toolUseId: "toolu_2", name: "Edit", input: {}, at: 123 },
    ]);
  });

  it("thinking 块（真实日志里单独一个事件，内容常是空的）出 agent.thinking，不带内容", () => {
    const obj = { type: "assistant", uuid: "u2", message: { content: [{ type: "thinking", thinking: "", signature: "abc" }] } };
    expect(parseAssistant(obj, JSON.stringify(obj), 5)).toEqual([{ type: "agent.thinking", uuid: "u2", at: 5 }]);
  });

  it("子任务里的事件带 parentToolUseId（照抄 parent_tool_use_id），主 agent 的不带；空串、非字符串当没有", () => {
    const mk = (parent: unknown) => ({
      type: "assistant",
      uuid: "u3",
      parent_tool_use_id: parent,
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    });
    const sub = parseAssistant(mk("toolu_parent"), "{}", 1);
    expect(sub).toHaveLength(3);
    for (const e of sub) expect(e).toMatchObject({ parentToolUseId: "toolu_parent" });
    for (const parent of [null, "", 7, undefined]) {
      for (const e of parseAssistant(mk(parent), "{}", 1)) expect(e).not.toHaveProperty("parentToolUseId");
    }
  });

  it("没有文字、没有工具调用：什么都不出；空白文字也不算", () => {
    expect(parseAssistant({ message: { content: [{ type: "text", text: "  " }] } }, "{}", 1)).toEqual([]);
    expect(parseAssistant({ message: {} }, "{}", 1)).toEqual([]);
    expect(parseAssistant({}, "{}", 1)).toEqual([]);
  });
});

describe("工具结果（user 事件里的 tool_result）", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] },
    parent_tool_use_id: null,
    ...over,
  });

  it("出 agent.tool_result，带这些 tool_use 的 id；一个 user 事件里有几个结果就带几个", () => {
    expect(parseToolResults(result(), 9)).toEqual({ type: "agent.tool_result", toolUseIds: ["toolu_1"], at: 9 });
    const two = result({
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a" },
          { type: "text", text: "x" },
          { type: "tool_result", tool_use_id: "b" },
        ],
      },
    });
    expect(parseToolResults(two, 9)).toMatchObject({ toolUseIds: ["a", "b"] });
  });

  it("子任务里的结果带 parentToolUseId", () => {
    expect(parseToolResults(result({ parent_tool_use_id: "toolu_p" }), 1)).toMatchObject({ parentToolUseId: "toolu_p" });
  });

  it("不是工具结果（普通文字、回显、字符串内容）、脏的（没有 id、content 不是数组）：null", () => {
    expect(parseToolResults({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }, 1)).toBeNull();
    expect(parseToolResults({ type: "user", message: { content: "hi" } }, 1)).toBeNull();
    expect(parseToolResults({ type: "user", message: {} }, 1)).toBeNull();
    expect(parseToolResults({ type: "user" }, 1)).toBeNull();
    expect(parseToolResults(result({ message: { content: [{ type: "tool_result" }] } }), 1)).toBeNull();
    expect(parseToolResults(result({ isReplay: true }), 1)).toBeNull();
  });
});

describe("额度", () => {
  it("rate_limit_info 照抄 status、resetsAt，unifiedWindows 变成 windows", () => {
    expect(
      parseRateLimit({
        status: "allowed",
        resetsAt: 1,
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 2, status: "allowed" }, bad: "x" },
      }),
    ).toEqual({ status: "allowed", resetsAt: 1, windows: { five_hour: { utilization: 0.5, resetsAt: 2, status: "allowed" } } });
  });
  // 真实日志（~/.agent-hub/state/logs/sessions/1.jsonl，2026-11-04）：14:30 重置前后的两条，顶层字段和窗口字段都是 Claude 原样的
  const realBeforeReset = {
    status: "allowed_warning",
    resetsAt: 1793773800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "group_zero_credit_limit",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.99, resetsAt: 1793773800, status: "allowed_warning" },
      seven_day: { utilization: 0.31, resetsAt: 1794250800, status: "allowed" },
    },
  };
  const realAfterReset = {
    ...realBeforeReset,
    status: "allowed",
    resetsAt: 1793791800,
    unifiedWindows: {
      five_hour: { utilization: 0, resetsAt: 1793791800, status: "allowed" },
      seven_day: { utilization: 0.31, resetsAt: 1794250800, status: "allowed" },
    },
  };
  it("真实事件：重置前后两条都两个窗口齐全；重置后 utilization 是 0（不是缺）、resetsAt 换成新的", () => {
    expect(parseRateLimit(realBeforeReset)).toEqual({
      status: "allowed_warning",
      resetsAt: 1793773800,
      windows: {
        five_hour: { utilization: 0.99, resetsAt: 1793773800, status: "allowed_warning" },
        seven_day: { utilization: 0.31, resetsAt: 1794250800, status: "allowed" },
      },
    });
    expect(parseRateLimit(realAfterReset)).toEqual({
      status: "allowed",
      resetsAt: 1793791800,
      windows: {
        five_hour: { utilization: 0, resetsAt: 1793791800, status: "allowed" },
        seven_day: { utilization: 0.31, resetsAt: 1794250800, status: "allowed" },
      },
    });
  });
  it("残缺的（不是对象、没有 status）返回 null，由调用方跳过", () => {
    expect(parseRateLimit(undefined)).toBeNull();
    expect(parseRateLimit(null)).toBeNull();
    expect(parseRateLimit("x")).toBeNull();
    expect(parseRateLimit({ resetsAt: 1 })).toBeNull();
    expect(parseRateLimit({ status: "allowed" })).toEqual({ status: "allowed", resetsAt: null, windows: {} });
  });
});

describe("system/api_retry", () => {
  const event = { type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 2062, error_status: null, error: "unknown" };
  it("attempt、max_retries 照抄；下次重试的时间点 = 收到的时间 + retry_delay_ms", () => {
    expect(parseApiRetry(event, 1_000)).toEqual({ attempt: 3, maxRetries: 10, retryAt: 3_062, errorStatus: null, error: "unknown" });
  });
  it("error_status 是数字就带上", () => {
    expect(parseApiRetry({ ...event, error_status: 529, error: "overloaded" }, 0)).toMatchObject({ errorStatus: 529, error: "overloaded" });
  });
  it("error_status 不是数字（缺了、字符串）当没有；error 不是字符串当空，太长的截断", () => {
    const { error_status: _s, error: _e, ...bare } = event;
    expect(parseApiRetry(bare, 0)).toMatchObject({ errorStatus: null, error: "" });
    expect(parseApiRetry({ ...event, error_status: "529", error: 7 }, 0)).toMatchObject({ errorStatus: null, error: "" });
    expect([...parseApiRetry({ ...event, error: "x".repeat(5_000) }, 0)!.error].length).toBeLessThanOrEqual(MAX_API_RETRY_ERROR_CHARS);
  });
  it("缺了或类型不对的 attempt、max_retries、retry_delay_ms：整条忽略（返回 null）", () => {
    for (const [key, bad] of [
      ["attempt", undefined],
      ["attempt", "3"],
      ["attempt", 0],
      ["attempt", 1.5],
      ["attempt", Number.NaN],
      ["max_retries", undefined],
      ["max_retries", "10"],
      ["max_retries", -1],
      ["retry_delay_ms", undefined],
      ["retry_delay_ms", "2062"],
      ["retry_delay_ms", -5],
      ["retry_delay_ms", Number.POSITIVE_INFINITY],
    ] as const) {
      expect(parseApiRetry({ ...event, [key]: bad }, 0), `${key}=${String(bad)}`).toBeNull();
    }
  });
});

const row: AgentSessionRow = {
  id: 1,
  role: "pm",
  conversationId: 1,
  pmId: 1,
  workerId: null,
  vendor: "claude",
  vendorSessionId: "11111111-1111-4111-8111-111111111111",
  cwd: "/tmp/pm",
  addDirs: ["/a", "/b"],
  generation: 1,
  model: null,
  effort: null,
  pid: null,
  status: "idle",
  hasCompletedTurn: false,
  lastEventAt: null,
  rateLimit: null,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 },
  createdAt: 0,
  updatedAt: 0,
};

describe("启动参数", () => {
  const files = { promptFile: "/l/prompt.md", settingsFile: "/l/settings.json", env: {}, fingerprint: "" };
  it("第一次 --session-id，带设置文件和每个附加文件夹；没有模型就不带 --model", () => {
    expect(buildClaudeArgs(row, files, false)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--session-id",
      row.vendorSessionId,
      "--append-system-prompt-file",
      "/l/prompt.md",
      "--settings",
      "/l/settings.json",
      "--add-dir",
      "/a",
      "--add-dir",
      "/b",
    ]);
  });
  it("只读 Worker（LaunchFiles.readonly）：加 --permission-prompt-tool stdio，要批准的工具发 can_use_tool 给驱动；没有 readonly 不带", () => {
    const readonly = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" });
    const args = buildClaudeArgs(row, { ...files, readonly }, false);
    expect(args.slice(args.indexOf("--permission-prompt-tool"), args.indexOf("--permission-prompt-tool") + 2)).toEqual(["--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL]);
    expect(CLAUDE_PERMISSION_PROMPT_TOOL).toBe("stdio");
    expect(args.indexOf("--permission-prompt-tool")).toBeGreaterThan(args.indexOf("--settings"));
    expect(buildClaudeArgs(row, files, false)).not.toContain("--permission-prompt-tool");
  });
  it("恢复用 --resume，有模型带 --model", () => {
    const args = buildClaudeArgs({ ...row, model: "sonnet", addDirs: [] }, { promptFile: "/p", env: {}, fingerprint: "" }, true);
    expect(args.slice(8, 12)).toEqual(["--resume", row.vendorSessionId, "--model", "sonnet"]);
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--effort");
  });
  it("有思考程度带 --effort，紧跟在 --model 后面；默认（null）的都不带", () => {
    const args = buildClaudeArgs({ ...row, model: "haiku", effort: "low" }, files, true);
    expect(args.slice(8, 14)).toEqual(["--resume", row.vendorSessionId, "--model", "haiku", "--effort", "low"]);
    const effortOnly = buildClaudeArgs({ ...row, effort: "max" }, files, true);
    expect(effortOnly.slice(10, 12)).toEqual(["--effort", "max"]);
    expect(effortOnly).not.toContain("--model");
    const neither = buildClaudeArgs(row, files, true);
    expect(neither).not.toContain("--model");
    expect(neither).not.toContain("--effort");
  });
  it("Worker 会话加 --exclude-dynamic-system-prompt-sections 提升跨 worktree 前缀缓存命中；PM 与总助会话不加", () => {
    const workerRow: AgentSessionRow = { ...row, role: "worker", pmId: null, workerId: 5, addDirs: [] };
    const freshWorkerArgs = buildClaudeArgs(workerRow, files, false);
    const resumeWorkerArgs = buildClaudeArgs(workerRow, files, true);
    expect(freshWorkerArgs).toContain("--exclude-dynamic-system-prompt-sections");
    expect(resumeWorkerArgs).toContain("--exclude-dynamic-system-prompt-sections");
    expect(freshWorkerArgs.indexOf("--exclude-dynamic-system-prompt-sections")).toBeLessThan(
      freshWorkerArgs.indexOf("--append-system-prompt-file"),
    );
    expect(buildClaudeArgs(row, files, false)).not.toContain("--exclude-dynamic-system-prompt-sections");
    expect(buildClaudeArgs({ ...row, role: "assistant", pmId: null }, files, false)).not.toContain(
      "--exclude-dynamic-system-prompt-sections",
    );
  });
});

describe("子进程环境", () => {
  it("去掉父 Claude 会话留下的变量，加上额外的", () => {
    const env = buildChildEnv(
      { PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "x", T3CODE_THREAD_ID: "t" },
      { CLAUDE_CONFIG_DIR: "/c" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/c" });
  });
});

describe("打断标记", () => {
  const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
  it("两种打断标记都认；回显（isReplay）里的同样文字不算", () => {
    expect(isInterruptMarker(user("[Request interrupted by user]"))).toBe(true);
    expect(isInterruptMarker(user("[Request interrupted by user for tool use]"))).toBe(true);
    expect(isInterruptMarker(user("[Request interrupted by user]", { isReplay: true }))).toBe(false);
    expect(isInterruptMarker(user("hi"))).toBe(false);
  });
});

describe("参数选错的报错", () => {
  it("只认 “Session ID … is already in use” 和 “No conversation found”", () => {
    expect(detectArgsConflict("Error: Session ID 1234-abcd is already in use.\n")).toBe("session_in_use");
    expect(detectArgsConflict("No conversation found with session ID: x")).toBe("no_conversation");
    expect(detectArgsConflict("Error: port 8080 is already in use")).toBeNull();
    expect(detectArgsConflict("address already in use")).toBeNull();
  });
});

describe("一轮中途写入（docs/mid-turn-messages.md 第 2、5 节）", () => {
  it("user 行带 uuid（command_lifecycle 用），不给就不带；照样过写入前的校验", () => {
    const line = buildUserLine("你好", [], undefined, "11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(line)).toEqual({ type: "user", uuid: "11111111-1111-4111-8111-111111111111", message: { role: "user", content: [{ type: "text", text: "你好" }] } });
    expect(checkUserLine(line)).toBeNull();
    expect(JSON.parse(buildUserLine("你好"))).not.toHaveProperty("uuid");
  });

  it("interrupt 控制消息：cancelQueued 时带 cancel_queued: true", () => {
    expect(JSON.parse(buildInterruptLine("i1")).request).toEqual({ subtype: "interrupt" });
    expect(JSON.parse(buildInterruptLine("i1", true)).request).toEqual({ subtype: "interrupt", cancel_queued: true });
  });

  it("init 的 capabilities、command_lifecycle、interrupt 回执里的 cancelled（照真 claude 2.1.314 的形状）", () => {
    expect(parseCapabilities({ capabilities: ["msg_lifecycle_v1", 3, "interrupt_cancel_queued_v1"] })).toEqual(new Set(["msg_lifecycle_v1", "interrupt_cancel_queued_v1"]));
    expect(parseCapabilities({})).toEqual(new Set());
    expect(parseLifecycle({ type: "command_lifecycle", command_uuid: "u1", state: "started", uuid: "x" })).toEqual({ uuid: "u1", state: "started" });
    expect(parseLifecycle({ type: "command_lifecycle", command_uuid: "u1", state: "weird" })).toBeNull();
    expect(parseLifecycle({ type: "command_lifecycle", state: "started" })).toBeNull();
    expect(interruptCancelled({ still_queued: [], cancelled: ["u2", 7] })).toEqual(["u2"]);
    expect(interruptCancelled({ still_queued: [] })).toEqual([]);
    expect(interruptCancelled(undefined)).toEqual([]);
  });
});


describe("Claude 流式正文与工具早捕获", () => {
  it("正文只接收 text_delta（忽略思考与签名）；tool_use 起点与 input_json_delta 早捕获工具名与文件路径", () => {
    for (const type of ["thinking_delta", "signature_delta"]) {
      expect(parseStreamEvent({ event: { type: "content_block_delta", delta: { type, text: "隐藏内容" } } }, 1)).toBeNull();
    }
    expect(parseStreamEvent({ event: { type: "content_block_delta", delta: { type: "text_delta", text: "正文" } } }, 1)).toEqual({
      type: "agent.text_delta",
      delta: "正文",
      at: 1,
    });
    expect(
      parseStreamEvent(
        {
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_r1", name: "Read", input: {} },
          },
        },
        2,
      ),
    ).toEqual({
      type: "agent.tool_preview",
      toolUseId: "toolu_r1",
      name: "Read",
      input: {},
      at: 2,
    });
  });

  it("配合流式跟踪器：input_json_delta 拼出完整 file_path / skill 字符串即刻升级预览，后续无关字段不刷屏，stop 后清块", async () => {
    const { StreamingToolPreviewTracker } = await import("../../daemon/driver/protocol.ts");
    const tracker = new StreamingToolPreviewTracker();

    const startEv = parseStreamEvent(
      {
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_edit1", name: "Edit", input: {} },
        },
        parent_tool_use_id: null,
      },
      10,
      tracker,
    );
    expect(startEv).toEqual({
      type: "agent.tool_preview",
      toolUseId: "toolu_edit1",
      name: "Edit",
      input: {},
      at: 10,
    });

    // 半截 JSON（引号未闭合）：暂不发新预览
    expect(
      parseStreamEvent(
        { event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path": "/src/foo' } } },
        11,
        tracker,
      ),
    ).toBeNull();

    // 引号闭合（含转义字符）：立即发出带 file_path 的预览
    const pathEv = parseStreamEvent(
      {
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '\\"bar.ts", "old_string": "long' },
        },
      },
      12,
      tracker,
    );
    expect(pathEv).toEqual({
      type: "agent.tool_preview",
      toolUseId: "toolu_edit1",
      name: "Edit",
      input: { file_path: '/src/foo"bar.ts' },
      at: 12,
    });

    // 后续继续流式拼 old_string / new_string：step 未变，不重复刷屏
    expect(
      parseStreamEvent(
        { event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' body text", "new_string": "x"}' } } },
        13,
        tracker,
      ),
    ).toBeNull();

    // content_block_stop 清掉该块缓存
    expect(parseStreamEvent({ event: { type: "content_block_stop", index: 2 } }, 14, tracker)).toBeNull();
    expect(tracker.size).toBe(0);
  });

  it("子任务（后台子 agent）的流和主 agent 交错：子任务的工具块、message_start / stop 都不碰主 agent 的跟踪器", () => {
    const tracker = new StreamingToolPreviewTracker();
    const sub = { parent_tool_use_id: "toolu_parent" };
    expect(
      parseStreamEvent(
        { event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_main", name: "Read", input: {} } } },
        1,
        tracker,
      ),
    ).toMatchObject({ type: "agent.tool_preview", toolUseId: "toolu_main", name: "Read" });

    // 子任务同序号的工具块、新消息：不发预览（账本也不显示子任务的），也不盖掉 / 清掉主 agent 的块
    expect(
      parseStreamEvent(
        { event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_sub", name: "Bash", input: {} } }, ...sub },
        2,
        tracker,
      ),
    ).toBeNull();
    expect(parseStreamEvent({ event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }, ...sub }, 3, tracker)).toBeNull();
    expect(parseStreamEvent({ event: { type: "message_start" }, ...sub }, 4, tracker)).toBeNull();
    expect(parseStreamEvent({ event: { type: "content_block_stop", index: 1 }, ...sub }, 5, tracker)).toBeNull();
    expect(tracker.size).toBe(1);

    // 主 agent 接着拼参数：路径照样升级到自己的块上
    expect(
      parseStreamEvent(
        { event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/a/main.ts"}' } } },
        6,
        tracker,
      ),
    ).toEqual({ type: "agent.tool_preview", toolUseId: "toolu_main", name: "Read", input: { file_path: "/a/main.ts" }, at: 6 });
  });
});
