import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeGh, readFakeGhCalls } from "../../../test/fake-gh.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { execGh } from "./gh.ts";
import { probePr, probePrByUrl } from "./pr.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-gh-test-")));
  vi.stubEnv("GH_TOKEN", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTreeWithRetry(root);
});

describe("execGh", () => {
  it("成功时返回 stdout；子进程环境带 GH_PROMPT_DISABLED、GH_NO_UPDATE_NOTIFIER 和调用方给的 env", async () => {
    vi.stubEnv("PATH", installFakeGh(root, `process.stdout.write("hello " + args.join("|"));`));
    const result = await execGh(root, ["api", "repos/o/r"], { timeoutMs: 10_000, env: { GH_TOKEN: "t-123" } });
    expect(result).toEqual({ kind: "ok", stdout: "hello api|repos/o/r" });
    const [call] = readFakeGhCalls(root);
    expect(call!.env).toEqual({ GH_TOKEN: "t-123", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" });
    expect(realpathSync.native(call!.cwd)).toBe(root);
  });

  it("gh 不在 PATH 上时返回 missing: true，不抛异常", async () => {
    vi.stubEnv("PATH", join(root, "empty-bin"));
    const result = await execGh(root, ["--version"], { timeoutMs: 10_000 });
    expect(result).toMatchObject({ kind: "failed", missing: true, timedOut: false });
  });

  it("超时返回 timedOut: true", async () => {
    vi.stubEnv("PATH", installFakeGh(root, `setTimeout(() => {}, 30_000);`));
    const result = await execGh(root, ["api", "x"], { timeoutMs: 300 });
    expect(result).toMatchObject({ kind: "failed", timedOut: true, missing: false });
  });

  it("非零退出返回 failed，带退出码和 stderr", async () => {
    vi.stubEnv("PATH", installFakeGh(root, `process.stderr.write("HTTP 404: Not Found"); process.exit(3);`));
    const result = await execGh(root, ["api", "x"], { timeoutMs: 10_000 });
    expect(result).toEqual({ kind: "failed", code: 3, stderr: "HTTP 404: Not Found", timedOut: false, missing: false });
  });

  it.runIf(process.platform === "win32")("Windows 上按 PATHEXT 找到 gh.cmd 也能跑", async () => {
    vi.stubEnv("PATH", installFakeGh(root, `process.stdout.write(args.join("|"));`));
    const result = await execGh(root, ["api", "a b", "-f", "description=x & y"], { timeoutMs: 10_000 });
    expect(result).toEqual({ kind: "ok", stdout: "api|a b|-f|description=x & y" });
  });

  it("probePr 和 probePrByUrl 改走 execGh 后行为不变", async () => {
    vi.stubEnv(
      "PATH",
      installFakeGh(root, `const url = args[0] === "pr" && args[1] === "view" ? args[2] : "https://github.com/o/r/pull/5";
const pr = { number: 5, state: "OPEN", url };
process.stdout.write(JSON.stringify(args[1] === "list" ? [pr] : pr));`),
    );
    await expect(probePr(root, "hub/1-x")).resolves.toEqual({ number: 5, state: "OPEN", url: "https://github.com/o/r/pull/5" });
    await expect(probePrByUrl(root, "https://github.com/o/r/pull/5")).resolves.toEqual({ number: 5, state: "OPEN", url: "https://github.com/o/r/pull/5" });
    const calls = readFakeGhCalls(root);
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["pr", "list"],
      ["pr", "view"],
    ]);
    expect(calls.every((c) => c.env.GH_PROMPT_DISABLED === "1" && c.env.GH_TOKEN === undefined)).toBe(true);
  });
});
