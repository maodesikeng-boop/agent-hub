import { describe, expect, it } from "vitest";
import { HUB_HELP_ONLY_COMMANDS } from "../shared/hub.ts";
import { UsageError } from "./args.ts";
import { parseCommand } from "./parse.ts";
import { HUB_USAGE } from "./usage.ts";

const parse = (...argv: string[]) => parseCommand(argv, {}, "/tmp");

describe("hub watch", () => {
  it("parses a poll, a run-once, and a timer watch with the body from stdin", () => {
    expect(parse("watch", "add", "--until", "check-ready", "--every", "15s", "--max", "2h", "--graph", "141", "--stdin")).toEqual({
      command: "watch.add",
      body: { until: "check-ready", everyMs: 15_000, maxMs: 7_200_000, graphId: 141 },
      textSource: { kind: "stdin" },
      textField: "body",
    });
    expect(parse("watch", "add", "--until", "wait-for-checks", "--worker", "7", "--stdin")).toMatchObject({
      body: { until: "wait-for-checks", workerId: 7 },
    });
    expect(parse("watch", "add", "--after", "30m", "--stdin")).toMatchObject({ body: { afterMs: 1_800_000 } });
  });

  it("parses list and close", () => {
    expect(parse("watch", "list")).toEqual({ command: "watch.list", body: {}, textSource: null });
    expect(parse("watch", "close", "3")).toEqual({ command: "watch.close", body: { watchId: 3 }, textSource: null });
  });

  it("refuses ambiguous or malformed conditions", () => {
    expect(() => parse("watch", "add", "--stdin")).toThrow(UsageError);
    expect(() => parse("watch", "add", "--until", "x", "--after", "5m", "--stdin")).toThrow(/--until.*--after/u);
    expect(() => parse("watch", "add", "--after", "5m", "--every", "1m", "--stdin")).toThrow(/--every/u);
    expect(() => parse("watch", "add", "--until", "x", "--every", "soon", "--stdin")).toThrow(/--every/u);
    expect(() => parse("watch", "add", "--until", "x", "--graph", "1", "--worker", "2", "--stdin")).toThrow(/--graph.*--worker/u);
    expect(() => parse("watch", "add", "--until", "x")).toThrow(/--stdin/u);
  });

  it("is documented in help only, so the system prompt does not change", () => {
    for (const command of ["watch.add", "watch.list", "watch.close"] as const) expect(command in HUB_HELP_ONLY_COMMANDS).toBe(true);
    expect(HUB_USAGE).toContain("hub watch add");
  });
});
