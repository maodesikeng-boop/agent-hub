// 不起进程的部分：写入的那一行、拼消息、读 assistant 事件、额度、启动参数和环境。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentSessionRow } from "../../shared/index.ts";
import {
  buildClaudeArgs,
  buildChildEnv,
  buildInterruptLine,
  buildUserLine,
  checkUserLine,
  lineUuid,
  mergeUserTexts,
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
  it("缺字段也不崩", () => {
    expect(parseRateLimit(undefined)).toEqual({ status: "unknown", resetsAt: null, windows: {} });
  });
});

const row: AgentSessionRow = {
  id: 1,
  role: "pm",
  conversationId: 1,
  ticketId: null,
  vendor: "claude",
  vendorSessionId: "11111111-1111-4111-8111-111111111111",
  cwd: "/tmp/pm",
  addDirs: ["/a", "/b"],
  generation: 1,
  model: null,
  pid: null,
  status: "idle",
  hasCompletedTurn: false,
  lastEventAt: null,
  rateLimit: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("启动参数", () => {
  const files = { promptFile: "/l/prompt.md", settingsFile: "/l/settings.json", mcpConfigFile: "/l/mcp.json" };
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
      "--strict-mcp-config",
      "--mcp-config",
      "/l/mcp.json",
    ]);
  });
  it("恢复用 --resume，有模型带 --model", () => {
    const args = buildClaudeArgs({ ...row, model: "sonnet", addDirs: [] }, { promptFile: "/p", mcpConfigFile: "/m" }, true);
    expect(args.slice(7, 11)).toEqual(["--resume", row.vendorSessionId, "--model", "sonnet"]);
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--add-dir");
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
