import { describe, expect, it } from "vitest";
import { progressFrames } from "../../../test/fixtures/progress/load.ts";
import { CURSOR_UPDATE_TODOS_METHOD, cursorChecklistFromUpdateTodos, cursorToolNameOf } from "./checklist.ts";

type Frame = { method: string; params: { update?: { rawInput?: unknown } } };

describe("Cursor checklist", () => {
  it("replaces the first full list and merges later id-keyed updates", () => {
    const frames = progressFrames<Frame>("cursor-todo.live.jsonl");
    const [first, second, third] = frames.filter(({ method }) => method === CURSOR_UPDATE_TODOS_METHOD)
      .map(({ params }) => cursorChecklistFromUpdateTodos(params));
    expect(first).toEqual({ kind: "replace", items: [
      { id: "1", title: "Read probe", status: "in_progress" },
      { id: "2", title: "Confirm marker", status: "pending" },
      { id: "3", title: "Reply", status: "pending" },
    ] });
    expect(second).toMatchObject({ kind: "merge", items: [
      { id: "1", status: "completed" }, { id: "2", status: "in_progress" }, { id: "3", status: "pending" },
    ] });
    expect(third).toMatchObject({ kind: "merge", items: [
      { id: "1", status: "completed" }, { id: "2", status: "completed" }, { id: "3", status: "completed" },
    ] });
    expect(cursorToolNameOf(frames[0]?.params.update?.rawInput)).toBe("updateTodos");
    expect(cursorChecklistFromUpdateTodos({ merge: true, todos: [{ id: "1", status: "done" }] }))
      .toEqual({ kind: "merge", items: [{ id: "1", status: "completed" }] });
  });
});
