// 不起进程的部分：写入的那一行、拼消息、读 assistant 事件、额度、启动参数和环境。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_API_RETRY_ERROR_CHARS, type AgentSessionRow } from "../../shared/index.ts";
import {
  buildClaudeArgs,
  buildChildEnv,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  detectArgsConflict,
  isInterruptMarker,
  lineUuid,
  mergeUserTexts,
  parseApiRetry,
  parseAssistant,
  parseRateLimit,
} from "./protocol.ts";

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
    expect(mergeUserTexts(["只有一条"])).toBe("只有一条");
  });
  it("几条拼成一条，开头写“【用户连发了 N 条】”，每条编号", () => {
    expect(mergeUserTexts(["一", "二", "三"])).toBe("【用户连发了 3 条】\n1. 一\n2. 二\n3. 三");
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
      { type: "agent.text", uuid: "u1", text: "先看看\n\n再改", at: 123 },
      { type: "agent.tool", uuid: "u1", toolUseId: "toolu_1", name: "Read", input: { file_path: "a.ts" }, at: 123 },
      { type: "agent.tool", uuid: "u1", toolUseId: "toolu_2", name: "Edit", input: {}, at: 123 },
    ]);
  });

  it("没有文字、没有工具调用：什么都不出；空白文字也不算", () => {
    expect(parseAssistant({ message: { content: [{ type: "text", text: "  " }] } }, "{}", 1)).toEqual([]);
    expect(parseAssistant({ message: {} }, "{}", 1)).toEqual([]);
    expect(parseAssistant({}, "{}", 1)).toEqual([]);
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
  it("恢复用 --resume，有模型带 --model", () => {
    const args = buildClaudeArgs({ ...row, model: "sonnet", addDirs: [] }, { promptFile: "/p", env: {}, fingerprint: "" }, true);
    expect(args.slice(7, 11)).toEqual(["--resume", row.vendorSessionId, "--model", "sonnet"]);
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--effort");
  });
  it("有思考程度带 --effort，紧跟在 --model 后面；默认（null）的都不带", () => {
    const args = buildClaudeArgs({ ...row, model: "haiku", effort: "low" }, files, true);
    expect(args.slice(7, 13)).toEqual(["--resume", row.vendorSessionId, "--model", "haiku", "--effort", "low"]);
    const effortOnly = buildClaudeArgs({ ...row, effort: "max" }, files, true);
    expect(effortOnly.slice(9, 11)).toEqual(["--effort", "max"]);
    expect(effortOnly).not.toContain("--model");
    const neither = buildClaudeArgs(row, files, true);
    expect(neither).not.toContain("--model");
    expect(neither).not.toContain("--effort");
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
