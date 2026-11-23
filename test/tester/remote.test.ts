import { describe, it } from "vitest";

describe("remoteArgv", () => {
  it.todo("maps each command to its words");
  it.todo("rejects a commit that is not 40 lowercase hex characters");
  it.todo("rejects a line count outside 1..2000");
});

describe("createRemoteControl", () => {
  it.todo("runs ssh with the alias and the checked words, without a shell");
  it.todo("rejects with the remote's stderr on a non-zero exit");
  it.todo("rejects after timeoutMs and kills the ssh process");
});
