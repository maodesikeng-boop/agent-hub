import { describe, it } from "vitest";

describe("benchRoot", () => {
  it.todo("uses BELLWOOD_TESTER_HOME when set");
  it.todo("falls back to .bellwood-tester under the home directory");
});

describe("parseBenchConfig", () => {
  it.todo("accepts a complete version 1 config");
  it.todo("names the first invalid field");
  it.todo("rejects unknown fields");
});

describe("assertNotProduction", () => {
  it.todo("rejects a local data dir equal to a guarded data dir");
  it.todo("rejects a local data dir inside a guarded data dir and a guarded data dir inside a local one");
  it.todo("compares paths case-insensitively after resolving symlinks");
  it.todo("rejects a guarded UI port or mesh port");
  it.todo("rejects a test bot app id that is guarded");
  it.todo("rejects a test GitHub login that is guarded");
  it.todo("rejects a local data dir outside the bench root");
});

describe("openBench", () => {
  it.todo("refuses to hand out clients when an instance reports another GitHub login");
  it.todo("reports an unreachable instance as a bench config error, not a product failure");
  it.todo("starts the local instance from codeDir in the requested CLI mode with its own HOME");
});
