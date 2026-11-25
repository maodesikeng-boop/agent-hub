import { describe, it } from "vitest";

describe("checklistFromTodoList", () => {
  it.todo("reads content and activeForm items (TodoWrite, todo_write, todowrite)");
  it.todo("reads title items (Kimi TodoList) and id plus content items (cursor/update_todos)");
  it.todo("returns a replace update with zero items for an empty todos array");
  it.todo("returns null when todos is missing or not an array, such as the empty first OpenCode rawInput");
  it.todo("drops items whose status does not normalize");
});

describe("isChecklistTool", () => {
  it.todo("is true only for todo-classified tools of vendors that declare the todo_tool source");
});

describe("checklist launch switches", () => {
  it.todo("checklistLaunchArgs returns the declared args, or an empty list");
  it.todo("withChecklistEnv sets plain values and leaves other variables alone");
  it.todo("withChecklistEnv appends an appendToList value to an existing comma list once");
});
