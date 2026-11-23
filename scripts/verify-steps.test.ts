import { describe, it } from "vitest";

describe("digestOf", () => {
  it.todo("keeps only the named conversations and their messages, in id order");
});

describe("lostAfterRestart", () => {
  it.todo("returns nothing when every conversation and message survived unchanged");
  it.todo("names a conversation that disappeared");
  it.todo("names a message that disappeared or whose text or status changed");
  it.todo("ignores messages that only exist after the restart");
});

describe("sendAndAwaitReply", () => {
  it.todo("resolves with the reply id once the fake claude's reply renders and the user message is replied");
  it.todo("rejects naming the step that timed out");
});
