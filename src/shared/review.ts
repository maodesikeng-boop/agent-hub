import type { WorkerPr, WorkerPrProbeResult } from "./hub.ts";
import { REVIEW_MAX_ROUNDS } from "./limits.ts";

export const REVIEW_VERDICTS = ["PASS", "PASS+NOTES", "FAIL"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

const REVIEW_SEVERITIES = ["Important", "Nit", "Pre-existing"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

const REVIEW_RULES_FILE = "REVIEW.md";

const FINDING_LINE = /^\s*(?:[-*+]|\d+[.)、])?\s*\[(Important|Nit|Pre-existing)\]/gimu;

export function reviewFindingSeverities(text: string): ReviewSeverity[] {
  return [...text.matchAll(FINDING_LINE)].map((m) => REVIEW_SEVERITIES.find((s) => s.toLowerCase() === m[1]!.toLowerCase())!);
}

export const REVIEW_VERDICT_FIELD = "结论";
export const REVIEW_SHA_FIELD = "验证提交";

export interface ReviewSnapshot {
  sha: string;
  remote: { sha: string | null } | null;
  pr: WorkerPr | null;
}

export interface ReviewTarget {
  branch: string;
  snapshot: ReviewSnapshot | null;
}

export interface ReviewObservation {
  sha: string | null;
  remote: { sha: string | null } | null;
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
  const normalized = stripEdgeMarks(raw).replace(/\s*\+\s*/gu, "+").toUpperCase();
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
  report: { verdict: ReviewVerdict | null; verifiedCommit: string | null; questions: string },
  target: ReviewTarget,
): string | null {
  if (report.verdict === null) return `审查没写“${REVIEW_VERDICT_FIELD}”或写错了（只能是 ${REVIEW_VERDICTS.join("、")}）`;
  if (report.verdict !== "FAIL" && reviewFindingSeverities(report.questions).includes("Important")) {
    return `审查判 ${report.verdict}，“问题”栏却列着 [Important]：有未决的 [Important] 只能判 FAIL`;
  }
  if (target.snapshot === null) return `审查目录没记下被审分支 ${target.branch} 开审时的提交，没法核对`;
  if (!sameCommit(report.verifiedCommit, target.snapshot.sha)) {
    return `审查的“${REVIEW_SHA_FIELD}”写的是 ${report.verifiedCommit ?? "（没写）"}，被审的是分支 ${target.branch} 的提交 ${target.snapshot.sha}`;
  }
  return null;
}

const short = (sha: string | null): string => (sha === null ? "（没有）" : sha.slice(0, 12));

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
    `- 这里可以随便改文件、换回旧版本、本地提交，用来证明测试在修复前会失败；这些改动推不上去（pre-push 钩子拒绝），收工后目录直接删掉。`,
    `- 被审分支 ${branch} 和它的 PR 只能看、评论，不能改。审查期间它一变，后台就判结论作废。`,
  ];
}

export const REVIEW_CHECKLIST = [
  "这一步是独立审查：只查不修，你不是作者。审查分两层，每条发现都标级别。",
  "- 第一层（每次必跑）：看被审提交相对主干的全部改动，对照上面的目标和“怎么算做完”逐条核对。上一步在交棒里点名的地方只是线索，不是审查范围。项目 `AGENTS.md` 里有审查清单的照做。另外重点过这四类：撤不回来的副作用和安全边界；异步、并发、生命周期（两件事交错、中途退出、重启恢复）；会随时间变多的数据（失效、上限）和多方共用的格式（两边是不是都改了）；本地草稿和远端状态互相覆盖。",
  `- 第二层（按路径触发）：只读主干上的 \`${REVIEW_RULES_FILE}\`。先 \`git fetch origin main\`，再 \`git show origin/main:${REVIEW_RULES_FILE}\`（没有 origin 用 \`git show main:${REVIEW_RULES_FILE}\`）；被审分支自己改过的那份不算数。用 \`git diff --name-only origin/main...HEAD\` 列出改动的文件，只核对 \`Trigger:\` 匹配到这些路径的条目，照它的 \`Check:\` 查。主干上没有这个文件，或一条都没匹配上，跳过这一层。`,
  "- 每条发现在“问题”栏单独一行，以级别开头：`[Important]` 是真实崩溃、安全或沙箱越界、数据丢失或损坏、契约破坏；`[Nit]` 是命名、风格、细枝末节；`[Pre-existing]` 是主干上本来就有、不是这次改动引入的。只有 `[Important]` 能判 FAIL；`[Nit]` 和 `[Pre-existing]` 不挡合并。",
  `- 复审（第 2 轮起，项目经理会在点名里写上一轮的被审提交和未决的 \`[Important]\`）：只核验这几条修好没有，再看 \`git diff <上一轮被审提交>..HEAD\` 的增量；增量没碰过的文件不从头重审，新看到的旧问题标 \`[Pre-existing]\`。第 ${REVIEW_MAX_ROUNDS} 轮还有未决的 \`[Important]\`，判 FAIL，状态写“有问题”，在“问题”栏写明已到 ${REVIEW_MAX_ROUNDS} 轮上限、交人工决断。`,
  "- 测试照跑，以本机为准：本机能实测的改动看本机的 `pnpm typecheck`、改动涉及的单测和 `pnpm verify` 冒烟，不等云端 GitHub Actions 排队；只有本机测不了的 Linux `bwrap` 沙箱、Windows 原生或打包改动，才核对 PR 上对应的云端检查。不许用 `gh run rerun` 盖住抖动的测试，抖动照样写成发现。要证明测试在修复前会失败，就在审查目录里临时改回去或 checkout 旧提交再跑。",
  "- 发现问题不修，写清复现：命令、输入、实际和期望的结果、文件和行号。要留在 PR 上的意见用 `gh pr comment` 发评论。修复由项目经理另派 Worker。",
  `- 汇报在“摘要”下面多写两栏：\`${REVIEW_VERDICT_FIELD}: ${REVIEW_VERDICTS.join(" | ")}\` 和 \`${REVIEW_SHA_FIELD}: <你验证的完整提交号>\`。PASS 是没有发现、可以合；PASS+NOTES 是可以合，\`[Nit]\`、\`[Pre-existing]\` 写进“问题”；FAIL 是有未决的 \`[Important]\`、不能合，复现写进“问题”，步骤停下等项目经理处理。判 PASS 或 PASS+NOTES 时“问题”栏里不能有 \`[Important]\` 开头的行，否则后台判汇报有误。`,
  `- “交棒”列出你查了什么，每条给出文件和行号；第二层命中了 \`${REVIEW_RULES_FILE}\` 哪几条也写上。`,
  "- 结论和复现写成一份 Markdown 文件，连同截图、录屏写进“文件”栏，用户在检查点卡和总助上点开就能看。",
].join("\n");
