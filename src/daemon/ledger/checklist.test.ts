import { describe, it } from "vitest";

describe("ledger checklist", () => {
  it.todo("agent.checklist inserts a collapsed checklist message with the full snapshot and pushes message.created");
  it.todo("a merge update applies to the session's latest stored snapshot from an earlier turn");
  it.todo("an unchanged snapshot inserts nothing");
  it.todo("a replayed uuid inserts nothing");
  it.todo("subtask events and sessions without a conversation insert nothing");
  it.todo("todo-classified tool calls store no tool message, no session step, and leave the live step unchanged");
  it.todo("PM tool message retention also prunes checklist messages");
  it.todo("handover and vendor-switch context skip checklist messages");
});

describe("live step start time", () => {
  it.todo("agent.tool without pending sets stepStartedAt to startedAt or the event time");
  it.todo("agent.tool with pending publishes stepStartedAt null until agent.tool_running");
  it.todo("thinking and text steps start their own clock when the shown step changes");
  it.todo("finishing one of two parallel tools shows the other tool with its own start time");
  it.todo("the tool hold below MIN_TOOL_STEP_VISIBLE_MS keeps the held step's start time");
  it.todo("idle clears stepStartedAt");
  it.todo("stepStartedAt never follows lastEventAt");
});
