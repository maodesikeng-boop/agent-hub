import { BRANCH_TIP_FETCH_TIMEOUT_MS, GIT_PROBE_TIMEOUT_MS, GIT_TIMEOUT_MS } from "../../shared/limits.ts";
import type { BranchTipFinding, FastForwardOutcome } from "../../shared/ledger.ts";
import { failedGit, GitError, resolveCommit, runGit } from "./git.ts";

export interface RemoteBranchHead {
  name: string;
  sha: string | null;
}

export interface BranchTip {
  commit: string;
  local: string | null;
  remote: RemoteBranchHead | null;
  findings: BranchTipFinding[];
}

export type ResolveBranchTip = (repo: string, branch: string, expected: string | null) => Promise<BranchTip>;

type RemotePick = { kind: "remote"; name: string } | { kind: "none"; finding: BranchTipFinding };

const LC = { LC_ALL: "C" };

const lines = (stdout: string): string[] => stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");

async function configValue(repo: string, key: string): Promise<string | null> {
  const run = await runGit(repo, ["config", "--get", key], GIT_PROBE_TIMEOUT_MS, LC);
  return run.code === 0 && run.stdout.trim() !== "" ? run.stdout.trim() : null;
}

async function isValidBranchName(repo: string, branch: string): Promise<boolean> {
  if (branch === "" || branch.startsWith("-")) return false;
  return (await runGit(repo, ["check-ref-format", `refs/heads/${branch}`], GIT_PROBE_TIMEOUT_MS, LC)).code === 0;
}

/** Picks the remote that holds the branch without assuming a remote name: push config first, then upstream config, then the only remote or the only remote tracking it. */
export async function branchRemote(repo: string, branch: string): Promise<RemotePick> {
  const listed = await runGit(repo, ["remote"], GIT_PROBE_TIMEOUT_MS, LC);
  if (listed.code !== 0) throw failedGit("git remote", listed);
  const names = lines(listed.stdout);
  if (names.length === 0) return { kind: "none", finding: { kind: "no_remote" } };
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
    const value = await configValue(repo, key);
    if (value !== null && names.includes(value)) return { kind: "remote", name: value };
  }
  if (names.length === 1) return { kind: "remote", name: names[0]! };
  const refs = names.map((n) => `refs/remotes/${n}/${branch}`);
  const tracking = await runGit(repo, ["for-each-ref", "--format=%(refname)", ...refs], GIT_PROBE_TIMEOUT_MS, LC);
  const found = tracking.code !== 0 ? [] : lines(tracking.stdout);
  const holders = names.filter((n) => found.includes(`refs/remotes/${n}/${branch}`));
  if (holders.length === 1) return { kind: "remote", name: holders[0]! };
  return { kind: "none", finding: { kind: "ambiguous_remote", remotes: names } };
}

/** Read-only probe of the branch on `remote` (or the branch's own remote when omitted) for the post-review check; undefined when that remote is gone, throws when it cannot be reached. */
export async function remoteBranchHead(repo: string, branch: string, remote?: string): Promise<RemoteBranchHead | undefined> {
  let name = remote;
  if (name === undefined) {
    const pick = await branchRemote(repo, branch);
    if (pick.kind === "none") return undefined;
    name = pick.name;
  } else {
    const listed = await runGit(repo, ["remote"], GIT_PROBE_TIMEOUT_MS, LC);
    if (listed.code !== 0) throw failedGit("git remote", listed);
    if (!lines(listed.stdout).includes(name)) return undefined;
  }
  const run = await runGit(repo, ["ls-remote", name, `refs/heads/${branch}`], GIT_TIMEOUT_MS, LC);
  if (run.code !== 0) throw failedGit("git ls-remote", run);
  const line = lines(run.stdout).find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return { name, sha: line === undefined ? null : line.split("\t")[0]! };
}

async function fetchBranch(repo: string, remote: string, branch: string): Promise<{ sha: string | null } | { error: string }> {
  let run;
  try {
    run = await runGit(
      repo,
      ["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      BRANCH_TIP_FETCH_TIMEOUT_MS,
      LC,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (run.code !== 0) {
    if (/couldn't find remote ref/i.test(run.stderr)) return { sha: null };
    return { error: (run.stderr.trim() || `exit ${run.code}`).split("\n")[0]! };
  }
  return { sha: await resolveCommit(repo, `refs/remotes/${remote}/${branch}`) };
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const run = await runGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant], GIT_TIMEOUT_MS, LC);
  if (run.code === 0) return true;
  if (run.code === 1) return false;
  throw failedGit("git merge-base --is-ancestor", run);
}

async function resolveExpected(repo: string, expected: string | null): Promise<string | null> {
  if (expected === null) return null;
  try {
    return await resolveCommit(repo, expected);
  } catch {
    return null;
  }
}

async function remoteHead(repo: string, branch: string, findings: BranchTipFinding[]): Promise<RemoteBranchHead | null> {
  if (!(await isValidBranchName(repo, branch))) return null;
  let pick: RemotePick;
  try {
    pick = await branchRemote(repo, branch);
  } catch {
    return null;
  }
  if (pick.kind === "none") {
    findings.push(pick.finding);
    return null;
  }
  const fetched = await fetchBranch(repo, pick.name, branch);
  if ("error" in fetched) {
    findings.push({ kind: "fetch_failed", remote: pick.name, error: fetched.error });
    return null;
  }
  return { name: pick.name, sha: fetched.sha };
}

async function missingBranchError(repo: string, branch: string): Promise<GitError> {
  const probe = await runGit(repo, ["rev-parse", "--git-dir"], GIT_PROBE_TIMEOUT_MS, LC);
  if (probe.code !== 0) return new GitError("git_failed", `${repo} 不是 git 仓库，没法检出分支 ${branch}。`);
  return new GitError("git_failed", `${repo} 里找不到分支 ${branch}（本地和远端都没有）。`);
}

/**
 * The commit a downstream step should start from: the newest of the local branch and the same branch on its remote,
 * cross-checked against the commit the upstream step reported. Falls back to the local branch when there is no remote or it cannot be reached.
 */
export async function resolveBranchTip(repo: string, branch: string, expected: string | null): Promise<BranchTip> {
  const findings: BranchTipFinding[] = [];
  const local = await resolveCommit(repo, `refs/heads/${branch}`);
  const remote = await remoteHead(repo, branch, findings);
  const remoteSha = remote?.sha ?? null;
  const wanted = await resolveExpected(repo, expected);
  let commit: string;
  if (remoteSha === null || remoteSha === local) {
    if (local === null) throw await missingBranchError(repo, branch);
    commit = local;
  } else if (local === null) {
    commit = remoteSha;
  } else if (await isAncestor(repo, local, remoteSha)) {
    commit = remoteSha;
    findings.push({ kind: "remote_ahead", remote: remote!.name, local });
  } else if (wanted === remoteSha) {
    commit = remoteSha;
    findings.push({ kind: "remote_rewound", remote: remote!.name, local, remoteSha });
  } else if (await isAncestor(repo, remoteSha, local)) {
    commit = local;
    findings.push({ kind: "local_ahead", remote: remote!.name, remoteSha });
  } else {
    const localHasIt = wanted !== null && (await isAncestor(repo, wanted, local)) && !(await isAncestor(repo, wanted, remoteSha));
    commit = localHasIt ? local : remoteSha;
    findings.push({ kind: "diverged", remote: remote!.name, local, remoteSha });
  }
  if (expected !== null && (wanted === null || !(await isAncestor(repo, wanted, commit)))) {
    findings.push({ kind: "expected_missing", expected });
  }
  return { commit, local, remote, findings };
}

export type SyncOutcome = FastForwardOutcome | { kind: "not_on_branch" };

export interface WorktreeSyncResult {
  tip: BranchTip | null;
  outcome: SyncOutcome;
}

/** Brings an inherited worktree up to the branch's delivered tip, but only by fast-forward on a clean checkout of that branch. */
export async function syncWorktreeBranch(repo: string, worktreePath: string, branch: string, expected: string | null): Promise<WorktreeSyncResult> {
  const head = await runGit(worktreePath, ["symbolic-ref", "-q", "HEAD"], GIT_PROBE_TIMEOUT_MS, LC);
  if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) return { tip: null, outcome: { kind: "not_on_branch" } };
  const tip = await resolveBranchTip(repo, branch, expected);
  if (tip.local === null || tip.commit === tip.local || !(await isAncestor(repo, tip.local, tip.commit))) {
    return { tip, outcome: { kind: "up_to_date" } };
  }
  const status = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=no"], GIT_TIMEOUT_MS, LC);
  if (status.code !== 0) return { tip, outcome: { kind: "failed", to: tip.commit, error: failedGit("git status", status).message } };
  if (status.stdout.trim() !== "") return { tip, outcome: { kind: "dirty", to: tip.commit } };
  const merge = await runGit(worktreePath, ["merge", "--ff-only", "--quiet", tip.commit], GIT_TIMEOUT_MS, LC);
  if (merge.code !== 0) return { tip, outcome: { kind: "failed", to: tip.commit, error: failedGit("git merge --ff-only", merge).message } };
  return { tip, outcome: { kind: "fast_forwarded", from: tip.local, to: tip.commit } };
}
