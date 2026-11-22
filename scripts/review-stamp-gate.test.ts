import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_STATUS_CREATOR,
  PR_FILES_API_MAX,
  REVIEW_STATUS_CONTEXT,
  decideGateStatus,
  main,
  matchStampPaths,
  parseStampPaths,
  type GateDeps,
} from "./review-stamp-gate.ts";
import { REVIEW_STATUS_CONTEXT as DAEMON_REVIEW_STATUS_CONTEXT } from "../src/shared/review.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";

const SHA = "b".repeat(40);
const REVIEW_MD = `# Rules

## Paths that require a review stamp

Intro text with \`not-a-glob-line\` in prose.

- Ledger: \`migrations/**\`, \`src/daemon/store/**\`
- Vendors: \`src/vendors/*/driver.ts\`

## Rules

- \`docs/**\`
`;

it("门禁读的状态名跟守护进程挂的一致", () => {
  expect(REVIEW_STATUS_CONTEXT).toBe(DAEMON_REVIEW_STATUS_CONTEXT);
});

describe("parseStampPaths", () => {
  it("读出 REVIEW.md 里“Paths that require a review stamp”一节所有反引号里的 glob，到下一个 ## 为止", () => {
    expect(parseStampPaths(REVIEW_MD)).toEqual(["migrations/**", "src/daemon/store/**", "src/vendors/*/driver.ts"]);
  });

  it("没有这一节或一条 glob 都没有时抛错，门禁失败而不是放行", () => {
    expect(() => parseStampPaths("# Rules\n\n## Rules\n- `a`\n")).toThrow(/no "## Paths that require a review stamp" section/);
    expect(() => parseStampPaths("## Paths that require a review stamp\n\nNothing yet.\n\n## Rules\n- `a`\n")).toThrow(/lists no path/);
  });

  it("主干上真实的 REVIEW.md 能解析出非空列表", () => {
    const globs = parseStampPaths(readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf8"));
    expect(globs).toContain("migrations/**");
    expect(globs).toContain(".github/**");
    expect(globs.length).toBeGreaterThan(10);
  });
});

describe("matchStampPaths", () => {
  it("* 只匹配一段路径，** 跨目录，跟 REVIEW.md 的 Trigger 同一套语义", () => {
    const globs = ["src/vendors/*/driver.ts", "migrations/**", ".github/**", "scripts/stage-*.ts"];
    expect(matchStampPaths(["src/vendors/claude/driver.ts"], globs)).toEqual(["src/vendors/claude/driver.ts"]);
    expect(matchStampPaths(["src/vendors/claude/sub/driver.ts"], globs)).toEqual([]);
    expect(matchStampPaths(["migrations/0048_x.sql", ".github/workflows/check.yml"], globs)).toHaveLength(2);
    expect(matchStampPaths(["scripts/stage-mac-runtime.ts", "scripts/x/stage-a.ts", "docs/a.md"], globs)).toEqual(["scripts/stage-mac-runtime.ts"]);
  });

  it("返回命中的文件，顺序跟输入一致", () => {
    expect(matchStampPaths(["migrations/b.sql", "docs/a.md", "migrations/a.sql"], ["migrations/**"])).toEqual(["migrations/b.sql", "migrations/a.sql"]);
  });
});

describe("decideGateStatus", () => {
  const verdict = (state: "success" | "failure") => ({ state, description: "Independent Bellwood review", creator: "maodesikeng-boop" });

  it("没改高风险路径、文件列表完整：发 success，描述写明不需要审查盖章", () => {
    expect(decideGateStatus({ matched: [], filesTruncated: false, current: null })).toEqual({
      kind: "post",
      state: "success",
      description: "No high-risk paths changed; review stamp not required",
    });
  });

  it("改了高风险路径、还没有审查结论：发 pending，描述点名第一个命中的文件", () => {
    expect(decideGateStatus({ matched: ["migrations/a.sql", "migrations/b.sql"], filesTruncated: false, current: null })).toEqual({
      kind: "post",
      state: "pending",
      description: "Needs an independent review PASS on this commit: migrations/a.sql",
    });
  });

  it("改了高风险路径、已有守护进程挂的 success：保持不动（有状态的放行）", () => {
    expect(decideGateStatus({ matched: ["migrations/a.sql"], filesTruncated: false, current: verdict("success") })).toMatchObject({ kind: "keep" });
  });

  it("已有审查挂的 failure：保持不动，不管改没改高风险路径", () => {
    expect(decideGateStatus({ matched: ["migrations/a.sql"], filesTruncated: false, current: verdict("failure") })).toMatchObject({ kind: "keep" });
    expect(decideGateStatus({ matched: [], filesTruncated: false, current: verdict("failure") })).toMatchObject({ kind: "keep" });
  });

  it("当前状态是门禁自己发的：按路径重新判", () => {
    const own = { state: "pending" as const, description: "Needs …", creator: GATE_STATUS_CREATOR };
    expect(decideGateStatus({ matched: [], filesTruncated: false, current: own })).toMatchObject({ kind: "post", state: "success" });
    expect(decideGateStatus({ matched: ["migrations/a.sql"], filesTruncated: false, current: { ...own, state: "success" } })).toMatchObject({
      kind: "post",
      state: "pending",
    });
  });

  it("文件列表到了 PR_FILES_API_MAX 上限：按改了高风险路径处理", () => {
    expect(decideGateStatus({ matched: [], filesTruncated: true, current: null })).toEqual({
      kind: "post",
      state: "pending",
      description: `Needs an independent review PASS on this commit: more than ${PR_FILES_API_MAX} files changed`,
    });
  });

  it("描述不超过 140 字符", () => {
    const long = `src/daemon/store/${"x".repeat(300)}.ts`;
    const decision = decideGateStatus({ matched: [long], filesTruncated: false, current: null });
    expect(decision.kind === "post" && decision.description.length).toBeLessThanOrEqual(140);
  });
});

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

function fakeGitHub(pages: Array<Array<{ filename: string; previous_filename?: string }>>, statuses: unknown[] = [], headSha = SHA) {
  const requests: RecordedRequest[] = [];
  const logs: string[] = [];
  const deps: GateDeps = {
    readReviewMd: () => REVIEW_MD,
    log: (line) => logs.push(line),
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), auth: headers.get("authorization") });
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const json = url.includes("/files") ? (pages[page - 1] ?? []) : url.includes("/statuses?") ? statuses : url.endsWith(`/pulls/7`) ? { head: { sha: headSha } } : {};
      return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  };
  return { deps, requests, logs };
}

const ENV = { GITHUB_REPOSITORY: "acme/widgets", PR_NUMBER: "7", HEAD_SHA: SHA, GH_TOKEN: "t0k", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "99" };

describe("main", () => {
  it("--dry-run 只打印决定，不发请求", async () => {
    const gh = fakeGitHub([[{ filename: "migrations/0049.sql" }]]);
    expect(await main(["--dry-run"], ENV, gh.deps)).toBe(0);
    expect(gh.requests.every((r) => r.method === "GET")).toBe(true);
    expect(JSON.parse(gh.logs[0]!)).toMatchObject({ dryRun: true, decision: { kind: "post", state: "pending" }, matched: ["migrations/0049.sql"] });
  });

  it("缺 GITHUB_REPOSITORY、PR_NUMBER、HEAD_SHA 或 GH_TOKEN 时返回 1", async () => {
    for (const key of ["GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA", "GH_TOKEN"] as const) {
      const gh = fakeGitHub([]);
      expect(await main([], { ...ENV, [key]: undefined }, gh.deps)).toBe(1);
      expect(gh.logs[0]).toContain(key);
      expect(gh.requests).toEqual([]);
    }
    expect(await main([], { ...ENV, HEAD_SHA: "abc" }, fakeGitHub([]).deps)).toBe(1);
  });

  it("分页读完 PR 的改动文件，读 HEAD_SHA 上最新的 bellwood/review 状态后按决定发或不发", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }));
    const gh = fakeGitHub([full, [{ filename: "src/web/a.ts", previous_filename: "src/daemon/store/a.ts" }]]);
    expect(await main([], ENV, gh.deps)).toBe(0);
    expect(gh.requests.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      "GET /repos/acme/widgets/pulls/7/files?per_page=100&page=1",
      "GET /repos/acme/widgets/pulls/7/files?per_page=100&page=2",
      "GET /repos/acme/widgets/pulls/7",
      `GET /repos/acme/widgets/commits/${SHA}/statuses?per_page=100`,
      `POST /repos/acme/widgets/statuses/${SHA}`,
    ]);
    expect(gh.requests.at(-1)!.body).toEqual({
      state: "pending",
      context: REVIEW_STATUS_CONTEXT,
      description: "Needs an independent review PASS on this commit: src/daemon/store/a.ts",
      target_url: "https://github.com/acme/widgets/actions/runs/99",
    });
    expect(gh.requests.every((r) => r.auth === "Bearer t0k")).toBe(true);

    const stamped = fakeGitHub(
      [[{ filename: "migrations/0049.sql" }]],
      [
        { context: "check", state: "success", description: null, creator: { login: GATE_STATUS_CREATOR } },
        { context: REVIEW_STATUS_CONTEXT, state: "success", description: "Independent Bellwood review: PASS on this commit", creator: { login: "maodesikeng-boop" } },
        { context: REVIEW_STATUS_CONTEXT, state: "pending", description: "Needs …", creator: { login: GATE_STATUS_CREATOR } },
      ],
    );
    expect(await main([], ENV, stamped.deps)).toBe(0);
    expect(stamped.requests.some((r) => r.method === "POST")).toBe(false);

    const docsOnly = fakeGitHub([[{ filename: "docs/a.md" }]]);
    expect(await main([], ENV, docsOnly.deps)).toBe(0);
    expect(docsOnly.requests.at(-1)!.body).toMatchObject({ state: "success" });
  });

  it("读完文件列表后 PR 头已经换了提交：不发状态，交给新推送那次运行", async () => {
    const gh = fakeGitHub([[{ filename: "docs/a.md" }]], [], "c".repeat(40));
    expect(await main([], ENV, gh.deps)).toBe(0);
    expect(gh.requests.some((r) => r.method === "POST")).toBe(false);
    expect(gh.logs[0]).toContain(`PR head moved to ${"c".repeat(40)}`);
  });

  it("按真实 REVIEW.md，只改门禁脚本本身的 PR 也要审查盖章", async () => {
    const gh = fakeGitHub([[{ filename: "scripts/review-stamp-gate.ts" }]]);
    gh.deps.readReviewMd = () => readFileSync(join(REPO_ROOT, "REVIEW.md"), "utf8");
    expect(await main([], ENV, gh.deps)).toBe(0);
    expect(gh.requests.at(-1)!.body).toMatchObject({ state: "pending", description: "Needs an independent review PASS on this commit: scripts/review-stamp-gate.ts" });
  });

  it("GitHub API 报错时返回 1，不发状态", async () => {
    const gh = fakeGitHub([]);
    gh.deps.fetch = (async () => new Response("{}", { status: 502 })) as typeof fetch;
    expect(await main([], ENV, gh.deps)).toBe(1);
    expect(gh.logs[0]).toContain("502");
  });
});
