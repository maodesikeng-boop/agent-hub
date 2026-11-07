// 只读 Worker 的 claude 驱动部分（设计第 2.3、3 节）：default 模式 + --permission-prompt-tool stdio，要批准的工具 claude 发
// can_use_tool 控制请求；这里按 mcp_status 的 annotations 判断连接器工具，别的一律拒。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReadonlyPolicy, type ReadonlyPolicy } from "../../shared/index.ts";
import {
  MCP_STATUS_TIMEOUT_MS,
  ClaudeReadonlyGate,
  READONLY_DENY_MESSAGE,
  annotationsFromMcpStatus,
  mcpToolNameParts,
  normalizeMcpServerName,
} from "./claude-readonly.ts";

const policy = (connectors?: Partial<ReadonlyPolicy["connectors"]>) => buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s", connectors });

/** 真 claude 2.1.314 的 mcp_status 回应里的 mcpServers（形状见设计 1.1：annotations 是 {readOnly, destructive, openWorld}）。 */
const MCP_SERVERS = [
  {
    name: "claude.ai Slack",
    status: "connected",
    tools: [
      { name: "slack_search_public", annotations: { readOnly: true, destructive: false, openWorld: true } },
      { name: "slack_send_message", annotations: { readOnly: false, destructive: false, openWorld: true } },
    ],
  },
  {
    name: "rotest",
    status: "connected",
    tools: [
      { name: "ro_lookup", annotations: { readOnly: true } },
      { name: "rw_save", annotations: { readOnly: false } },
      { name: "plain_tool" },
      { name: "ro_but_destructive", annotations: { readOnly: true, destructive: true } },
    ],
  },
  { name: "jenkins", status: "pending", tools: [] },
];

interface Sent {
  type: string;
  request_id?: string;
  request?: { subtype: string };
  response?: { subtype: string; request_id: string; response: { behavior: string; updatedInput?: unknown; message?: string } };
}

function setup(p: ReadonlyPolicy = policy()) {
  const sent: Sent[] = [];
  const gate = new ClaudeReadonlyGate(p, (line) => sent.push(JSON.parse(line) as Sent));
  const canUse = (requestId: string, toolName: string, input: unknown = { a: 1 }, extra: Record<string, unknown> = {}) =>
    gate.onControlRequest({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: "toolu_1", ...extra } });
  /** 驱动发出去的 mcp_status 请求（取最后一个）。 */
  const statusRequests = () => sent.filter((s) => s.request?.subtype === "mcp_status");
  const answerStatus = (servers: unknown[] = MCP_SERVERS) => {
    const req = statusRequests().at(-1)!;
    return gate.onControlResponse({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { mcpServers: servers } } });
  };
  const answers = () => sent.filter((s) => s.type === "control_response");
  const answerOf = (requestId: string) => answers().find((a) => a.response!.request_id === requestId)?.response?.response;
  return { gate, sent, canUse, statusRequests, answerStatus, answers, answerOf };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("名字的处理", () => {
  it("连接器服务名按 claude 的规则换成工具名里的写法：不是字母数字 _ - 的换成 _", () => {
    expect(normalizeMcpServerName("claude.ai Slack")).toBe("claude_ai_Slack");
    expect(normalizeMcpServerName("rotest")).toBe("rotest");
    expect(normalizeMcpServerName("plugin:data:hex")).toBe("plugin_data_hex");
  });

  it("mcp__<服务器>__<工具>：优先用请求里的 mcp_server 拆；没有就在第一个 __ 处拆；不是 MCP 工具返回 null", () => {
    expect(mcpToolNameParts("mcp__claude_ai_Slack__slack_read_channel", "claude_ai_Slack")).toEqual({ server: "claude_ai_Slack", tool: "slack_read_channel" });
    expect(mcpToolNameParts("mcp__claude_ai_Slack__slack_read_channel", "claude.ai Slack")).toEqual({ server: "claude_ai_Slack", tool: "slack_read_channel" });
    expect(mcpToolNameParts("mcp__rotest__ro_lookup", undefined)).toEqual({ server: "rotest", tool: "ro_lookup" });
    expect(mcpToolNameParts("mcp__rotest__a__b", undefined)).toEqual({ server: "rotest", tool: "a__b" });
    expect(mcpToolNameParts("Bash", undefined)).toBeNull();
    expect(mcpToolNameParts("mcp__broken", undefined)).toBeNull();
  });

  it("mcp_status → 工具名表：键是完整工具名，annotations 换成通用形状（readOnly → readOnlyHint，destructive → destructiveHint）；残缺的跳过", () => {
    const table = annotationsFromMcpStatus({ mcpServers: [...MCP_SERVERS, { name: "bad" }, null, { name: "x", tools: [null, { name: 3 }] }] });
    expect(table.get("mcp__claude_ai_Slack__slack_search_public")).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(table.get("mcp__rotest__plain_tool")).toBeNull();
    expect(table.get("mcp__rotest__ro_but_destructive")).toEqual({ readOnlyHint: true, destructiveHint: true });
    expect(table.has("mcp__jenkins__anything")).toBe(false);
    expect(annotationsFromMcpStatus(undefined).size).toBe(0);
    expect(annotationsFromMcpStatus({ mcpServers: "no" }).size).toBe(0);
  });
});

describe("非连接器工具", () => {
  it("要批准的内置工具（Agent、Task、Skill……）一律拒，带中文原因，不去问 mcp_status", () => {
    const t = setup();
    expect(t.canUse("r1", "Agent")).toBe(true);
    expect(t.answerOf("r1")).toEqual({ behavior: "deny", message: READONLY_DENY_MESSAGE });
    expect(READONLY_DENY_MESSAGE).toMatch(/只读/);
    expect(t.statusRequests()).toHaveLength(0);
  });

  it("不是 can_use_tool 的控制请求不是我们的：返回 false，不回话", () => {
    const t = setup();
    expect(t.gate.onControlRequest({ type: "control_request", request_id: "r1", request: { subtype: "hook_callback" } })).toBe(false);
    expect(t.gate.onControlRequest({ type: "control_request", request: { subtype: "can_use_tool", tool_name: "Bash" } })).toBe(false);
    expect(t.sent).toEqual([]);
  });
});

describe("连接器工具：按 mcp_status 的 annotations", () => {
  it("第一次：先发 mcp_status，回来后按 annotations 回 allow（带原 input）/deny；同一批问的都答", () => {
    const t = setup();
    t.canUse("r1", "mcp__claude_ai_Slack__slack_search_public", { query: "x" }, { mcp_server: "claude_ai_Slack" });
    t.canUse("r2", "mcp__claude_ai_Slack__slack_send_message", { text: "hi" });
    t.canUse("r3", "mcp__rotest__plain_tool");
    expect(t.statusRequests()).toHaveLength(1); // 在等回执时不重复问
    expect(t.answers()).toHaveLength(0);
    expect(t.answerStatus()).toBe(true);
    expect(t.answerOf("r1")).toEqual({ behavior: "allow", updatedInput: { query: "x" } });
    expect(t.answerOf("r2")).toEqual({ behavior: "deny", message: READONLY_DENY_MESSAGE });
    expect(t.answerOf("r3")).toEqual({ behavior: "deny", message: READONLY_DENY_MESSAGE }); // 没标记当不能用
  });

  it("回执 envelope：type control_response、subtype success、request_id 和 response.behavior", () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    t.answerStatus();
    expect(t.answers()[0]).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { a: 1 } } },
    });
  });

  it("之后表里有的工具直接答，不再问；声明了 destructive 的不放", () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    t.answerStatus();
    t.canUse("r2", "mcp__rotest__ro_lookup");
    t.canUse("r3", "mcp__rotest__ro_but_destructive");
    expect(t.statusRequests()).toHaveLength(1);
    expect(t.answerOf("r2")?.behavior).toBe("allow");
    expect(t.answerOf("r3")?.behavior).toBe("deny");
  });

  it("表里查不到的工具名（新连上的服务器、tools/list_changed）再问一次；再没有就按没标记算", () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    t.answerStatus();
    t.canUse("r2", "mcp__late__ro_new");
    expect(t.statusRequests()).toHaveLength(2);
    t.answerStatus([...MCP_SERVERS, { name: "late", status: "connected", tools: [{ name: "ro_new", annotations: { readOnly: true } }] }]);
    expect(t.answerOf("r2")?.behavior).toBe("allow");
    t.canUse("r3", "mcp__still_unknown__x");
    t.answerStatus();
    expect(t.statusRequests()).toHaveLength(3);
    expect(t.answerOf("r3")?.behavior).toBe("deny");
  });

  it("手动补充、手动排除不用等 annotations，直接答（不发 mcp_status）：补充的放行没标记的，排除的压过标了只读的", () => {
    const t = setup(policy({ extraAllow: ["rotest/plain_tool", "jenkins/*"], deny: ["claude_ai_Slack/slack_search_public"] }));
    t.canUse("r1", "mcp__rotest__plain_tool");
    t.canUse("r2", "mcp__claude_ai_Slack__slack_search_public");
    t.canUse("r3", "mcp__jenkins__get_build");
    expect(t.statusRequests()).toHaveLength(0);
    expect(t.answerOf("r1")?.behavior).toBe("allow");
    expect(t.answerOf("r2")?.behavior).toBe("deny");
    expect(t.answerOf("r3")?.behavior).toBe("allow");
  });

  it("mcp_status 回了 error：按没有 annotations 处理（没标记的拒），不卡住", () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    const req = t.statusRequests().at(-1)!;
    t.gate.onControlResponse({ type: "control_response", response: { subtype: "error", request_id: req.request_id, error: "boom" } });
    expect(t.answerOf("r1")?.behavior).toBe("deny");
  });

  it(`mcp_status 一直不回：${MCP_STATUS_TIMEOUT_MS} 毫秒后按没有 annotations 处理，不让这一轮卡死`, () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    t.canUse("r2", "mcp__rotest__plain_tool");
    vi.advanceTimersByTime(MCP_STATUS_TIMEOUT_MS - 1);
    expect(t.answers()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(t.answerOf("r1")?.behavior).toBe("deny");
    expect(t.answerOf("r2")?.behavior).toBe("deny");
  });

  it("别人的 control_response（不是我们发的 mcp_status）不认", () => {
    const t = setup();
    expect(t.gate.onControlResponse({ type: "control_response", response: { subtype: "success", request_id: "other", response: {} } })).toBe(false);
    t.canUse("r1", "mcp__rotest__ro_lookup");
    expect(t.gate.onControlResponse({ type: "control_response", response: { subtype: "success", request_id: "other", response: {} } })).toBe(false);
    expect(t.answers()).toHaveLength(0);
  });
});

describe("dispose", () => {
  it("进程退了：没答的丢掉、计时器清掉，之后的回执不再写", () => {
    const t = setup();
    t.canUse("r1", "mcp__rotest__ro_lookup");
    t.gate.dispose();
    vi.advanceTimersByTime(MCP_STATUS_TIMEOUT_MS * 2);
    expect(t.answers()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
