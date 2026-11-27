import type { WorkerPr, WorkerPrProbeResult } from "./hub.ts";

export const REVIEW_VERDICTS = ["PASS", "FAIL"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
/** Historical task-graph rows written before PASS+NOTES was removed remain readable for display. */
export type StoredReviewVerdict = ReviewVerdict | "PASS+NOTES";

export const REVIEW_VERDICT_FIELD = "结论";
export const REVIEW_SHA_FIELD = "验证提交";

/** `sha` is the commit checked out for review; `local` is the local branch at that moment, which can lag behind it. Rows written before `local` existed omit it. */
export interface ReviewSnapshot {
  sha: string;
  local?: string | null;
  remote: { name?: string; sha: string | null } | null;
  pr: WorkerPr | null;
}

export interface ReviewTarget {
  branch: string;
  snapshot: ReviewSnapshot | null;
}

export interface ReviewObservation {
  sha: string | null;
  remote: { name: string; sha: string | null } | null;
  pr: WorkerPrProbeResult;
}

export interface ReviewVerifyResult {
  problems: string[];
}

export function parseReviewTarget(json: string | null): ReviewTarget | null {
  if (json === null) return null;
  const raw = JSON.parse(json) as ReviewTarget;
  return { branch: raw.branch, snapshot: raw.snapshot ?? null };
}

const stripEdgeMarks = (raw: string): string => raw.trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");

export function parseReviewVerdict(raw: string): ReviewVerdict | null {
  const normalized = stripEdgeMarks(raw).toUpperCase();
  return REVIEW_VERDICTS.find((v) => v === normalized) ?? null;
}

export function parseReviewCommit(raw: string): string | null {
  const normalized = stripEdgeMarks(raw).toLowerCase();
  return normalized === "" ? null : normalized;
}

const SHORT_SHA_MIN = 7;

function sameCommit(written: string | null, sha: string): boolean {
  if (written === null) return false;
  return /^[0-9a-f]+$/u.test(written) && written.length >= SHORT_SHA_MIN && sha.toLowerCase().startsWith(written);
}

export function reviewReportProblem(
  report: { verdict: ReviewVerdict | null; verifiedCommit: string | null },
  target: ReviewTarget,
): string | null {
  if (report.verdict === null) return `审查没写“${REVIEW_VERDICT_FIELD}”或写错了（只能是 ${REVIEW_VERDICTS.join("、")}）`;
  if (target.snapshot === null) return `审查目录没记下被审分支 ${target.branch} 开审时的提交，没法核对`;
  if (!sameCommit(report.verifiedCommit, target.snapshot.sha)) {
    return `审查的“${REVIEW_SHA_FIELD}”写的是 ${report.verifiedCommit ?? "（没写）"}，被审的是分支 ${target.branch} 的提交 ${target.snapshot.sha}`;
  }
  return null;
}

const short = (sha: string | null): string => (sha === null ? "（没有）" : sha.slice(0, 12));

export function diffReviewSnapshot(branch: string, before: ReviewSnapshot, now: ReviewObservation): string[] {
  const problems: string[] = [];
  const localBefore = before.local === undefined ? before.sha : before.local;
  if (now.sha !== localBefore) problems.push(`本地分支 ${branch} 从 ${short(localBefore)} 变成了 ${short(now.sha)}`);
  if (before.remote !== null) {
    const remoteName = before.remote.name ?? now.remote?.name ?? "远端";
    if (now.remote === null) problems.push(`仓库的远端 ${remoteName} 不见了，没法核对远端分支 ${branch}`);
    else if (now.remote.sha !== before.remote.sha) problems.push(`${now.remote.name} 上的分支 ${branch} 从 ${short(before.remote.sha)} 变成了 ${short(now.remote.sha)}`);
  }
  if (before.pr !== null) {
    if (now.pr === null) problems.push(`PR ${before.pr.url} 查不到了`);
    else if ("unavailable" in now.pr) problems.push(`查不了 PR ${before.pr.url} 的状态（${now.pr.unavailable}）`);
    else if (now.pr.state !== before.pr.state) problems.push(`PR ${before.pr.url} 从 ${before.pr.state} 变成了 ${now.pr.state}`);
  }
  return problems;
}

export function reviewVerifyFailedText(problems: readonly string[]): string {
  return `收尾核对发现被审分支在审查期间被动过，审查结论作废：\n${problems.map((p) => `- ${p}`).join("\n")}`;
}

export function reviewVerifyErrorProblem(error: string): string {
  return `收尾核对没跑成：${error}`;
}

// GIT_CONFIG_COUNT (git 2.31+) outranks repo config; append after any entries already in the daemon's env.
export const REVIEW_HOOKS_DIR = "review-hooks";
export const REVIEW_PRE_PUSH_HOOK = `#!/bin/sh
echo "审查步骤只查不修：不能推送。发现的问题写进汇报，修复由项目经理另派 Worker。" >&2
exit 1
`;

export function reviewPushGuardEnv(hooksDir: string, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const count = Number.parseInt(inherited.GIT_CONFIG_COUNT ?? "", 10);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${n}`]: hooksDir,
  };
}

export function reviewWorkspaceLines(worktreePath: string, branch: string): string[] {
  return [
    `- 工作目录：${worktreePath}，是审查专用的 git worktree，detached 在被审分支 ${branch} 的提交上，不挂分支。被审的提交号用 \`git rev-parse HEAD\` 看。`,
    `- 这个目录仅供本地查证，改动推不上去（pre-push 钩子拒绝），收工后目录直接删掉。`,
    `- 被审分支 ${branch} 不能改；审查期间它一变，后台就判结论作废。`,
  ];
}

export function reviewTakeoverWorkspaceNote(worktreePath: string, branch: string): string {
  return `你在新开的审查目录 ${worktreePath} 里，detached 在被审分支 ${branch} 上；前任的审查目录不接手，它的结论和复现看下面的记录。`;
}

export const REVIEW_CHECKLIST = [
  "这一步是独立审查：只查不修，你不是作者。",
  "- 对照上面的目标、代码改动和项目自身的说明或规矩找真实缺陷；发现问题不修，写清复现方式、文件和行号，由项目经理另派 Worker 处理。",
  "- 复审（第 2 轮起）聚焦上一轮未决的问题与增量改动，不从头重审无关文件。",
  "- 按项目自身情况验证，不硬要求已有云端 CI 的项目在本机重跑全量测试。",
  `- 汇报在“摘要”下面多写两栏：\`${REVIEW_VERDICT_FIELD}: ${REVIEW_VERDICTS.join(" | ")}\` 和 \`${REVIEW_SHA_FIELD}: <你验证的完整提交号>\`。PASS 表示可以通过，FAIL 表示有阻塞问题、步骤停下等项目经理处理。`,
  "- “交棒”简述核查范围与结论；有审查报告或截图文件写进“文件”栏。",
].join("\n");
