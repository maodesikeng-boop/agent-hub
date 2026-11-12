// 第一版的 3 个场景（docs/orchestration-eval-design.md 第 2 节；用户 11-12 拍板：3 个真实场景、只跑 Claude、只用确定性检查）：
// - S3a 托盘：真实案例 Worker #453（11-11 21:28～22:36，消息 #49295、#49299、#49435，提交 da36ed7，PR 288）；
// - S5a CI 镜像故障：同一个托盘 PR 的 4 路检查在装 bubblewrap、socat 时解析不了 Ubuntu 软件源（11-11 22:42～23:15，
//   消息 #49679、#49726、#49842；run 43040062881 两次的真实失败日志）；
// - H2 验收不读代码：11-11 23:17 真实的那次习惯改动（性格设定改动记录 #118 新加的那一条）。
// 被测项目经理的性格设定一律是中性的空设定（NEUTRAL_PERSONA）：用户 11-12 说“肯定不能你来跑，你有我们的上下文”，
// 现任项目经理的性格设定里已经写着考点，不能拿来用；用户的习惯只由场景在考的时候注入（H2 用资料页的接口改性格设定）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askBeforeScope,
  askedWithCard,
  blameRight,
  cardRecommends,
  checkedCi,
  dispatched,
  logBeforeAction,
  lookedAtEvidence,
  noDiffRead,
  noMergeWhileRed,
  noPreGate,
  noReview,
  personaReachedPm,
  quotesKept,
  smallGraph,
  type TraySpec,
} from "./checks.ts";
import type { AskSeen, GhAttempt, GhPr, GhReplay, Scenario, ScenarioContext, WorkerReplay } from "./types.ts";

export const REPLAY_DIR = new URL("./replay/", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(REPLAY_DIR, rel), "utf8");

/** 被测项目经理的性格设定：空的，不带任何用户习惯（见文件开头）。 */
export const NEUTRAL_PERSONA = "";

/** 真实托盘任务所在的主干提交（PR 286 合并后，Worker #453 的 base_commit）。 */
const TRAY_BASE = "d9d67a21985eaca5355a1d6320e0e5f50afb855d";
const REPO = "maodesikeng-boop/agent-hub";

const TRAY_SPEC: TraySpec = {
  keywords: ["托盘", "Needs You", "三分之一"],
  quotes: ["约三分之一屏"],
  changedFiles: ["docs/ui-standard.md", "src/web/components/RouterWorkbench.tsx", "src/web/router-workbench.test.tsx"],
  maxNodes: 2,
};

/** 真实那次的提交人信息：打补丁时照用，回放出来的提交号就是当时的 da36ed7（汇报里写的那个）。 */
const TRAY_COMMITTER = { name: "maodesikeng-boop", email: "260866478+maodesikeng-boop@users.noreply.github.com", date: "1794407728 +0800" };

const trayWorker = (gated = false): WorkerReplay => ({
  name: "托盘",
  promptIncludes: TRAY_SPEC.keywords as string[],
  patch: { file: "tray/tray.patch", committer: TRAY_COMMITTER },
  reportFile: "tray/report-453.md",
  ...(gated ? { gated } : {}),
});

/** 通用的“做完了”（剧本里没有的 Worker；被打回后的下一轮）。 */
const GENERIC_REPORT = "收到，已按你的消息处理。\n\n=== 汇报 ===\n状态: 做完了\n摘要: 已按你的消息处理，没有新的改动。\n提交: 无\n测试: 无\n问题: 无\n=== 汇报结束 ===";

const CI_REPORT = `已给 CI 装沙箱依赖那一步加了缓存和备用源，只改了 \`.github/workflows/check.yml\`，PR：https://github.com/${REPO}/pull/294。

=== 汇报 ===
状态: 做完了
摘要: check.yml 装 bubblewrap、socat 前先用 actions/cache 缓存的 .deb 离线装；镜像连不上时自动改用 Ubuntu 官方源重试。提了 PR 294，没有合并。
提交: 3f1c0de
测试: 只改了 CI 配置；本地用 actionlint 检查语法通过。
问题: 无
=== 汇报结束 ===`;

const JOBS = [
  { name: "check (ubuntu 1/4)", elapsed: "5m42s", databaseId: 130589141852 },
  { name: "check (ubuntu 2/4)", elapsed: "5m42s", databaseId: 130589141754 },
  { name: "check (ubuntu 3/4)", elapsed: "5m42s", databaseId: 130589141289 },
  { name: "check (ubuntu 4/4)", elapsed: "5m38s", databaseId: 130589141690 },
];

function trayPr(attempts: GhAttempt[]): GhPr {
  return {
    number: 288,
    title: "feat(web): 手机外壳下 Needs You 托盘上限降为 33dvh",
    body: "手机外壳（MOBILE_SHELL_QUERY）下 Needs You 托盘上限降为 33dvh，桌面保持 50dvh；同步更新 ui-standard.md 第 21 条与单测。",
    headRefName: "hub/453-手机-needs-you-托盘降到约三分之一屏",
    headRefOid: "da36ed775e9c3b4e63e8606cdf14c7e903e63f41",
    state: "OPEN",
    files: [
      { path: "docs/ui-standard.md", additions: 1, deletions: 1 },
      { path: "src/web/components/RouterWorkbench.tsx", additions: 9, deletions: 1 },
      { path: "src/web/router-workbench.test.tsx", additions: 38, deletions: 1 },
    ],
    diffFile: "tray/tray.patch",
    checks: { runId: 43040062881, workflow: "check", jobs: JOBS, attempts },
  };
}

/** 前情里那个 PR（已合并，主文件夹的基准提交就是它的合并提交）。 */
const PR_286: GhPr = {
  number: 286,
  title: "feat(web): 总助 v2 前端工作台与双端截图",
  body: "新版总助前端。",
  headRefName: "hub/439-接力总助v2前端工作台与双端截图",
  headRefOid: TRAY_BASE,
  state: "MERGED",
  files: [],
};

const CI_PR: GhPr = {
  number: 294,
  title: "ci: 沙箱依赖加缓存和备用源",
  body: "装 bubblewrap、socat 前先用缓存的 .deb；镜像连不上时改用官方源。",
  headRefName: "hub/2-ci-装沙箱依赖加缓存和备用源",
  headRefOid: "3f1c0de".padEnd(40, "0"),
  state: "OPEN",
  files: [{ path: ".github/workflows/check.yml", additions: 60, deletions: 4 }],
  checks: { runId: 43050000001, workflow: "check", jobs: JOBS.map((j, i) => ({ ...j, databaseId: 130600000000 + i })), attempts: [{ status: "pass" }] },
};

const ghReplay = (prs: GhPr[]): GhReplay => ({ repo: REPO, prs, nextPr: 295 });

/** 前情 + 用户当时的回答（消息 #49435 原文）。 */
function trayDemand(ctx: ScenarioContext): string {
  return `${read("tray/prelude.md").replaceAll("{PRELUDE_SHOTS}", ctx.preludeShotsDir)}降到约三分之一屏（推荐）`;
}

/** 剧本里没有的提问：用户统一按推荐答（设计 3.3），记一次“多问了”。 */
function answerByRecommendation(ask: AskSeen): { text: string; scripted: boolean } {
  const recommended = ask.options.find((o) => o.includes("推荐")) ?? ask.options[0];
  return { text: recommended ?? "按你的推荐来", scripted: false };
}

const TRAY_CHECKS = [dispatched(TRAY_SPEC), noReview(TRAY_SPEC), noPreGate(TRAY_SPEC), smallGraph(TRAY_SPEC), quotesKept(TRAY_SPEC), noDiffRead(TRAY_SPEC), lookedAtEvidence(TRAY_SPEC)];

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "s3a-tray",
    title: "S3a 托盘降高（拆法、验收）",
    source: "Worker #453；用户 11-11 17:55“成功了，只读汇报……不要去比对它改过的所有代码了”、18:21“需要我点头的地方难到你在建图的时候都能想好吗？？”",
    baseCommit: TRAY_BASE,
    demand: trayDemand,
    workers: [trayWorker()],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([PR_286, trayPr([{ status: "pass" }])]),
    shots: { dir: "tray/shots", preludeDir: "tray/prelude-shots" },
    answer: answerByRecommendation,
    checks: TRAY_CHECKS,
  },
  {
    id: "s5a-ci-mirror",
    title: "S5a CI 镜像故障（纠错）",
    source: "PR 288 run 43040062881；用户 11-12 09:39“遇到问题会不会改”、11-11 17:55“失败了，你看原因，想办法修复”",
    baseCommit: TRAY_BASE,
    demand: trayDemand,
    // CI 那类放前面：改 CI 的任务说明里可能也提到托盘，托盘的任务说明里不会有这些词
    workers: [{ name: "CI 配置", promptIncludes: ["check.yml", "bubblewrap", "socat", "软件源", "apt", "镜像"], reportText: CI_REPORT }, trayWorker()],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([
      PR_286,
      trayPr([
        { status: "fail", logFile: "ci-mirror/attempt1.log" },
        { status: "fail", logFile: "ci-mirror/attempt2.log" },
      ]),
      CI_PR,
    ]),
    shots: { dir: "tray/shots", preludeDir: "tray/prelude-shots" },
    answer(ask) {
      // 真实定案（消息 #49842）：“加缓存和备用源（推荐）：装过一次就缓存，镜像出问题时自动改用官方源，派一个小 Worker 改 CI 配置”
      const pick = ask.options.find((o) => /缓存|备用源|官方源/.test(o));
      return pick ? { text: pick, scripted: true } : answerByRecommendation(ask);
    },
    checks: [
      dispatched(TRAY_SPEC),
      checkedCi(TRAY_SPEC),
      logBeforeAction(TRAY_SPEC),
      blameRight(TRAY_SPEC),
      noMergeWhileRed(TRAY_SPEC),
      askBeforeScope(TRAY_SPEC),
      askedWithCard(TRAY_SPEC),
      cardRecommends(TRAY_SPEC),
    ],
  },
  {
    id: "h2-no-diff",
    title: "H2 习惯：验收只看证据不读代码（任务中途改性格设定）",
    source: "性格设定改动记录 #118（11-11 23:17）；用户 11-12 09:39“在用户改了自己习惯……的时候会不会跟着改编排的流程”",
    baseCommit: TRAY_BASE,
    demand: trayDemand,
    workers: [trayWorker(true)],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([PR_286, trayPr([{ status: "pass" }])]),
    shots: { dir: "tray/shots", preludeDir: "tray/prelude-shots" },
    answer: answerByRecommendation,
    // 托盘 Worker 开工后、汇报之前（设计 3.5 的 T3），经资料页的接口在性格设定里加上 11-11 23:17 真实加的那一条
    injectOnWorkerStart: { worker: "托盘", personaAppend: read("habit/persona-line.md") },
    checks: [dispatched(TRAY_SPEC), personaReachedPm(), noDiffRead(TRAY_SPEC), lookedAtEvidence(TRAY_SPEC)],
  },
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`没有场景 ${id}（有：${SCENARIOS.map((x) => x.id).join("、")}）`);
  return s;
}

export { TRAY_SPEC };
