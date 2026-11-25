import type { SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";
import { progressFrame, progressFrames } from "../../../../test/fixtures/progress/load.ts";
import { acpChecklistFromSessionUpdate, acpChecklistFromToolUpdate } from "./checklist.ts";

type Frame = { method: string; params: SessionNotification };
const toolOf = (frame: Frame): ToolCall | ToolCallUpdate => {
  const { update } = frame.params;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") throw new Error("Expected a tool frame");
  return update;
};

describe("ACP checklists", () => {
  it("reads Kimi plan entries only when the vendor declares plans", () => {
    const { params } = progressFrame<Frame>("kimi-plan.source-derived.json");
    expect(acpChecklistFromSessionUpdate("kimi", params.update)).toEqual({ kind: "replace", items: [
      { id: null, title: "Read probe", status: "in_progress" },
      { id: null, title: "Confirm marker", status: "pending" },
    ] });
    expect(acpChecklistFromSessionUpdate("cursor", params.update)).toBeNull();
  });

  it("reads DeepSeek tool input", () => {
    const frame = progressFrame<Frame>("deepseek-todo.source-derived.json");
    expect(acpChecklistFromToolUpdate("deepseek", "todo_write", toolOf(frame))).toMatchObject({
      kind: "replace", items: [{ title: "Read probe", status: "in_progress" }, { title: "Confirm marker", status: "pending" }],
    });
  });

  it("reads OpenCode input after pending and prefers the confirmed list on completion", () => {
    const [pending, running, completed] = progressFrames<Frame>("opencode-todo.live.jsonl");
    expect(acpChecklistFromToolUpdate("opencode", "todowrite", toolOf(pending!))).toBeNull();
    const update = acpChecklistFromToolUpdate("opencode", "todowrite", toolOf(running!));
    expect(update).toMatchObject({ kind: "replace", items: [{ title: "Read probe" }, { title: "Confirm marker" }, { title: "Reply" }] });
    expect(acpChecklistFromToolUpdate("opencode", "todowrite", { ...toolOf(completed!), rawInput: { todos: [] } })).toEqual(update);
  });

  it("uses Kimi's tool frames for a clear and has a single source for nonempty snapshots", () => {
    const tool = toolOf(progressFrame<Frame>("kimi-tool.source-derived.json"));
    expect(acpChecklistFromToolUpdate("kimi", "Updating todo list", tool)).toBeNull();
    expect(acpChecklistFromToolUpdate("kimi", "Updating todo list", { ...tool, rawInput: { todos: [] } }))
      .toEqual({ kind: "replace", items: [] });
    expect(acpChecklistFromToolUpdate("cursor", "updateTodos", tool)).toBeNull();
  });

  it("reads merged tool input when the update frame omits rawInput", () => {
    const [, running] = progressFrames<Frame>("opencode-todo.live.jsonl");
    const tool = toolOf(running!);
    const mergedInput = tool.rawInput;
    const withoutRawInput = { ...tool, rawInput: undefined };
    expect(acpChecklistFromToolUpdate("opencode", "todowrite", withoutRawInput)).toBeNull();
    expect(acpChecklistFromToolUpdate("opencode", "todowrite", withoutRawInput, mergedInput)).toMatchObject({
      kind: "replace",
      items: [{ title: "Read probe" }, { title: "Confirm marker" }, { title: "Reply" }],
    });
  });
});
