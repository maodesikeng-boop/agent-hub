// 只读 Worker 的 claude 驱动接线（假 claude）：LaunchFiles.readonly 有 → 启动参数带 --permission-prompt-tool stdio，
// 假 claude 发 can_use_tool，驱动按 mcp_status 的 annotations 回 allow/deny；没有 readonly 的会话照旧（不带参数、不回话）。
import { afterEach, describe, expect, it } from "vitest";
import { buildReadonlyPolicy } from "../../shared/index.ts";
import type { FakeScript } from "../../../test/fake-claude/fake-claude.ts";
import { makeHarness, realSleep, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const canUse = (requestId: string, toolName: string, input: unknown = { x: 1 }, mcpServer?: string) =>
  JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: `toolu_${requestId}`, ...(mcpServer ? { mcp_server: mcpServer } : {}) },
  });

const script = (extra: Partial<FakeScript> = {}): FakeScript => ({
  mcpServers: [
    {
      name: "claude.ai Slack",
      status: "connected",
      tools: [
        { name: "slack_search_public", annotations: { readOnly: true, destructive: false, openWorld: true } },
        { name: "slack_send_message", annotations: { readOnly: false, destructive: false, openWorld: true } },
      ],
    },
    { name: "jenkins", status: "connected", tools: [{ name: "get_build" }] },
  ],
  turns: [
    {
      steps: [
        { raw: canUse("cu1", "mcp__claude_ai_Slack__slack_search_public", { query: "x" }, "claude_ai_Slack") },
        { raw: canUse("cu2", "mcp__claude_ai_Slack__slack_send_message") },
        { raw: canUse("cu3", "Agent") },
        { raw: canUse("cu4", "mcp__jenkins__get_build") },
        { sleepMs: 300 },
        { text: "查完了" },
      ],
    },
  ],
  ...extra,
});

/** 假 claude 收到的 control_response 里的回话：request_id → response.response。 */
function answers(t: Harness): Record<string, { behavior: string; updatedInput?: unknown; message?: string }> {
  const out: Record<string, { behavior: string; updatedInput?: unknown; message?: string }> = {};
  for (const e of t.log()) {
    if (e.kind !== "stdin") continue;
    const obj = JSON.parse(e.line) as { type: string; response?: { request_id: string; response: { behavior: string } } };
    if (obj.type === "control_response" && obj.response) out[obj.response.request_id] = obj.response.response;
  }
  return out;
}

describe("只读 Worker：can_use_tool", () => {
  it("启动参数带 --permission-prompt-tool stdio；连接器工具按 mcp_status 的 annotations 回话，别的工具拒（带原因）", async () => {
    h = makeHarness({ script: script() });
    h.launch.readonly = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "查一下" });
    await h.waitFor("turn.ended");
    const argv = h.argvs()[0]!;
    expect(argv.slice(argv.indexOf("--permission-prompt-tool"), argv.indexOf("--permission-prompt-tool") + 2)).toEqual(["--permission-prompt-tool", "stdio"]);
    const a = answers(h);
    expect(a.cu1).toEqual({ behavior: "allow", updatedInput: { query: "x" } }); // 服务名 "claude.ai Slack" → claude_ai_Slack 对上了
    expect(a.cu2?.behavior).toBe("deny");
    expect(a.cu3?.behavior).toBe("deny");
    expect(a.cu3?.message).toMatch(/只读/);
    expect(a.cu4?.behavior).toBe("deny"); // jenkins 的工具没标记
  });

  it("手动补充的工具放行（策略里的 extraAllow）", async () => {
    h = makeHarness({ script: script() });
    h.launch.readonly = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s", connectors: { extraAllow: ["jenkins/*"] } });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "查一下" });
    await h.waitFor("turn.ended");
    expect(answers(h).cu4?.behavior).toBe("allow");
  });

  it("没有 readonly 的会话：不带 --permission-prompt-tool，也不回 can_use_tool", async () => {
    h = makeHarness({ script: script() });
    const s = h.addSession();
    await h.driver.send(s.id, { messageIds: [1], source: "user", text: "查一下" });
    await h.waitFor("turn.ended");
    await realSleep(50);
    expect(h.argvs()[0]).not.toContain("--permission-prompt-tool");
    expect(answers(h)).toEqual({});
  });
});
