import { describe, expect, it } from "vitest";
import { vendorSpec } from "../../shared/vendors.ts";
import { checklistFromTodoList, checklistLaunchArgs, isChecklistTool, withChecklistEnv } from "./checklist.ts";

describe("todo payloads", () => {
  it("accepts titles and active descriptions while dropping malformed items", () => {
    expect(checklistFromTodoList({ todos: [
      { content: "Read", status: "pending", activeForm: "Reading" },
      { id: "2", title: "Write", status: "done" },
      { content: "Unknown", status: "?" },
      null,
    ] })).toEqual({ kind: "replace", items: [
      { id: null, title: "Read", status: "pending", activeTitle: "Reading" },
      { id: "2", title: "Write", status: "completed" },
    ] });
  });

  it("distinguishes an explicit clear from a pending frame without input", () => {
    expect(checklistFromTodoList({ todos: [] })).toEqual({ kind: "replace", items: [] });
    expect(checklistFromTodoList({})).toBeNull();
    expect(checklistFromTodoList({ todos: "pending" })).toBeNull();
    expect(checklistFromTodoList({ todos: [{ content: "Invalid", status: "?" }] })).toBeNull();
  });

  it("reads tools only for specs that use tool frames as a checklist source", () => {
    expect(isChecklistTool(vendorSpec("opencode"), "todowrite")).toBe(true);
    expect(isChecklistTool(vendorSpec("opencode"), "read")).toBe(false);
    expect(isChecklistTool(vendorSpec("cursor"), "updateTodos")).toBe(false);
  });
});

describe("checklist launch switches", () => {
  it("preserves unrelated env and existing flags without duplicates", () => {
    const spec = vendorSpec("opencode");
    const env = { OPENCODE_FLAGS: "other", PATH: "test" };
    expect(withChecklistEnv(spec, env)).toEqual({ ...env, OPENCODE_FLAGS: "other,todo" });
    expect(withChecklistEnv(spec, { OPENCODE_FLAGS: "other, todo" })).toEqual({ OPENCODE_FLAGS: "other, todo" });
    expect(env.OPENCODE_FLAGS).toBe("other");
    expect(withChecklistEnv(spec, { opencode_flags: "other" }, "win32")).toEqual({ OPENCODE_FLAGS: "other,todo" });
    expect(withChecklistEnv(vendorSpec("claude"), env)).toEqual({ ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
    expect(checklistLaunchArgs(vendorSpec("pi"))).toEqual([]);
  });
});
