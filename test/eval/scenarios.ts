// 第一版的 3 个场景（docs/orchestration-eval-design.md 第 2 节；用户 11-12 拍板：3 个真实场景、只跑 Claude、只用确定性检查）：
// - S3a 托盘：真实案例 Worker #453（11-11 21:28～22:36，消息 #49295、#49299、#49435，提交 da36ed7，PR 288）；
// - S5a CI 镜像故障：同一个托盘 PR 的 4 路检查在装 bubblewrap、socat 时解析不了 Ubuntu 软件源（11-11 22:42～23:15，
//   消息 #49679、#49726、#49842；run 43040062881 两次的真实失败日志）；
// - H2 验收不读代码：11-11 23:17 真实的那次习惯改动（性格设定改动记录 #118 新加的那一条）。
// 防过度建图的 5 个场景（docs/orchestration-skill-design.md 第 8 节：简单活不建图、一段活只派一个 Worker、复杂活会加载任务图手册）：
// - K1 装命令行工具并接上（复现真实案例：装 CLI 与插件、等浏览器授权、接 Pi 冒烟测试；已脱敏为开源示例工具 pi-bridge）；
// - K2 改本机配置（复现同一个对话里过滤暴露给 Pi 的模型并刷新 hub 列表；PM 自己做完）；
// - K3 合 PR（11-10 17:33:14，消息 #34762，PR 238）；
// - K4 升级本机的命令行工具（11-11 09:46，消息 #40114，Worker 388）；
// - K5 修一个界面 bug（11-12 09:59，消息 #50200，Worker 463，PR 295）。
// 现有三个场景挂上 L1（建了图就要先加载手册），S3a 再挂 T1（不建图）。装软件、改本机配置不能真做：pi-bridge、curl、pi、npm……
// 用命令替身回放输出（replay/*/stubs.json；真实案例中的私有桥接细节与一次性授权参数均已脱敏为公开开源示例）。
// 被测项目经理的性格设定一律是中性的空设定（NEUTRAL_PERSONA）：用户 11-12 说“肯定不能你来跑，你有我们的上下文”，
// 现任项目经理的性格设定里已经写着考点，不能拿来用；用户的习惯只由场景在考的时候注入（H2 用资料页的接口改性格设定）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askBeforeScope,
  checkedThenMerged,
  jobDone,
  loadedBeforeGraph,
  manualLoadsRecorded,
  mergedGreen,
  noDiffBeforeMerge,
  noGraph,
  ranCommands,
  workerCap,
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
import type { AskSeen, CommandStubs, GhAttempt, GhPr, GhReplay, Scenario, ScenarioContext, WorkerReplay } from "./types.ts";

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

const TRAY_CHECKS = [
  dispatched(TRAY_SPEC),
  noReview(TRAY_SPEC),
  noPreGate(TRAY_SPEC),
  smallGraph(TRAY_SPEC),
  quotesKept(TRAY_SPEC),
  noDiffRead(TRAY_SPEC),
  lookedAtEvidence(TRAY_SPEC),
  // 一段活：不建图（docs/orchestration-skill-design.md 第 8.2 节）；建了的话建图前要加载手册
  noGraph(),
  loadedBeforeGraph(),
];

// ---- 防过度建图（K1～K5）----

const stubs = (rel: string) => JSON.parse(read(rel)) as CommandStubs;

/** 当时的主干提交（K1、K2 不改项目文件，评测拿本仓库当主文件夹）。 */
const MAIN_1112 = "a26be7e681dd75756f438eb05c2749525272a971";
const MAIN_1111 = "d7e542e0b1d95a563bae78872b6ce1086f553cdb";
/** PR 238 的 base、Worker #463 的 base_commit。 */
const PR238_BASE = "6aade5cb647e6c534bdb6c655628297b45960994";
const W463_BASE = "03473c6fab1eeb054300b8e4b3a1113c25c8eda5";

/** 用户在审批卡与授权完成后的回复原话（已脱敏为 pi-bridge 示例）。 */
const K1_APPROVE = "批准，按计划装";
const K1_LOGGED_IN = "已登录成功；服务临时用 pi-bridge serve 跑";

const passChecks = (runId: number, firstJob: number) => ({
  runId,
  workflow: "check",
  jobs: JOBS.map((j, i) => ({ ...j, databaseId: firstJob + i })),
  attempts: [{ status: "pass" as const }],
});

const PR_238: GhPr = {
  number: 238,
  title: "docs: rewrite README opening around managing a project in one conversation",
  body: "README 开头改成 Fusa：一个会话管住整个项目；安全说明、Linux 文档同步改名。",
  headRefName: "hub/340-重写-readme-开头-突出-一个会话管住整个项目",
  headRefOid: "227e024da6a4b3bb0ee62aa4165f1202123f8c9e",
  state: "OPEN",
  files: [
    { path: "README.md", additions: 99, deletions: 19 },
    { path: "SECURITY.md", additions: 4, deletions: 4 },
    { path: "docs/linux.md", additions: 2, deletions: 2 },
    { path: "docs/screenshots/readme-home.png", additions: 0, deletions: 0 },
  ],
  checks: passChecks(42850000001, 130100000000),
};

const PR_295: GhPr = {
  number: 295,
  title: "修复果皮轨多步并行链交错排布假连线与全览长边穿卡",
  body: "紧凑果皮轨同链连续排布，并行链在汇合前不再交错；全览长边绕开卡片。",
  headRefName: "hub/463-果皮轨-并行链在汇合前交错排布导致假连线",
  headRefOid: "d67d224774aa971827d5f8452788691f22d4d9a9",
  state: "OPEN",
  files: [
    { path: "docs/ui-standard.md", additions: 6, deletions: 6 },
    { path: "src/web/components/PeelTrack.tsx", additions: 656, deletions: 198 },
    { path: "src/web/task-graph-layout.test.ts", additions: 65, deletions: 0 },
    { path: "src/web/task-graph-layout.ts", additions: 100, deletions: 3 },
    { path: "src/web/task-graph-rail.test.tsx", additions: 278, deletions: 40 },
  ],
  checks: passChecks(43060000001, 130700000000),
};

/** K5 那件事：认 Worker 的关键词、要逐字带的原话、PR 295 改的文件。 */
const UI_BUG_SPEC: TraySpec = {
  keywords: ["果皮轨", "连线", "验证方案", "拍板", "拍版"],
  quotes: ["验证方案不应该直接连接用户拍版"],
  changedFiles: PR_295.files.map((f) => f.path),
  maxNodes: 1,
};

/** K1：批准跑外部安装脚本按当时的定案答；问登录按用户当时的原话答；别的按推荐。 */
function answerInstall(ask: AskSeen): { text: string; scripted: boolean } {
  const all = `${ask.text}\n${ask.options.join("\n")}`;
  if (/登录|授权|链接|sign in/i.test(all)) return { text: K1_LOGGED_IN, scripted: true };
  if (/批准|安装|脚本|install/i.test(all)) return { text: ask.options.find((o) => o.includes("批准")) ?? K1_APPROVE, scripted: true };
  return answerByRecommendation(ask);
}

const K_SCENARIOS: Scenario[] = [
  {
    id: "k1-install",
    title: "K1 装软件并接上（简单活不建图）",
    source: "11-12 10:32～10:43 装 CLI 工具并接入 Pi 的真实反例（当时建了 5 节点、3 道门禁的任务图并拆成 2 个 Worker；软件细节已脱敏为开源示例 pi-bridge）。用户 11-12 10:44“比如一个安装软件，就不需要拆的很复杂”",
    baseCommit: MAIN_1112,
    demand: () => `${read("install/prelude.md")}接一下试试`,
    // 一个 Worker 从安装做到冒烟测试：第一轮交回装好等浏览器授权的汇报，用户授权后被叫醒交回接入与冒烟测试的汇报
    workers: [{ name: "装 pi-bridge 并接 Pi", promptIncludes: ["pi-bridge", "OpenRouter", "openrouter"], reportFile: "install/report-1.md", laterReportFiles: ["install/report-2.md"] }],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([]),
    stubs: stubs("install/stubs.json"),
    answer: answerInstall,
    // 项目经理把授权链接交给用户后（Worker 交回了汇报，或者它自己发起了登录），用户答已授权
    followUp: { text: K1_LOGGED_IN, afterTool: { tool: "pi-bridge", match: "plugin login" } },
    checks: [
      noGraph(),
      workerCap({ max: 1 }),
      jobDone("装上了（派了 Worker 或自己装）", { keywords: ["pi-bridge", "OpenRouter", "openrouter"], commands: [{ tool: "curl", match: "install.sh" }, { tool: "pi-bridge", match: "plugin add" }] }),
      loadedBeforeGraph(),
      manualLoadsRecorded(),
    ],
  },
  {
    id: "k2-local-config",
    title: "K2 改本机配置（自己做，不派 Worker）",
    source: "同一个对话 11-12 10:48 改本机工具配置并刷新 hub 模型列表的真实正例（软件细节已脱敏为 pi-bridge）；当时 PM 自己跑命令做完（53 秒、7 次工具调用）。用户 11-12 10:44“变量很少…步骤大概率会成功，不用创造新的上下文”",
    baseCommit: MAIN_1112,
    demand: () => `${read("local-config/prelude.md")}A. 只给 Pi 显示 coder 分组的模型（pi-bridge filter pi coder），再刷新 hub 的模型列表`,
    workers: [],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([]),
    stubs: stubs("local-config/stubs.json"),
    answer: answerByRecommendation,
    checks: [
      noGraph(),
      // 第 11.1 节定的 A：“只管理”的 PM 直接做，只要不改项目里的文件
      workerCap({ max: 0 }),
      ranCommands([{ tool: "pi-bridge", match: "filter pi coder" }], [{ command: "models", args: { vendor: "pi", refresh: true } }]),
      loadedBeforeGraph(),
      manualLoadsRecorded(),
    ],
  },
  {
    id: "k3-merge",
    title: "K3 合 PR（看检查就合，不读 diff）",
    source: "本项目 PM 11-10 17:33:14，消息 #34762“可以合吧”；当时 11 秒后合并命令已经发出。用户 11-12 10:44“简单的需求也拆得很复杂”",
    baseCommit: PR238_BASE,
    demand: () => `${read("merge/prelude.md")}可以合吧`,
    workers: [],
    fallbackReport: GENERIC_REPORT,
    gh: { repo: REPO, prs: [PR_238], nextPr: 239 },
    answer: answerByRecommendation,
    checks: [noGraph(), workerCap({ max: 0 }), checkedThenMerged(238), mergedGreen(238), noDiffBeforeMerge(238), loadedBeforeGraph(), manualLoadsRecorded()],
  },
  {
    id: "k4-upgrade",
    title: "K4 升级本机的命令行工具（不建图，最多一个 Worker）",
    source: "本项目 PM 11-11 09:46，消息 #40114；当时派了一个不建图、不开 worktree 的 Worker #388（9 分钟、43 次工具调用）。用户 11-12 10:44“什么事情是有必要拆的呢”",
    baseCommit: MAIN_1111,
    demand: () => `${read("upgrade/prelude.md")}更新一下本机的这些agent`,
    workers: [{ name: "升级命令行", promptIncludes: ["升级", "更新", "CLI", "命令行"], reportFile: "upgrade/report-388.md" }],
    fallbackReport: GENERIC_REPORT,
    gh: ghReplay([]),
    stubs: stubs("upgrade/stubs.json"),
    answer: answerByRecommendation,
    checks: [
      noGraph(),
      workerCap({ max: 1 }),
      jobDone("升级了（派了 Worker 或自己升）", { keywords: ["升级", "更新"], commands: [{ tool: "npm", match: "install" }, { tool: "claude", match: "update" }, { tool: "cursor-agent", match: "update" }] }),
      loadedBeforeGraph(),
      manualLoadsRecorded(),
    ],
  },
  {
    id: "k5-ui-bug",
    title: "K5 修一个界面 bug（正好一个 Worker，不建图、不审查）",
    source: "本项目 PM 11-12 09:59，消息 #50200（果皮轨连线画错）；当时派了一个不建图的 Worker #463，提了 PR 295。用户 11-12 10:44“写代码，写方案，需要在一个专属的空间内完成”",
    baseCommit: W463_BASE,
    // 当时还附了一张截图，回放包里不带（判定不看它）
    demand: () => `${read("ui-bug/prelude.md")}这个图是不是还是有问题，验证方案不应该直接连接用户拍版吗，`,
    workers: [{ name: "果皮轨", promptIncludes: [...UI_BUG_SPEC.keywords], reportFile: "ui-bug/report-463.md" }],
    fallbackReport: GENERIC_REPORT,
    gh: { repo: REPO, prs: [PR_295], nextPr: 296 },
    answer: answerByRecommendation,
    checks: [noGraph(), workerCap({ exact: 1 }), noReview(UI_BUG_SPEC), noDiffRead(UI_BUG_SPEC), lookedAtEvidence(UI_BUG_SPEC), loadedBeforeGraph(), manualLoadsRecorded()],
  },
];

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
    shots: { dir: "tray/report-shots", preludeDir: "tray/prelude-shots" },
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
    shots: { dir: "tray/report-shots", preludeDir: "tray/prelude-shots" },
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
      loadedBeforeGraph(),
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
    shots: { dir: "tray/report-shots", preludeDir: "tray/prelude-shots" },
    answer: answerByRecommendation,
    // 托盘 Worker 开工后、汇报之前（设计 3.5 的 T3），经资料页的接口在性格设定里加上 11-11 23:17 真实加的那一条
    injectOnWorkerStart: { worker: "托盘", personaAppend: read("habit/persona-line.md") },
    checks: [dispatched(TRAY_SPEC), personaReachedPm(), noDiffRead(TRAY_SPEC), lookedAtEvidence(TRAY_SPEC), loadedBeforeGraph()],
  },
  ...K_SCENARIOS,
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`没有场景 ${id}（有：${SCENARIOS.map((x) => x.id).join("、")}）`);
  return s;
}

export { TRAY_SPEC, UI_BUG_SPEC };
