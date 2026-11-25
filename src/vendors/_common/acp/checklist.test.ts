import { describe, it } from "vitest";

describe("acpChecklistFromSessionUpdate", () => {
  it.todo("turns the Kimi plan fixture into a replace update with completed for done entries");
  it.todo("ignores plan updates from vendors that do not declare plan_update");
  it.todo("returns null for non-plan session updates");
});

describe("acpChecklistFromToolUpdate", () => {
  it.todo("reads rawInput.todos from the DeepSeek todo_write fixture");
  it.todo("returns null for the empty pending OpenCode todowrite frame and reads the in_progress frame");
  it.todo("reads rawOutput.metadata.todos from the completed OpenCode frame");
  it.todo("reads the Kimi TodoList tool frame and treats an empty todos array as a clear");
  it.todo("ignores Cursor rawInput todos because Cursor declares only the extension source");
});

describe("ACP turn stream", () => {
  it.todo("emits agent.checklist from a plan update and from a todo tool frame");
  it.todo("emits agent.tool with pending for a pending first frame and agent.tool_running on the first in_progress frame");
  it.todo("emits agent.tool without pending when the first frame is already in_progress");
  it.todo("routes an extension method parsed by config.checklist.fromExtension to agent.checklist and answers a request with an empty result");
});
