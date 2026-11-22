import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REVIEW_STAMP_REASON_CHARS, REVIEW_STAMP_TIMEOUT_MS } from "../../shared/limits.ts";
import { findExecutable } from "../../shared/paths.ts";
import type { ReviewStampRequest } from "../../shared/review.ts";
import { removeTreeWithRetry } from "../platform/index.ts";
import { execGh, type GhRunOptions, type GhRunResult } from "./gh.ts";
import { describeStatusFailure, parseGithubPrUrl, postReviewStatus, redactGithubTokens, ReviewStatusRetryableError } from "./review-status.ts";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const TOKEN = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
const PR = { number: 12, state: "OPEN", url: "https://github.com/acme/widgets/pull/12" };
const PASS: ReviewStampRequest = { sha: SHA, verdict: "PASS", state: "success" };

const failed = (stderr: string, extra: Partial<Extract<GhRunResult, { kind: "failed" }>> = {}): Extract<GhRunResult, { kind: "failed" }> => ({
  kind: "failed",
  code: 1,
  stderr,
  timedOut: false,
  missing: false,
  ...extra,
});

interface Call {
  args: readonly string[];
  options: GhRunOptions;
}

function fakeDeps(respond: (args: readonly string[]) => GhRunResult) {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      now: () => 1_000,
      execGh: async (_cwd: string, args: readonly string[], options: GhRunOptions) => {
        calls.push({ args, options });
        return respond(args);
      },
    },
  };
}

const okFor = (args: readonly string[]): GhRunResult => (args[0] === "auth" ? { kind: "ok", stdout: `${TOKEN}\n` } : { kind: "ok", stdout: "" });

describe("parseGithubPrUrl", () => {
  it("解析 github.com 的 PR 链接为 host、owner、repo", () => {
    expect(parseGithubPrUrl("https://github.com/acme/widgets/pull/12")).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
    expect(parseGithubPrUrl("https://GitHub.com/acme/widgets/pull/12/files")).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
  });

  it("解析 GitHub Enterprise 主机的 PR 链接", () => {
    expect(parseGithubPrUrl("https://git.corp.example/team/svc/pull/3")).toEqual({ host: "git.corp.example", owner: "team", repo: "svc" });
  });

  it("GitLab 合并请求、Gitee 等别家链接和乱写的字符串返回 null", () => {
    for (const url of [
      "https://gitlab.com/acme/widgets/-/merge_requests/4",
      "https://gitee.com/acme/widgets/pulls/4",
      "https://bitbucket.org/acme/widgets/pull-requests/4",
      "https://github.com/acme/widgets/issues/4",
      "not a url",
      "",
    ]) {
      expect(parseGithubPrUrl(url)).toBeNull();
    }
  });
});

describe("redactGithubTokens", () => {
  it("把 ghp_、gho_、ghu_、ghs_、ghr_、github_pat_ 形状的令牌换成占位符，别的文字不动", () => {
    const tokens = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((p) => `${p}${"A1b2".repeat(9)}`);
    tokens.push(`github_pat_${"x9_Y".repeat(15)}`);
    for (const t of tokens) expect(redactGithubTokens(`bad token ${t} here`)).toBe("bad token [redacted] here");
    expect(redactGithubTokens("gh_short ghp_x HTTP 404")).toBe("gh_short ghp_x HTTP 404");
  });
});

describe("describeStatusFailure", () => {
  it("gh 没装、没登录、指定账号没登录各给一句跳过原因，原因里有账号名、没有令牌", () => {
    expect(describeStatusFailure(failed("", { missing: true, code: "ENOENT" }), { account: null })).toBe("本机没装 gh");
    expect(describeStatusFailure(failed("gh: Bad credentials (HTTP 401)"), { account: null })).toBe("gh 没登录 GitHub");
    expect(describeStatusFailure(failed("gh: Bad credentials (HTTP 401)"), { account: "octo" })).toContain("octo");
    expect(describeStatusFailure(failed("no oauth token found for github.com account octo"), { account: "octo" })).toBe("gh 里没有登录账号 octo");
  });

  it("不是 git 仓库、远端都不在 GitHub 上时给“不在 GitHub”的跳过原因", () => {
    expect(describeStatusFailure(failed("unable to expand placeholder in path: failed to run git: fatal: not a git repository"), { account: null })).toBe(
      "项目主文件夹不是 git 仓库",
    );
    expect(describeStatusFailure(failed("unable to expand placeholder in path: no git remotes found"), { account: null })).toBe("项目的 git 远端都不在 GitHub 上");
    expect(
      describeStatusFailure(
        failed("none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"),
        { account: null },
      ),
    ).toBe("项目的 git 远端都不在 GitHub 上");
  });

  it("403、404 给“账号没有写提交状态的权限”，422 给“提交没推到 GitHub”", () => {
    expect(describeStatusFailure(failed("gh: Not Found (HTTP 404)"), { account: "octo" })).toBe("账号 octo 没有在这个仓库写提交状态的权限");
    expect(describeStatusFailure(failed("gh: Resource not accessible (HTTP 403)"), { account: null })).toContain("没有在这个仓库写提交状态的权限");
    expect(describeStatusFailure(failed(`gh: No commit found for SHA: ${SHA} (HTTP 422)`), { account: null })).toBe("被审的提交还没推到 GitHub");
  });

  it("超时、网络错误、5xx 返回 retry", () => {
    expect(describeStatusFailure(failed("", { timedOut: true, code: null }), { account: null })).toBe("retry");
    expect(describeStatusFailure(failed("dial tcp: lookup api.github.com: no such host"), { account: null })).toBe("retry");
    expect(describeStatusFailure(failed("gh: Server Error (HTTP 502)"), { account: null })).toBe("retry");
  });
});

describe("postReviewStatus", () => {
  it("有 GitHub PR 时向 PR 所在仓库 POST statuses/<sha>，带 state、context、description，不带 target_url 以外的多余字段", async () => {
    const { calls, deps } = fakeDeps(okFor);
    await postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: null }, deps);
    expect(calls).toHaveLength(1);
    const { args, options } = calls[0]!;
    expect(args.slice(0, 6)).toEqual(["api", "--method", "POST", "--hostname", "github.com", `repos/acme/widgets/statuses/${SHA}`]);
    const fields = args.flatMap((a, i) => (args[i - 1] === "-f" ? [a.split("=")[0]] : []));
    expect(fields).toEqual(["state", "context", "description", "target_url"]);
    expect(args).toContain("state=success");
    expect(args).toContain("context=bellwood/review");
    expect(args).toContain(`target_url=${PR.url}`);
    expect(options.timeoutMs).toBe(REVIEW_STAMP_TIMEOUT_MS);
  });

  it("PR 链接不在 GitHub 上时安静跳过，不调用 gh", async () => {
    const { calls, deps } = fakeDeps(okFor);
    const outcome = await postReviewStatus(
      { cwd: "/repo", request: PASS, pr: { number: 4, state: "OPEN", url: "https://gitlab.com/a/b/-/merge_requests/4" }, account: "octo" },
      deps,
    );
    expect(outcome).toMatchObject({ kind: "skipped", sha: SHA });
    expect(calls).toHaveLength(0);
  });

  it("没有 PR 时用 gh 的 {owner}/{repo} 占位符，在项目主文件夹里解析远端", async () => {
    const { calls, deps } = fakeDeps(okFor);
    await postReviewStatus({ cwd: "/repo", request: { sha: SHA, verdict: "FAIL", state: "failure" }, pr: null, account: null }, deps);
    expect(calls[0]!.args.slice(0, 4)).toEqual(["api", "--method", "POST", `repos/{owner}/{repo}/statuses/${SHA}`]);
    expect(calls[0]!.args).toContain("state=failure");
    expect(calls[0]!.args.some((a) => a.startsWith("target_url="))).toBe(false);
  });

  it("配了账号时先跑 gh auth token --user <账号>（有 PR 时加 --hostname），令牌只经 GH_TOKEN 传给 gh api，从不出现在参数里", async () => {
    const { calls, deps } = fakeDeps(okFor);
    const outcome = await postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: "octo" }, deps);
    expect(calls[0]!.args).toEqual(["auth", "token", "--user", "octo", "--hostname", "github.com"]);
    expect(calls[0]!.options.env).toBeUndefined();
    expect(calls[1]!.options.env).toEqual({ GH_TOKEN: TOKEN });
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);

    const ghe = fakeDeps(okFor);
    await postReviewStatus({ cwd: "/repo", request: PASS, pr: { ...PR, url: "https://git.corp.example/t/s/pull/1" }, account: "octo" }, ghe.deps);
    expect(ghe.calls[0]!.args).toEqual(["auth", "token", "--user", "octo", "--hostname", "git.corp.example"]);
    expect(ghe.calls[1]!.options.env).toEqual({ GH_ENTERPRISE_TOKEN: TOKEN });
  });

  it("没配账号时不跑 gh auth token，也不设 GH_TOKEN，用 gh 当前账号", async () => {
    const { calls, deps } = fakeDeps(okFor);
    await postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: null }, deps);
    expect(calls.map((c) => c.args[0])).toEqual(["api"]);
    expect(calls[0]!.options.env).toEqual({});
  });

  it("gh auth token 失败时跳过并写明哪个账号没登录", async () => {
    const { calls, deps } = fakeDeps((args) => (args[0] === "auth" ? failed("no oauth token found for github.com account octo") : { kind: "ok", stdout: "" }));
    const outcome = await postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: "octo" }, deps);
    expect(outcome).toEqual({ kind: "skipped", sha: SHA, reason: "gh 里没有登录账号 octo", at: 1_000 });
    expect(calls).toHaveLength(1);
  });

  it("可重试的失败抛 ReviewStatusRetryableError，消息里没有令牌", async () => {
    const { deps } = fakeDeps((args) => (args[0] === "auth" ? okFor(args) : failed(`gh: Server Error (HTTP 502) token=${TOKEN}`)));
    const error = await postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: "octo" }, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReviewStatusRetryableError);
    expect((error as Error).message).toContain("HTTP 502");
    expect((error as Error).message).not.toContain(TOKEN);

    const timeout = fakeDeps(() => failed("", { timedOut: true, code: null }));
    await expect(postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: null }, timeout.deps)).rejects.toThrow(ReviewStatusRetryableError);
  });

  it("跳过原因截到 MAX_REVIEW_STAMP_REASON_CHARS，并去掉令牌形状的文字", async () => {
    const longUrl = `https://gitlab.com/${"a".repeat(400)}/${TOKEN}/-/merge_requests/1`;
    const { deps } = fakeDeps(okFor);
    const outcome = await postReviewStatus({ cwd: "/repo", request: PASS, pr: { number: 1, state: "OPEN", url: longUrl }, account: null }, deps);
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") return;
    expect(outcome.reason.length).toBeLessThanOrEqual(MAX_REVIEW_STAMP_REASON_CHARS);
    const short = await postReviewStatus({ cwd: "/repo", request: PASS, pr: { number: 1, state: "OPEN", url: `https://gitlab.com/${TOKEN}/-/merge_requests/1` }, account: null }, deps);
    expect(JSON.stringify(short)).not.toContain(TOKEN);
    expect(JSON.stringify(short)).toContain("[redacted]");
  });

  it("成功时返回 posted，带 sha、state 和账号名", async () => {
    const { deps } = fakeDeps(okFor);
    await expect(postReviewStatus({ cwd: "/repo", request: PASS, pr: PR, account: "octo" }, deps)).resolves.toEqual({
      kind: "posted",
      sha: SHA,
      state: "success",
      account: "octo",
      at: 1_000,
    });
  });
});

const realGh = findExecutable("gh", process.env.PATH ?? process.env.Path, [], { platform: process.platform, pathExt: process.env.PATHEXT });

describe.skipIf(realGh === null)("postReviewStatus：真 gh 与真仓库（不联网）", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-review-status-")));
    // A placeholder token gets gh past its login check; every case here fails while resolving the repository, before any request.
    vi.stubEnv("GH_TOKEN", "placeholder-not-a-token");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", undefined);
    vi.stubEnv("GH_HOST", undefined);
    vi.stubEnv("GH_REPO", undefined);
    vi.stubEnv("GH_CONFIG_DIR", join(root, "gh-config"));
    vi.stubEnv("GIT_CEILING_DIRECTORIES", dirname(root));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTreeWithRetry(root);
  });

  const post = (cwd: string) => postReviewStatus({ cwd, request: PASS, pr: null, account: null }, { execGh, now: () => 1 });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  it("没有 git 的文件夹里安静跳过，原因写进结果", async () => {
    const folder = join(root, "plain");
    mkdirSync(folder);
    await expect(post(folder)).resolves.toEqual({ kind: "skipped", sha: SHA, reason: "项目主文件夹不是 git 仓库", at: 1 });
  });

  it("只有本地仓库、没有远端时安静跳过", async () => {
    const folder = join(root, "local");
    mkdirSync(folder);
    git(folder, "init", "-q");
    await expect(post(folder)).resolves.toEqual({ kind: "skipped", sha: SHA, reason: "项目的 git 远端都不在 GitHub 上", at: 1 });
  });

  it("远端指向非 GitHub 主机时安静跳过", async () => {
    const folder = join(root, "gitlab");
    mkdirSync(folder);
    git(folder, "init", "-q");
    git(folder, "remote", "add", "origin", "https://gitlab.example/acme/widgets.git");
    await expect(post(folder)).resolves.toEqual({ kind: "skipped", sha: SHA, reason: "项目的 git 远端都不在 GitHub 上", at: 1 });
  });
});
