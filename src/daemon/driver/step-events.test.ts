// 驱动层给账本的“在做什么”事件：thinking、工具调用、工具结果、子任务；脏的 tool_result 跳过。
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./test-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });

describe("thinking、工具调用、工具结果", () => {
  it("事件顺序和 claude 发的一样：thinking → 工具 → 工具结果 → 文字", async () => {
    h = makeHarness({
      script: {
        defaultTurn: {
          steps: [{ thinking: true }, { tool: { name: "Read", input: { file_path: "/a/b.ts" }, result: "内容" } }, { text: "读完了" }],
        },
      },
    });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "hi"));
    await h.waitFor("turn.ended");
    const types = h.events.map((e) => e.event.type).filter((x) => ["agent.thinking", "agent.tool", "agent.tool_result", "agent.text"].includes(x));
    expect(types).toEqual(["agent.thinking", "agent.tool", "agent.tool_result", "agent.text"]);
    const [tool] = h.of("agent.tool");
    const [result] = h.of("agent.tool_result");
    expect(result!.toolUseIds).toEqual([tool!.toolUseId]);
    expect(result).not.toHaveProperty("parentToolUseId");
    expect(h.of("driver.error")).toEqual([]);
  });

  it("没有 tool_use_id 的脏 tool_result：不出事件、不报错，这一轮照常", async () => {
    h = makeHarness({
      script: {
        defaultTurn: {
          steps: [
            { raw: JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] }, parent_tool_use_id: null }) },
            { raw: JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: 7 }] } }) },
            { text: "好了" },
          ],
        },
      },
    });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "hi"));
    const ended = await h.waitFor("turn.ended");
    expect(ended.ok).toBe(true);
    expect(h.of("agent.tool_result")).toEqual([]);
    expect(h.of("driver.error")).toEqual([]);
  });

  it("子任务里的 assistant、tool_result 带 parentToolUseId", async () => {
    h = makeHarness({
      script: {
        defaultTurn: {
          steps: [
            {
              raw: JSON.stringify({
                type: "assistant",
                uuid: "sub-1",
                parent_tool_use_id: "toolu_agent",
                message: { content: [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "ls" } }] },
              }),
            },
            {
              raw: JSON.stringify({
                type: "user",
                parent_tool_use_id: "toolu_agent",
                message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "" }] },
              }),
            },
            { text: "好了" },
          ],
        },
      },
    });
    const s = h.addSession();
    await h.driver.send(s.id, user(1, "hi"));
    await h.waitFor("turn.ended");
    expect(h.of("agent.tool")[0]).toMatchObject({ name: "Bash", parentToolUseId: "toolu_agent" });
    expect(h.of("agent.tool_result")[0]).toMatchObject({ toolUseIds: ["toolu_sub"], parentToolUseId: "toolu_agent" });
    expect(h.of("agent.text")[0]).not.toHaveProperty("parentToolUseId");
  });
});
