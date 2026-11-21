import { describe, it } from "vitest";

describe("daemon turn completion recovery", () => {
  it.todo("settles after an injected terminal write failure without another turn or a second fake CLI prompt");
  it.todo("runs a subsequent scheduled occurrence after the previous occurrence settles");
  it.todo("recovers a committed receipt after a daemon crash without sending the settled prompt again");
  it.todo("does not resend a receipted message when its status write still fails at startup");
});
