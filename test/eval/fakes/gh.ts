// gh 替身（docs/orchestration-eval-design.md 3.3）：放在评测 PATH 的最前面，按场景回放真实的 PR、检查结果、失败日志，
// 每次调用记一行（calls.jsonl），绝不联网。真 gh 那边另有三道挡：GH_CONFIG_DIR 指到空目录、GH_TOKEN 清空、
// 真模型项目经理的沙箱禁止执行真 gh（isolation.ts）。
//
// 这个文件会被拷进每次试跑的 bin/lib/gh.mts 单独运行：只能用 node 自带模块，类型用 import type（运行时擦掉）。
// 环境变量：EVAL_GH_DIR（replay.json 只读、state.json 可变、calls.jsonl 记录）；EVAL_JQ（真 jq 的路径，-q/--jq 用它过滤，没有就原样输出 JSON）。
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GhAttempt, GhCall, GhPr, GhReplay } from "../types.ts";

interface GhState {
  /** PR 编号 → 现在是第几次运行（gh run rerun 加一）。 */
  attempt: Record<string, number>;
  state: Record<string, GhPr["state"]>;
  created: GhPr[];
  nextPr: number;
  seq: number;
}

interface ReplayFile extends GhReplay {
  /** 回放文件（日志、补丁）所在目录的绝对路径。 */
  baseDir: string;
  /** 一次最多输出多少字节日志。 */
  logMaxBytes: number;
}

const dir = process.env.EVAL_GH_DIR ?? "";
const FAKE_TOKEN = "gho_EvalReplayToken0000000000000000000000";
const RUN_STARTED = "2026-11-11T14:36:17Z";
const RUN_COMPLETED = "2026-11-11T14:41:59Z";

function loadReplay(): ReplayFile {
  return JSON.parse(readFileSync(join(dir, "replay.json"), "utf8")) as ReplayFile;
}

function loadState(replay: ReplayFile): GhState {
  const file = join(dir, "state.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as GhState;
  return { attempt: {}, state: {}, created: [], nextPr: replay.nextPr, seq: 0 };
}

const out: string[] = [];
const err: string[] = [];
const print = (s: string) => out.push(s.endsWith("\n") ? s : `${s}\n`);
const printErr = (s: string) => err.push(s.endsWith("\n") ? s : `${s}\n`);

/** 去掉全局参数（-R/--repo、--hostname），返回剩下的。 */
function stripGlobal(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-R" || a === "--repo" || a === "--hostname") {
      i++;
      continue;
    }
    if (a.startsWith("--repo=") || a.startsWith("--hostname=")) continue;
    rest.push(a);
  }
  return rest;
}

function flag(args: string[], ...names: string[]): boolean {
  return args.some((a) => names.includes(a) || names.some((n) => a.startsWith(`${n}=`)));
}

function value(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/** 位置参数（不以 - 开头、也不是某个带值参数的值）。 */
function positionals(args: string[], valued: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    result.push(a);
  }
  return result;
}

const VALUED = ["--json", "-q", "--jq", "-t", "--template", "--job", "--attempt", "-b", "--body", "--title", "-t", "--base", "-B", "--head", "-H", "-L", "--limit", "--branch", "-s", "--state", "--interval", "-i", "--match-head-commit", "--body-file", "-F", "--subject", "--workflow", "-w", "-u", "--user"];

function allPrs(replay: ReplayFile, state: GhState): GhPr[] {
  return [...replay.prs, ...state.created].map((pr) => ({ ...pr, state: state.state[pr.number] ?? pr.state }));
}

/** 按编号、网址、分支名找 PR；没给或认不出就是最近一个开着的（场景里通常只有一个）。 */
function selectPr(prs: GhPr[], selector: string | undefined): GhPr | undefined {
  if (selector !== undefined) {
    const n = /^#?(\d+)$/.exec(selector)?.[1] ?? /\/pull\/(\d+)/.exec(selector)?.[1];
    if (n !== undefined) return prs.find((p) => p.number === Number(n));
    const byBranch = prs.find((p) => p.headRefName === selector);
    if (byBranch) return byBranch;
  }
  return [...prs].reverse().find((p) => p.state === "OPEN") ?? prs.at(-1);
}

function currentAttempt(pr: GhPr, state: GhState): { index: number; attempt: GhAttempt } | undefined {
  if (!pr.checks) return undefined;
  const index = Math.min(state.attempt[pr.number] ?? 0, pr.checks.attempts.length - 1);
  return { index, attempt: pr.checks.attempts[index]! };
}

function bucket(status: GhAttempt["status"]): "pass" | "fail" | "pending" {
  return status;
}

function jobLink(replay: ReplayFile, pr: GhPr, jobId: number): string {
  return `https://github.com/${replay.repo}/actions/runs/${pr.checks!.runId}/job/${jobId}`;
}

function readLog(replay: ReplayFile, file: string | undefined): string {
  if (!file) return "";
  const path = join(replay.baseDir, file);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(replay.logMaxBytes);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 按 --json 给的字段挑；-q/--jq 交给真 jq（有的话）。 */
function emitJson(obj: unknown, args: string[]): number {
  const fields = value(args, "--json");
  let data = obj;
  if (fields) {
    const pick = (o: Record<string, unknown>) => Object.fromEntries(fields.split(",").map((f) => [f.trim(), o[f.trim()] ?? null]));
    data = Array.isArray(obj) ? obj.map((o) => pick(o as Record<string, unknown>)) : pick(obj as Record<string, unknown>);
  }
  const text = JSON.stringify(data);
  const expr = value(args, "-q", "--jq");
  const jq = process.env.EVAL_JQ;
  if (expr !== undefined && jq) {
    const r = spawnSync(jq, ["-r", expr], { input: text, encoding: "utf8" });
    if (r.stdout) out.push(r.stdout);
    if (r.stderr) err.push(r.stderr);
    return r.status ?? 1;
  }
  print(text);
  return 0;
}

function checkRows(replay: ReplayFile, pr: GhPr, state: GhState) {
  const cur = currentAttempt(pr, state);
  if (!cur) return [];
  const b = bucket(cur.attempt.status);
  return pr.checks!.jobs.map((job) => ({
    name: job.name,
    bucket: b,
    state: b === "pass" ? "SUCCESS" : b === "fail" ? "FAILURE" : "IN_PROGRESS",
    link: jobLink(replay, pr, job.databaseId),
    elapsed: b === "pending" ? "" : job.elapsed,
    startedAt: RUN_STARTED,
    completedAt: b === "pending" ? null : RUN_COMPLETED,
    workflow: pr.checks!.workflow,
    event: "pull_request",
    description: "",
  }));
}

function prJson(replay: ReplayFile, pr: GhPr, state: GhState): Record<string, unknown> {
  const cur = currentAttempt(pr, state);
  const additions = pr.files.reduce((n, f) => n + f.additions, 0);
  const deletions = pr.files.reduce((n, f) => n + f.deletions, 0);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    url: `https://github.com/${replay.repo}/pull/${pr.number}`,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: "main",
    isDraft: false,
    mergeable: pr.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: cur?.attempt.status === "fail" ? "UNSTABLE" : cur?.attempt.status === "pending" ? "BLOCKED" : "CLEAN",
    files: pr.files,
    additions,
    deletions,
    changedFiles: pr.files.length,
    author: { login: replay.repo.split("/")[0] },
    reviewDecision: "",
    mergedAt: pr.state === "MERGED" ? RUN_COMPLETED : null,
    statusCheckRollup: checkRows(replay, pr, state).map((r) => ({
      __typename: "CheckRun",
      name: r.name,
      status: r.bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: r.bucket === "pass" ? "SUCCESS" : r.bucket === "fail" ? "FAILURE" : "",
      workflowName: r.workflow,
      detailsUrl: r.link,
    })),
  };
}

function runJson(replay: ReplayFile, pr: GhPr, state: GhState): Record<string, unknown> {
  const cur = currentAttempt(pr, state)!;
  const b = cur.attempt.status;
  const conclusion = b === "pass" ? "success" : b === "fail" ? "failure" : "";
  return {
    databaseId: pr.checks!.runId,
    attempt: cur.index + 1,
    status: b === "pending" ? "in_progress" : "completed",
    conclusion,
    headBranch: pr.headRefName,
    headSha: pr.headRefOid,
    name: pr.checks!.workflow,
    workflowName: pr.checks!.workflow,
    displayTitle: pr.title,
    event: "pull_request",
    createdAt: RUN_STARTED,
    updatedAt: RUN_COMPLETED,
    url: `https://github.com/${replay.repo}/actions/runs/${pr.checks!.runId}`,
    jobs: pr.checks!.jobs.map((job) => ({
      name: job.name,
      databaseId: job.databaseId,
      status: b === "pending" ? "in_progress" : "completed",
      conclusion,
      startedAt: RUN_STARTED,
      completedAt: RUN_COMPLETED,
      url: jobLink(replay, pr, job.databaseId),
    })),
  };
}

/** 跑一条命令，返回认出来的动作和退出码。 */
function run(argv: string[], replay: ReplayFile, state: GhState): { action: string; code: number } {
  const args = stripGlobal(argv);
  const [group, sub] = args;
  const rest = args.slice(2);
  const prs = allPrs(replay, state);
  if (group === "--version" || group === "version") {
    print("gh version 2.83.0 (2026-10-01)");
    return { action: "version", code: 0 };
  }
  if (group === "auth") {
    if (sub === "token") {
      print(FAKE_TOKEN);
      return { action: "auth token", code: 0 };
    }
    print(`github.com\n  ✓ Logged in to github.com account ${replay.repo.split("/")[0]} (keyring)\n  - Active account: true`);
    return { action: `auth ${sub ?? ""}`.trim(), code: 0 };
  }
  if (group === "repo" && sub === "view") {
    const obj = { nameWithOwner: replay.repo, name: replay.repo.split("/")[1], url: `https://github.com/${replay.repo}`, defaultBranchRef: { name: "main" } };
    return { action: "repo view", code: flag(rest, "--json") ? emitJson(obj, rest) : (print(`${replay.repo}\n`), 0) };
  }
  if (group === "pr") {
    const pr = selectPr(prs, positionals(rest, VALUED)[0]);
    switch (sub) {
      case "checks": {
        if (!pr) return (printErr("no pull requests found"), { action: "pr checks", code: 1 });
        const rows = checkRows(replay, pr, state);
        if (rows.length === 0) return (printErr(`no checks reported on the '${pr.headRefName}' branch`), { action: "pr checks", code: 1 });
        const status = currentAttempt(pr, state)!.attempt.status;
        if (flag(rest, "--json")) emitJson(rows, rest);
        else for (const r of rows) print(`${r.name}\t${r.bucket}\t${r.elapsed}\t${r.link}\t${r.description}`);
        if (flag(rest, "--watch") && status !== "pending") printErr("");
        return { action: flag(rest, "--watch") ? "pr checks --watch" : "pr checks", code: status === "pass" ? 0 : status === "fail" ? 1 : 8 };
      }
      case "view": {
        if (!pr) return (printErr("no pull requests found for branch"), { action: "pr view", code: 1 });
        const obj = prJson(replay, pr, state);
        if (flag(rest, "--json")) return { action: `pr view --json ${value(rest, "--json")}`, code: emitJson(obj, rest) };
        print(`${pr.title} #${pr.number}\n${pr.state === "OPEN" ? "Open" : pr.state === "MERGED" ? "Merged" : "Closed"} • ${obj.author && (obj.author as { login: string }).login} wants to merge 1 commit into main from ${pr.headRefName} • +${obj.additions as number} -${obj.deletions as number}\n\n${pr.body}\n\nView this pull request on GitHub: ${obj.url as string}`);
        return { action: "pr view", code: 0 };
      }
      case "diff": {
        if (!pr) return (printErr("no pull requests found"), { action: "pr diff", code: 1 });
        if (flag(rest, "--name-only")) {
          for (const f of pr.files) print(f.path);
          return { action: "pr diff --name-only", code: 0 };
        }
        out.push(pr.diffFile ? readFileSync(join(replay.baseDir, pr.diffFile), "utf8") : "");
        return { action: "pr diff", code: 0 };
      }
      case "list": {
        const listed = prs.filter((p) => (value(rest, "-s", "--state") ?? "open") === "all" || p.state === "OPEN");
        if (flag(rest, "--json")) return { action: "pr list", code: emitJson(listed.map((p) => prJson(replay, p, state)), rest) };
        for (const p of listed) print(`${p.number}\t${p.title}\t${p.headRefName}\t${p.state}`);
        return { action: "pr list", code: 0 };
      }
      case "merge": {
        if (!pr) return (printErr("no pull requests found"), { action: "pr merge", code: 1 });
        if (pr.state !== "OPEN") return (printErr(`Pull request #${pr.number} is not open`), { action: "pr merge", code: 1 });
        state.state[pr.number] = "MERGED";
        print(`✓ Merged pull request #${pr.number} (${pr.title})`);
        return { action: "pr merge", code: 0 };
      }
      case "create": {
        const number = state.nextPr++;
        const created: GhPr = {
          number,
          title: value(rest, "--title", "-t") ?? "(eval) new pull request",
          body: value(rest, "--body", "-b") ?? "",
          headRefName: value(rest, "--head", "-H") ?? `eval-branch-${number}`,
          headRefOid: "0".repeat(40),
          state: "OPEN",
          files: [],
        };
        state.created.push(created);
        print(`https://github.com/${replay.repo}/pull/${number}`);
        return { action: "pr create", code: 0 };
      }
      default:
        return { action: `pr ${sub ?? ""}`.trim(), code: 0 };
    }
  }
  if (group === "run") {
    const withChecks = prs.filter((p) => p.checks);
    const id = positionals(rest, VALUED)[0];
    const pr = withChecks.find((p) => String(p.checks!.runId) === id) ?? [...withChecks].reverse().find((p) => p.state === "OPEN") ?? withChecks.at(-1);
    switch (sub) {
      case "list": {
        const runs = withChecks.map((p) => runJson(replay, p, state));
        if (flag(rest, "--json")) return { action: "run list", code: emitJson(runs, rest) };
        for (const r of runs) print(`${r.status}\t${r.conclusion}\t${r.displayTitle}\t${r.workflowName}\t${r.headBranch}\t${r.event}\t${r.databaseId}\t5m42s\t${RUN_STARTED}`);
        return { action: "run list", code: 0 };
      }
      case "view": {
        if (!pr) return (printErr("run not found"), { action: "run view", code: 1 });
        const cur = currentAttempt(pr, state)!;
        if (flag(rest, "--log-failed", "--log")) {
          let log = cur.attempt.status === "fail" || flag(rest, "--log") ? readLog(replay, cur.attempt.logFile) : "";
          const job = value(rest, "--job");
          const jobName = pr.checks!.jobs.find((j) => String(j.databaseId) === job)?.name;
          if (jobName) log = log.split("\n").filter((l) => l.startsWith(`${jobName}\t`)).join("\n");
          out.push(log);
          return { action: flag(rest, "--log-failed") ? "run view --log-failed" : "run view --log", code: 0 };
        }
        const obj = runJson(replay, pr, state);
        if (flag(rest, "--json")) return { action: "run view --json", code: emitJson(obj, rest) };
        const mark = cur.attempt.status === "fail" ? "X" : cur.attempt.status === "pass" ? "✓" : "*";
        print(`${mark} ${pr.headRefName} ${pr.checks!.workflow} · ${pr.checks!.runId}\nTriggered via pull_request about 6 minutes ago\n\nJOBS`);
        for (const job of pr.checks!.jobs) print(`${mark} ${job.name} in ${job.elapsed} (ID ${job.databaseId})`);
        if (cur.attempt.status === "fail") {
          print("\nANNOTATIONS");
          for (const job of pr.checks!.jobs) print(`X Process completed with exit code 100.\n${job.name}: .github#1\n`);
          print(`To see what failed, try: gh run view ${pr.checks!.runId} --log-failed`);
        }
        print(`View this run on GitHub: ${obj.url as string}`);
        return { action: "run view", code: flag(rest, "--exit-status") && cur.attempt.status === "fail" ? 1 : 0 };
      }
      case "rerun": {
        if (!pr) return (printErr("run not found"), { action: "run rerun", code: 1 });
        state.attempt[pr.number] = (state.attempt[pr.number] ?? 0) + 1;
        print(`✓ Requested rerun${flag(rest, "--failed") ? " (failed jobs)" : ""} of run ${pr.checks!.runId}`);
        return { action: "run rerun", code: 0 };
      }
      case "watch": {
        if (!pr) return (printErr("run not found"), { action: "run watch", code: 1 });
        const status = currentAttempt(pr, state)!.attempt.status;
        print(`${status === "fail" ? "X" : "✓"} Run ${pr.checks!.workflow} (${pr.checks!.runId}) completed with '${status === "fail" ? "failure" : "success"}'`);
        return { action: "run watch", code: flag(rest, "--exit-status") && status === "fail" ? 1 : 0 };
      }
      default:
        return { action: `run ${sub ?? ""}`.trim(), code: 0 };
    }
  }
  if (group === "api") {
    const path = sub ?? "";
    const jobLog = /actions\/jobs\/(\d+)\/logs/.exec(path);
    if (jobLog) {
      for (const p of prs) {
        const job = p.checks?.jobs.find((j) => String(j.databaseId) === jobLog[1]);
        if (!job) continue;
        const cur = currentAttempt(p, state)!;
        out.push(readLog(replay, cur.attempt.logFile).split("\n").filter((l) => l.startsWith(`${job.name}\t`)).join("\n"));
        return { action: "api job logs", code: 0 };
      }
    }
    const pulls = /pulls\/(\d+)(\/files)?/.exec(path);
    if (pulls) {
      const pr = selectPr(prs, pulls[1]);
      if (pr) return { action: pulls[2] ? "api pr files" : "api pr", code: emitJson(pulls[2] ? pr.files.map((f) => ({ filename: f.path, additions: f.additions, deletions: f.deletions })) : prJson(replay, pr, state), rest) };
    }
    print("{}");
    return { action: "api", code: 0 };
  }
  return { action: "unknown", code: 0 };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (!dir) {
    process.stderr.write("gh（评测替身）：没有 EVAL_GH_DIR\n");
    process.exit(1);
  }
  const replay = loadReplay();
  const state = loadState(replay);
  const { action, code } = run(argv, replay, state);
  state.seq += 1;
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const call: GhCall = { seq: state.seq, at: Date.now(), argv, cwd: process.cwd(), action, exitCode: code };
  appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(call)}\n`);
  process.stdout.write(out.join(""));
  process.stderr.write(err.join(""));
  process.exitCode = code;
}

main();
