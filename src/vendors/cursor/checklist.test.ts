import { describe, it } from "vitest";

describe("Cursor checklist", () => {
  it.todo("the first cursor/update_todos request (merge false) yields a replace update keyed by todo id");
  it.todo("later requests with merge true yield merge updates");
  it.todo("a cursor/update_todos request with an id is answered with an empty result instead of cancelled");
  it.todo("a cursor/update_todos notification without an id is also parsed");
  it.todo("the updateTodos tool call is classified by rawInput._toolName and hidden from actions");
  it.todo("cursor/create_plan is still rejected exactly as before");
});
