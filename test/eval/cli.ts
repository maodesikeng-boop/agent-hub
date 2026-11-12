// 编排验证的入口（docs/orchestration-eval-design.md 第 6 节）。用户在自己的终端里一条命令跑完：
//   pnpm eval compare --base 9b87864^1 --head main
// 1. 准备隔离环境：导出两个版本的源码、生成真模型项目经理的 macOS 沙箱规则，并在真沙箱里逐条自检，再运行最小 Claude 工具轮次；
// 2. 用 vitest（vitest.eval.config.ts，不进 pnpm test、不进 CI）跑 场景 × 版本 的每次试跑：真 claude 当项目经理，Worker 回放；
// 3. 在终端打印对照表（每个场景每条检查过 / 不过，附原因和证据），同时写 summary.md、summary.json。
// 只需要 macOS（沙箱）和本机已登录的 claude；不依赖项目经理会话里的任何东西。
//   pnpm eval preflight          只做第 1 步的隔离自检
//   pnpm eval compare --help     参数说明
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { boundedText, killGroup, markActive, onExit } from "./lifecycle.ts";
import { parseArgs } from "node:util";
import { type PmSandboxInput, pmSandboxInput, pmSandboxProfile, preflight, probeClaudeShimPath, scrubProcessEnv, SANDBOX_EXEC, whichFirst } from "./isolation.ts";
import { EVAL_DEFAULT_PARALLEL, EVAL_MAX_PARALLEL } from "./limits.ts";
import { pruneFailedWork, pruneRuns, renderSummary, runIdOf, type Summary, type VersionInfo } from "./report.ts";
import { SCENARIOS, scenarioById } from "./scenarios.ts";
import type { SelfTestKind } from "./selftest-scripts.ts";
import type { ScenarioId, TrialResult } from "./types.ts";
import { prepareVersion, pruneVersions } from "./versions.ts";

export interface PlanFile {
  runDir: string;
  workRoot: string;
  sourceRepo: string;
  keepWork: boolean;
  /** real：真 claude；scripted：剧本项目经理（自测用，selftest-scripts.ts 的那一种），主文件夹用合成的小仓库。 */
  pm: { mode: "real"; realClaude: string; model: string | null; effort: string | null; sandbox: { exec: string; profile: string; input?: PmSandboxInput } | null } | { mode: "scripted"; kind: SelfTestKind };
  trials: Array<{ scenario: ScenarioId; version: { label: string; commit: string; daemonMain: string }; resultDir: string }>;
}

/** 隔离自检里让真 claude 跑一条命令用的模型：最小的，约 1 美分。 */
const PROBE_MODEL = "claude-haiku-5-5";
const SOURCE_REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const HELP = `用法：
  pnpm eval compare --base <git 引用> --head <git 引用> [选项]
  pnpm eval preflight

选项：
  --scenario <id>     只跑这几个场景（可写多次；默认全部：${SCENARIOS.map((s) => s.id).join("、")}）
  --parallel <n>      同时跑几个试跑（默认 ${EVAL_DEFAULT_PARALLEL}，最多 ${EVAL_MAX_PARALLEL}；写 1 就是一个接一个）
  --model <名字>      项目经理用的模型（默认不指定，用 claude 的默认）
  --effort <档位>     项目经理的思考档位（默认 xhigh，和现在的项目经理一样）
  --root <目录>       评测目录（默认 ~/.agent-hub-eval）
  --keep-work         通过的试跑也留现场
  --scripted <种类>   不用真模型，用剧本项目经理（positive / negative / nothing）把整条路跑一遍：评测自己的自测，不花钱

结果：<评测目录>/runs/<时间>/summary.md、summary.json，每次试跑的完整过程在同目录的 <场景>-<版本>/ 下。`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 先记下用户 shell 里的原样环境（沙箱要知道真数据目录、真端口、真 claude 在哪），再清掉连真后台、真 GitHub 的变量
  const originalEnv = { ...process.env };
  scrubProcessEnv();
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      scenario: { type: "string", multiple: true },
      parallel: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      root: { type: "string" },
      "keep-work": { type: "boolean" },
      scripted: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || (command !== "compare" && command !== "preflight")) {
    process.stdout.write(`${HELP}\n`);
    process.exit(values.help ? 0 : 1);
  }
  const scripted = values.scripted as SelfTestKind | undefined;
  if (scripted !== undefined && !["positive", "negative", "nothing"].includes(scripted)) fail(`--scripted 只能是 positive、negative、nothing`);
  if (scripted === undefined && process.platform !== "darwin") fail("评测要在 macOS 上跑：真模型项目经理要包进 macOS 沙箱（sandbox-exec）。");
  const root = values.root ?? join(homedir(), ".agent-hub-eval");
  const workRoot = join(root, "w");
  const versionsDir = join(root, "v");
  const runsDir = join(root, "runs");
  const startedAt = new Date();
  const runId = runIdOf(startedAt) + "-" + String(startedAt.getMilliseconds()).padStart(3, "0") + "-" + randomBytes(3).toString("hex");
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const release = markActive(runDir);
  onExit(release);
  mkdirSync(workRoot, { recursive: true });
  const log = (line: string) => process.stdout.write(`${line}\n`);

  // ---- 隔离自检（剧本项目经理不跑真 claude，不用沙箱）----
  let pm: PlanFile["pm"];
  if (scripted !== undefined) {
    pm = { mode: "scripted", kind: scripted };
    log(`剧本项目经理（${scripted}）：不跑真模型，不包沙箱，只验证评测这条路。`);
  } else {
    const realClaude = originalEnv.AGENT_HUB_CLAUDE || whichFirst("claude", originalEnv.PATH);
    if (!realClaude) fail("找不到 claude：先装好并登录 Claude Code。");
    const input = pmSandboxInput(SOURCE_REPO, originalEnv);
    const probeDir = join(runDir, "probe");
    mkdirSync(probeDir, { recursive: true });
    input.writableDirs = [probeDir];
    input.projectDirs = [probeDir];
    const profile = join(runDir, "pm-sandbox.sb");
    writeFileSync(profile, pmSandboxProfile(input));
    log(`隔离自检（真沙箱里逐条试）：`);
    const check = preflight(profile, input, { probeDir: probeDir, evalPid: process.pid, realClaude });
    for (const line of check.lines) log(`  ${line}`);
    if (!check.ok) fail("隔离自检没通过，不跑评测。规则文件：" + profile);
    const probe = await probeClaudeShimPath(profile, { realClaude, dir: join(runDir, "probe"), model: PROBE_MODEL });
    log(`  ${probe.line}`);
    if (!probe.ok) fail("真 claude 的 Bash 里 gh 不是替身：替身会被绕过，不跑评测。");
    pm = { mode: "real", realClaude, model: values.model ?? null, effort: values.effort ?? "xhigh", sandbox: { exec: SANDBOX_EXEC, profile, input } };
  }
  if (command === "preflight") {
    release();
    pruneRuns(runsDir);
    return;
  }

  if (!values.base || !values.head) fail(`compare 要给 --base 和 --head。\n\n${HELP}`);
  const parallel = Math.min(EVAL_MAX_PARALLEL, Math.max(1, Number(values.parallel ?? EVAL_DEFAULT_PARALLEL) || EVAL_DEFAULT_PARALLEL));
  const scenarios = (values.scenario ?? SCENARIOS.map((s) => s.id)).map((id) => scenarioById(id));

  // ---- 清旧结果、准备两个版本 ----
  for (const p of [...pruneRuns(runsDir), ...pruneFailedWork(workRoot)]) log(`清掉过期的：${p}`);
  const versions = [prepareVersion(SOURCE_REPO, versionsDir, "base", values.base, log), prepareVersion(SOURCE_REPO, versionsDir, "head", values.head, log)];
  pruneVersions(versionsDir, versions.map((v) => v.dir));

  const plan: PlanFile = {
    runDir,
    workRoot,
    sourceRepo: SOURCE_REPO,
    keepWork: values["keep-work"] === true,
    pm,
    trials: versions.flatMap((v) => scenarios.map((s) => ({ scenario: s.id, version: { label: v.label, commit: v.commit, daemonMain: v.daemonMain }, resultDir: join(runDir, `${s.id}-${v.label}`) }))),
  };
  const planFile = join(runDir, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const waves = Math.ceil(plan.trials.length / parallel);
  log(
    scripted === undefined
      ? `\n开跑：${scenarios.length} 个场景 × 2 个版本 = ${plan.trials.length} 次试跑，同时 ${parallel} 个，预计 ${waves * 8}～${waves * 15} 分钟（每次试跑上限 20 分钟）。`
      : `\n开跑（剧本）：${plan.trials.length} 次试跑，同时 ${parallel} 个，约 1 分钟。`,
  );
  log(`结果目录：${runDir}\n`);

  // ---- 用 vitest 跑 ----
  const vitest = spawn("pnpm", ["exec", "vitest", "run", "--config", join(SOURCE_REPO, "vitest.eval.config.ts")], {
    detached: true,
    cwd: SOURCE_REPO,
    stdio: "inherit",
    env: { ...process.env, EVAL_PLAN: planFile, EVAL_PARALLEL: String(parallel) },
  });

  const unregisterVitest = onExit(() => { if (vitest.pid) killGroup(vitest.pid, "SIGTERM"); });
  const vitestStatus = await new Promise<number | null>((resolve, reject) => {
    vitest.once("error", reject);
    vitest.once("exit", resolve);
  });
  unregisterVitest();
  if (vitest.pid) killGroup(vitest.pid);

  for (const p of pruneFailedWork(workRoot)) log(`清掉过期的：${p}`);

  // ---- 对照表 ----
  const trials: TrialResult[] = plan.trials.flatMap((t) => {
    const file = join(t.resultDir, "result.json");
    return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8")) as TrialResult] : [];
  });
  const summary: Summary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    versions: versions.map((v): VersionInfo => ({ label: v.label, ref: v.ref, commit: v.commit, subject: v.subject })),
    scenarios: scenarios.map((s) => ({ id: s.id, title: s.title, source: s.source })),
    trials,
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, "summary.md"), boundedText(renderSummary(summary)));
  log(`\n${renderSummary(summary, { terminal: true })}`);
  log(`对照表：${join(runDir, "summary.md")}\n明细：${join(runDir, "summary.json")}`);
  if (trials.length < plan.trials.length) log(`有 ${plan.trials.length - trials.length} 次试跑没出结果（vitest 退出码 ${vitestStatus}），看上面的输出。`);
  process.exitCode = trials.length === plan.trials.length && trials.every((t) => t.envError === null) ? 0 : 1;
}

await main();
