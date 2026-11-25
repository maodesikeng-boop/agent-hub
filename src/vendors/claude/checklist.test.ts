import { describe, expect, it } from "vitest";
import { progressFrames } from "../../../test/fixtures/progress/load.ts";
import { applyChecklistUpdate } from "../../shared/checklist.ts";
import { CHECKLIST_PENDING_CALLS_MAX } from "../../shared/limits.ts";
import { claudeChecklistFromToolResult, claudeChecklistFromToolUse, createClaudeChecklistState } from "./checklist.ts";
import { parseAssistant, parseToolResults } from "./protocol.ts";

type Frame = Record<string, unknown>;

describe("Claude checklist", () => {
  it("replays the requested and confirmed TodoWrite lists", () => {
    const state = createClaudeChecklistState();
    const frames = progressFrames<Frame>("claude-todowrite.live.jsonl");
    const updates = frames.flatMap((frame) => {
      if (frame.type === "assistant") {
        return parseAssistant(frame, "", 0).flatMap((event) => event.type === "agent.tool" ? [claudeChecklistFromToolUse(state, event)] : []);
      }
      const result = parseToolResults(frame, 0);
      return result?.toolUseIds.map((id) => claudeChecklistFromToolResult(state, id, frame.tool_use_result)) ?? [];
    }).filter((update) => update !== null);
    expect(updates).toHaveLength(6);
    expect(updates[0]).toMatchObject({
      kind: "replace",
      items: expect.arrayContaining([expect.objectContaining({ title: "Read probe", activeTitle: "Reading probe", status: "in_progress" })]),
    });
    expect(updates[1]).toEqual(updates[0]);
    expect(updates[5]).toEqual(updates[4]);
    expect(claudeChecklistFromToolResult(state, "unknown", { newTodos: [{ content: "Other tool", status: "pending" }] })).toBeNull();
  });

  it("uses the confirmed task id, applies partial changes, and removes deleted tasks", () => {
    const state = createClaudeChecklistState();
    const create = { name: "TaskCreate", input: { subject: "Read", activeForm: "Reading" }, toolUseId: "call" };
    expect(claudeChecklistFromToolUse(state, create)).toBeNull();
    expect(claudeChecklistFromToolResult(state, "different", { task: { id: "7" } })).toBeNull();
    expect(claudeChecklistFromToolResult(state, "call", { task: { id: "1" } })).toEqual({
      kind: "merge", items: [{ id: "1", title: "Read", activeTitle: "Reading", status: "pending" }],
    });
    expect(state.pending.size).toBe(0);
    const update = { name: "TaskUpdate", toolUseId: "update", input: { taskId: "1", status: "in_progress" } };
    expect(claudeChecklistFromToolUse(state, update)).toEqual({ kind: "merge", items: [{ id: "1", status: "in_progress" }] });
    expect(claudeChecklistFromToolUse(state, { ...update, input: { ...update.input, status: "deleted" } }))
      .toEqual({ kind: "remove", ids: ["1"] });
  });

  it("forgets the oldest unresolved create when the limit is reached", () => {
    const state = createClaudeChecklistState();
    for (let i = 0; i <= CHECKLIST_PENDING_CALLS_MAX; i++) {
      claudeChecklistFromToolUse(state, { name: "TaskCreate", toolUseId: String(i), input: { subject: "Read" } });
    }
    expect(state.pending.size).toBe(CHECKLIST_PENDING_CALLS_MAX);
    expect(claudeChecklistFromToolResult(state, "0", { task: { id: "lost" } })).toBeNull();
  });

  it("ignores whitespace-only TaskUpdate subjects and clears activeTitle on explicit null", () => {
    const state = createClaudeChecklistState();
    const prev = [{ id: "1", title: "Read", activeTitle: "Reading", status: "in_progress" as const }];
    const blankSubject = claudeChecklistFromToolUse(state, {
      name: "TaskUpdate",
      toolUseId: "u1",
      input: { taskId: "1", subject: "   ", activeForm: null, status: "completed" },
    });
    expect(blankSubject).toEqual({ kind: "merge", items: [{ id: "1", activeTitle: null, status: "completed" }] });
    expect(applyChecklistUpdate(prev, blankSubject!)).toEqual([{ id: "1", title: "Read", activeTitle: null, status: "completed" }]);
  });
});
