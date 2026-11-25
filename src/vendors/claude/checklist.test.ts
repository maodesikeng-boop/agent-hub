import { describe, it } from "vitest";

describe("Claude checklist", () => {
  it.todo("TodoWrite tool_use yields a replace update with activeForm as activeTitle");
  it.todo("TodoWrite tool_use_result newTodos yields the confirmed replace update");
  it.todo("TaskCreate waits for tool_use_result.task.id, then merges a pending item with the subject");
  it.todo("TaskUpdate merges the status change for taskId and a deleted status removes the item");
  it.todo("pending TaskCreate records stay within CHECKLIST_PENDING_CREATES_MAX");
  it.todo("subagent tool_use blocks yield no checklist update");
  it.todo("the driver replays claude-task-tools.live.jsonl into agent.checklist events and timed agent.tool events");
  it.todo("the launch environment sets CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
});
