import { describe, expect, it } from "vitest";
import type { GhRunOptions, GhRunResult } from "../src/daemon/git/gh.ts";
import { main, parsePostStampArgs, type PostStampDeps } from "./post-review-stamp.ts";
import { REVIEW_STATUS_CONTEXT } from "./review-stamp-gate.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PR_URL = "https://github.com/maodesikeng-boop/agent-hub/pull/420";

function makeDeps(responder: (args: readonly string[], options: GhRunOptions) => GhRunResult) {
  const calls: Array<{ args: readonly string[]; options: GhRunOptions }> = [];
  const logs: string[] = [];
  const deps: PostStampDeps = {
    cwd: "/repo",
    log: (line) => logs.push(line),
    execGh: async (_cwd, args, options) => {
      calls.push({ args, options });
      return responder(args, options);
    },
  };
  return { deps, calls, logs };
}

describe("parsePostStampArgs", () => {
  it("parses PR number, full SHA, and defaults", () => {
    expect(parsePostStampArgs(["#420", "--sha", SHA.toUpperCase()])).toEqual({
      pr: 420,
      sha: SHA,
      state: "success",
      account: null,
      description: "Independent Bellwood review: PASS on this commit",
      dryRun: false,
    });
  });

  it("rejects missing, blank, or invalid arguments and token-shaped accounts", () => {
    expect(parsePostStampArgs([])).toContain("usage:");
    expect(parsePostStampArgs(["420", "--sha", "abc1234"])).toContain("40-character");
    expect(parsePostStampArgs(["420", "--sha", SHA, "--state", "pending"])).toContain("success or failure");
    expect(parsePostStampArgs(["420", "--sha", SHA, "--account", "   "])).toContain("requires a value");
    expect(parsePostStampArgs(["420", "--sha", SHA, "--account", "ghp_secret1234567890123456"])).toContain("not a token");
  });
});

describe("post-review-stamp main", () => {
  it("posts bellwood/review success on the verified PR head and passes --account token via GH_TOKEN only", async () => {
    const { deps, calls, logs } = makeDeps((args) => {
      if (args[0] === "auth") return { kind: "ok", stdout: "gho_supersecret1234567890\n" };
      if (args[0] === "pr") return { kind: "ok", stdout: JSON.stringify({ number: 420, url: PR_URL, headRefOid: SHA }) };
      return { kind: "ok", stdout: "" };
    });

    expect(await main(["420", "--sha", SHA, "--account", "maodesikeng-boop"], deps)).toBe(0);
    expect(calls.map((c) => c.args[0])).toEqual(["auth", "pr", "api"]);
    expect(calls[0]!.args).toEqual(["auth", "token", "--user", "maodesikeng-boop"]);
    expect(calls[1]!.options.env).toEqual({ GH_TOKEN: "gho_supersecret1234567890" });
    expect(calls[2]!.args).toEqual([
      "api",
      "--method",
      "POST",
      `repos/maodesikeng-boop/agent-hub/statuses/${SHA}`,
      "--silent",
      "-f",
      "state=success",
      "-f",
      `context=${REVIEW_STATUS_CONTEXT}`,
      "-f",
      "description=Independent Bellwood review: PASS on this commit",
      "-f",
      `target_url=${PR_URL}`,
    ]);
    expect(calls[2]!.options.env).toEqual({ GH_TOKEN: "gho_supersecret1234567890" });
    expect(calls[2]!.args.join(" ")).not.toContain("gho_supersecret");
    expect(logs.join("\n")).not.toContain("gho_supersecret");
    expect(JSON.parse(logs[0]!)).toMatchObject({ pr: 420, sha: SHA, context: REVIEW_STATUS_CONTEXT, state: "success", posted: true });
  });

  it("refuses to stamp when the PR head moved away from --sha", async () => {
    const { deps, calls, logs } = makeDeps(() => ({
      kind: "ok",
      stdout: JSON.stringify({ number: 420, url: PR_URL, headRefOid: OTHER_SHA }),
    }));
    expect(await main(["420", "--sha", SHA], deps)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs[0]).toContain("refusing to stamp a moved head");
  });

  it("redacts token-shaped text in gh error output", async () => {
    const { deps, logs } = makeDeps(() => ({
      kind: "failed",
      code: 1,
      stderr: "HTTP 401 with ghp_1234567890abcdef123456",
      timedOut: false,
      missing: false,
    }));
    expect(await main(["420", "--sha", SHA], deps)).toBe(1);
    expect(logs[0]).toContain("[redacted]");
    expect(logs[0]).not.toContain("ghp_1234567890");
  });

  it("supports --dry-run without posting", async () => {
    const { deps, calls, logs } = makeDeps(() => ({
      kind: "ok",
      stdout: JSON.stringify({ number: 420, url: PR_URL, headRefOid: SHA }),
    }));
    expect(await main(["420", "--sha", SHA, "--state", "failure", "--dry-run"], deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ dryRun: true, state: "failure", description: "Independent Bellwood review: FAIL on this commit" });
  });
});
