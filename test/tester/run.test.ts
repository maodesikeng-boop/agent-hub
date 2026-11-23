import { describe, it } from "vitest";

describe("runTester", () => {
  it.todo("throws on a config that fails the production guards before touching any instance");
  it.todo("appends one record to history and writes summary.md and summary.json under runs/latest");
  it.todo("runs flows one at a time and groups them by local CLI mode to limit restarts");
  it.todo("aborts a flow past its timeout and records it as product_fail with reason timeout");
  it.todo("records a flow whose needs failed preflight without running it");
  it.todo("deploys the remote to the local commit for pr and rc runs");
});
