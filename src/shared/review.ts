// 审查步骤只查不修（docs/review-verify-only-design.md）。结论、审查清单、审查目录的说明、禁推钩子、收尾核对的规则只在这里定义；
// 账本（任务图、Worker）、启动准备（launch.ts）、建目录和核对的处理函数（handlers.ts）都从这里取。
import type { WorkerPr, WorkerPrProbeResult } from "./hub.ts";

export const REVIEW_VERDICTS = ["PASS", "PASS+NOTES", "FAIL"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 审查步骤的汇报在八栏之外多出的两栏。 */
export const REVIEW_VERDICT_FIELD = "结论";
export const REVIEW_SHA_FIELD = "验证提交";

/**
 * 被审分支在某一刻的样子。派审查、建好审查目录时记一份（workers.review_json），审查汇报 PASS 后再查一份，两份要一样。
 * - sha：本地分支 refs/heads/<branch> 的提交，也是审查目录 detached 检出的提交；
 * - remote：origin 上同名分支的提交（origin 上没有这个分支是 { sha: null }）；仓库没有 origin 是 null，不核对远端；
 * - pr：分支上的 PR；没有 PR、或建目录时 gh 查不了是 null，不核对 PR。
 */
export interface ReviewSnapshot {
  sha: string;
  remote: { sha: string | null } | null;
  pr: WorkerPr | null;
}

/**
 * 审查 Worker 审的是哪条分支（被审目标）：审查步骤的 base 写明的分支，没写就是唯一上一步 Worker 的分支（task-graphs.ts 的 resolveReviewPlan）。
 * 找不到被审分支的审查步骤建图、改图时拒绝，派活时报错，不会退成普通 Worker。snapshot 在审查目录建好之前是 null。
 */
export interface ReviewTarget {
  branch: string;
  snapshot: ReviewSnapshot | null;
}

/** 收尾核对时现查的被审分支：本地分支删了 sha 是 null。 */
export interface ReviewObservation {
  sha: string | null;
  remote: { sha: string | null } | null;
  pr: WorkerPrProbeResult;
}

/** 收尾核对的结果：problems 为空才算被审分支没被动过。 */
export interface ReviewVerifyResult {
  problems: string[];
}

export function parseReviewTarget(json: string | null): ReviewTarget | null {
  if (json === null) return null;
  const raw = JSON.parse(json) as ReviewTarget;
  return { branch: raw.branch, snapshot: raw.snapshot ?? null };
}

/** 栏值首尾的空白、标点、符号（行内代码的反引号、句号、引号、加粗）。 */
const stripEdgeMarks = (raw: string): string => raw.trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");

/** “结论”栏的值：大小写、+ 两边的空格、首尾标点都不计较；不是三种之一返回 null。 */
export function parseReviewVerdict(raw: string): ReviewVerdict | null {
  const normalized = stripEdgeMarks(raw).replace(/\s*\+\s*/gu, "+").toUpperCase();
  return REVIEW_VERDICTS.find((v) => v === normalized) ?? null;
}

/** “验证提交”栏的值：首尾标点不计较、转成小写；没写是 null。 */
export function parseReviewCommit(raw: string): string | null {
  const normalized = stripEdgeMarks(raw).toLowerCase();
  return normalized === "" ? null : normalized;
}

const SHORT_SHA_MIN = 7;

/** “验证提交”写的是不是被审的提交：完整提交号或至少 7 位前缀。 */
function sameCommit(written: string | null, sha: string): boolean {
  if (written === null) return false;
  return /^[0-9a-f]+$/u.test(written) && written.length >= SHORT_SHA_MIN && sha.toLowerCase().startsWith(written);
}

/** 审查汇报本身的毛病：没写结论、写错了，或“验证提交”不是开审时记下的被审提交。没毛病返回 null。 */
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

/** 比较开审时记下的和收尾时现查的被审分支，列出每一处不一样（顺序：本地、远端、PR）。 */
export function diffReviewSnapshot(branch: string, before: ReviewSnapshot, now: ReviewObservation): string[] {
  const problems: string[] = [];
  if (now.sha !== before.sha) problems.push(`本地分支 ${branch} 从 ${short(before.sha)} 变成了 ${short(now.sha)}`);
  if (before.remote !== null) {
    const nowRemote = now.remote?.sha ?? null;
    if (now.remote === null) problems.push(`仓库的 origin 不见了，没法核对远端分支 ${branch}`);
    else if (nowRemote !== before.remote.sha) problems.push(`origin 上的分支 ${branch} 从 ${short(before.remote.sha)} 变成了 ${short(nowRemote)}`);
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

/**
 * 审查 Worker 的禁推：git 的 core.hooksPath 指到守护进程写的钩子目录，里面只有一个拒绝推送的 pre-push。
 * 用 git 官方的 GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n（git 2.31 起）经启动环境变量注入，优先级高于仓库配置，6 家厂商同一个入口。
 * 守护进程自己的环境里已经有 GIT_CONFIG_COUNT 时接在后面，不盖掉原有的几项。
 */
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

/** 审查 Worker 第一条消息“在哪干活”里的说明。 */
export function reviewWorkspaceLines(worktreePath: string, branch: string): string[] {
  return [
    `- 工作目录：${worktreePath}，是审查专用的 git worktree，detached 在被审分支 ${branch} 的提交上，不挂分支。被审的提交号用 \`git rev-parse HEAD\` 看。`,
    `- 这里可以随便改文件、换回旧版本、本地提交，用来证明测试在修复前会失败；这些改动推不上去（pre-push 钩子拒绝），收工后目录直接删掉。`,
    `- 被审分支 ${branch} 和它的 PR 只能看、评论，不能改。审查期间它一变，后台就判结论作废。`,
  ];
}

/** 步骤标了 review: true 时，前置在“你这一步”开头的内置审查清单。 */
export const REVIEW_CHECKLIST = [
  "这一步是独立审查：只查不修，你不是作者。",
  "- 看被审提交相对主干的全部改动，对照上面的目标和“怎么算做完”逐条核对。上一步在交棒里点名的地方只是线索，不是审查范围。",
  "- 项目 `AGENTS.md` 里有审查清单的照做。另外重点过这四类：撤不回来的副作用和安全边界；异步、并发、生命周期（两件事交错、中途退出、重启恢复）；会随时间变多的数据（失效、上限）和多方共用的格式（两边是不是都改了）；本地草稿和远端状态互相覆盖。",
  "- 测试、构建照跑；要证明测试在修复前会失败，就在审查目录里临时改回去或 checkout 旧提交再跑。",
  "- 发现问题不修，写清复现：命令、输入、实际和期望的结果、文件和行号。要留在 PR 上的意见用 `gh pr comment` 发评论。修复由项目经理另派 Worker。",
  `- 汇报在“摘要”下面多写两栏：\`${REVIEW_VERDICT_FIELD}: ${REVIEW_VERDICTS.join(" | ")}\` 和 \`${REVIEW_SHA_FIELD}: <你验证的完整提交号>\`。PASS 是可以合；PASS+NOTES 是可以合，不挡合并的意见写进“问题”；FAIL 是不能合，复现写进“问题”，步骤停下等项目经理处理。`,
  "- “交棒”列出你查了什么，每条给出文件和行号。",
].join("\n");
