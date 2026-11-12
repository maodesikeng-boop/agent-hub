// 一次试跑（设计 3.4）：建现场（数据目录、主文件夹克隆、本地裸仓库、替身）→ 起被测版本的守护进程 → 建项目经理、发需求原文 →
// 事件循环（答卡、注入习惯改动、等安静）→ 关守护进程 → 从账本取事实 → 确定性检查 → 写结果；通过的删现场，没通过的留着。
// 真模型和剧本项目经理走同一条路，只差分流脚本的 mode（fakes/claude-router.ts）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isQuotaExhausted, askOf, extractAskCard, type Message, type RateLimitInfo } from "../../src/shared/domain.ts";
import { API_PATHS, type PersonaView } from "../../src/shared/index.ts";
import type { FakeScript, FakeSessionScript, FakeStep } from "../fake-claude/fake-claude.ts";
import { Client, makeEnv, messagesOf, sleep, type RunningDaemon } from "../e2e/harness.ts";
import { removeOwnClaudeProjects, removeOwnVendorRecords } from "../smoke/kit.ts";
import { boundedText, killGroup, markActive, onExit } from "./lifecycle.ts";
import { runChecks } from "./checks.ts";
import { countPmTurns, listWorkers, readFacts, readMetrics } from "./facts.ts";
import type { RouterConfig } from "./fakes/claude-router.ts";
import { type PmSandboxInput, pmSandboxInput, pmSandboxProfile, preflight, FAKE_CLAUDE, ROUTER, isolationEnv, realGitPath, whichFirst, writeShims } from "./isolation.ts";
import { EVAL_EVIDENCE_MAX_CHARS, EVAL_GH_LOG_MAX_BYTES, EVAL_MAX_PM_TURNS, EVAL_TRANSCRIPT_MAX_CHARS } from "./limits.ts";
import { NEUTRAL_PERSONA, REPLAY_DIR } from "./scenarios.ts";
import type { Facts, Scenario, ScenarioContext, TrialResult } from "./types.ts";

export interface TrialTimings {
  trialMs: number;
  pollMs: number;
  quietMs: number;
}

export type PmPlan =
  | { mode: "real"; realClaude: string; model: string | null; effort: string | null; sandbox: { exec: string; profile: string; input?: PmSandboxInput } | null }
  /** 剧本项目经理：按这次试跑的路径拼剧本（自测用）。 */
  | { mode: "scripted"; script: (ctx: ScenarioContext) => FakeScript };

export interface TrialPlan {
  scenario: Scenario;
  version: { label: string; commit: string; daemonMain: string };
  pm: PmPlan;
  /**
   * 主文件夹怎么来：real 是从 sourceRepo 取基准提交（只取这一个提交往前 50 个，没有别的分支，看不到“答案”）；
   * synthetic 是一个只有几个文件的小仓库（CI 的浅克隆里没有基准提交），回放的提交换成空提交。
   */
  project: { kind: "real"; sourceRepo: string } | { kind: "synthetic" };
  /** 现场目录建在哪（ah-eval-* 建在它下面）。 */
  workRoot: string;
  /** 这次试跑的结果目录。 */
  resultDir: string;
  timings: TrialTimings;
  /** 通过了也留现场（调试用）。 */
  keepWork?: boolean;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（截断，原长 ${s.length} 字）` : s);

/** 主文件夹：基准提交的一份克隆（只有 main 一个分支），origin 指向本地裸仓库。 */
function prepareProject(plan: TrialPlan, scenario: Scenario, workDir: string): { repo: string; bare: string } {
  const repo = join(workDir, "repo");
  const bare = join(workDir, "origin.git");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  if (plan.project.kind === "real") {
    git(repo, "fetch", "-q", "--depth=50", plan.project.sourceRepo, scenario.baseCommit);
    git(repo, "checkout", "-q", "-B", "main", "FETCH_HEAD");
  } else {
    writeFileSync(join(repo, "README.md"), "# demo\n");
    writeFileSync(join(repo, "AGENTS.md"), "## 规矩\n- 用中文跟用户交流。\n");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "ui-standard.md"), "# 界面标准\n21. Needs You 托盘最高 50dvh。\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
  }
  execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return { repo, bare };
}

/** 假 Worker 的剧本：按提示词认是哪一类，第一轮交回真实提交和真实汇报，之后每轮回通用汇报。 */
function workerSessions(plan: TrialPlan, scenario: Scenario, ctx: ScenarioContext, gateFile: string): FakeSessionScript[] {
  const generic: FakeScript = { defaultTurn: { steps: [{ text: scenario.fallbackReport }] } };
  const sessions: FakeSessionScript[] = scenario.workers.map((w) => {
    const steps: FakeStep[] = [];
    if (w.gated) steps.push({ waitFile: gateFile });
    if (w.patch) {
      const patch = join(REPLAY_DIR, w.patch.file);
      steps.push({
        bash:
          plan.project.kind === "real"
            ? `GIT_COMMITTER_NAME=${sq(w.patch.committer.name)} GIT_COMMITTER_EMAIL=${sq(w.patch.committer.email)} git am -q --committer-date-is-author-date ${sq(patch)}`
            : `git commit -q --allow-empty -m ${sq(`replay: ${w.name}`)}`,
      });
    }
    const report = w.reportFile ? readFileSync(join(REPLAY_DIR, w.reportFile), "utf8") : (w.reportText ?? scenario.fallbackReport);
    steps.push({ text: report.replaceAll("{SHOTS}", ctx.shotsDir).replaceAll("{PRELUDE_SHOTS}", ctx.preludeShotsDir).trimEnd() });
    return { role: "worker", promptIncludes: w.promptIncludes, script: { turns: [{ steps }], defaultTurn: generic.defaultTurn } };
  });
  return [...sessions, { role: "worker", script: generic }];
}

/** gh 回放：按场景引用的 diffFile 与 logFile 拷进试跑自己的 gh/replay/（真模型沙箱禁读仓库里的 test/eval/replay/）。 */
export function writeGhReplay(ghDir: string, scenario: Scenario): void {
  const replayDir = join(ghDir, "replay");
  mkdirSync(replayDir, { recursive: true });
  const files = new Set<string>();
  for (const pr of scenario.gh.prs) {
    if (pr.diffFile) files.add(pr.diffFile);
    for (const attempt of pr.checks?.attempts ?? []) {
      if (attempt.logFile) files.add(attempt.logFile);
    }
  }
  for (const rel of files) {
    const dst = join(replayDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(REPLAY_DIR, rel), dst);
  }
  writeFileSync(join(ghDir, "replay.json"), JSON.stringify({ ...scenario.gh, baseDir: replayDir, logMaxBytes: EVAL_GH_LOG_MAX_BYTES }));
}

function copyShots(scenario: Scenario, ctx: ScenarioContext): void {
  mkdirSync(ctx.shotsDir, { recursive: true });
  mkdirSync(ctx.preludeShotsDir, { recursive: true });
  if (scenario.shots) {
    cpSync(join(REPLAY_DIR, scenario.shots.dir), ctx.shotsDir, { recursive: true });
    if (scenario.shots.preludeDir) cpSync(join(REPLAY_DIR, scenario.shots.preludeDir), ctx.preludeShotsDir, { recursive: true });
  }
}

export function sessionIsBusy(s: { activity: string; apiRetry?: unknown; rateLimit?: RateLimitInfo | null }): boolean {
  return s.activity !== "idle" || s.apiRetry != null || isQuotaExhausted(s.rateLimit, Date.now());
}

interface LoopOutcome {
  envError: string | null;
}

/** 事件循环（设计 3.3）：答卡、到时机注入习惯改动、等安静；超时、超轮数记环境错误。 */
async function eventLoop(
  plan: TrialPlan,
  client: Client,
  daemon: RunningDaemon,
  pm: { pmId: number; conversationId: number },
  dbFile: string,
  gateFile: string,
  injected: Facts["injected"],
): Promise<LoopOutcome> {
  const { scenario, timings } = plan;
  const deadline = Date.now() + timings.trialMs;
  const answered = new Set<number>();
  let injectedPersona = scenario.injectOnWorkerStart === undefined;
  let lastBusyAt = Date.now();
  let exited = false;
  void daemon.exited.then(() => (exited = true));
  for (;;) {
    if (exited) return { envError: `守护进程中途退出：${daemon.stderr().slice(-500)}` };
    if (Date.now() > deadline) return { envError: `超时（${Math.round(timings.trialMs / 60_000)} 分钟）` };
    const state = await client.state();
    const msgs = messagesOf(state, pm.conversationId);
    // 1. 项目经理挂了卡：用户点（发一条带选项原文的消息，和网页点卡片后一样）
    for (const m of msgs) {
      const ask = askOf(m);
      if (ask === null || ask.answered || answered.has(m.id)) continue;
      answered.add(m.id);
      const options = extractAskCard(m as Message)?.options ?? ask.options ?? [];
      const answer = scenario.answer({ messageId: m.id, text: m.text, options });
      injected.push({ at: Date.now(), kind: "answer", detail: `${answer.scripted ? "" : "（剧本外）"}${answer.text}` });
      await client.post(pm.conversationId, answer.text);
      lastBusyAt = Date.now();
    }
    // 2. 习惯场景：某类 Worker 开工了，先改性格设定（资料页的接口），再放它的汇报
    if (!injectedPersona && scenario.injectOnWorkerStart) {
      const replay = scenario.workers.find((w) => w.name === scenario.injectOnWorkerStart!.worker);
      const started = listWorkers(dbFile, pm.conversationId).find((w) => replay?.promptIncludes.some((k) => `${w.title}\n${w.task}`.includes(k)));
      if (started) {
        const view = (await (await client.get(API_PATHS.persona(pm.pmId))).json()) as PersonaView;
        const before = view.text ?? "";
        const text = `${before.trimEnd()}${before.trim() === "" ? "" : "\n"}${scenario.injectOnWorkerStart.personaAppend.trim()}\n`;
        const res = await client.putJson(API_PATHS.persona(pm.pmId), { text, reason: "评测注入：用户改了习惯" });
        if (res.status !== 200) return { envError: `改性格设定失败：${res.status} ${await res.text()}` };
        injected.push({ at: Date.now(), kind: "persona", detail: scenario.injectOnWorkerStart.personaAppend.trim() });
        injectedPersona = true;
      }
    }
    if (injectedPersona && !existsSync(gateFile)) writeFileSync(gateFile, "go");
    // 3. 忙不忙：有会话在干活（包括后台命令、网络重试和等额度），或者用户的消息还没处理完
    const busy =
      state.sessions.some((s) => sessionIsBusy(s)) ||
      msgs.some((m) => m.sender === "user" && (m.status === "queued" || m.status === "delivered" || m.status === "processing"));
    if (busy) lastBusyAt = Date.now();
    if (countPmTurns(dbFile, pm.conversationId) > EVAL_MAX_PM_TURNS) return { envError: `项目经理出场超过 ${EVAL_MAX_PM_TURNS} 轮` };
    if (!busy && Date.now() - lastBusyAt >= timings.quietMs) return { envError: null };
    await sleep(timings.pollMs);
  }
}

async function stopDaemon(daemon: RunningDaemon): Promise<void> {
  if (daemon.child.pid) killGroup(daemon.child.pid, "SIGTERM");
  const timer = setTimeout(() => { if (daemon.child.pid) killGroup(daemon.child.pid); }, 5_000);
  await daemon.exited;
  clearTimeout(timer);
  if (daemon.child.pid) killGroup(daemon.child.pid);

}

/** 环境出的错（不算项目经理的分，设计 4.4）：真 gh 被调到、那一轮直接失败。 */
function isolationErrors(facts: Facts): string | null {
  const ghCommands = facts.tools.filter((t) => t.name === "Bash" && /(^|[\s;&|(])gh\s/.test(String(t.input.command ?? "")));
  if (ghCommands.length > 0 && facts.gh.length === 0) return `项目经理敲了 ${ghCommands.length} 次 gh，替身一次都没收到：gh 没走替身（PATH 被改了？），这次不算`;
  const failed = facts.messages.find((m) => m.sender === "user" && m.status === "failed");
  return failed ? `用户消息 messages#${failed.id} 处理失败（厂商报错、额度用完之类）：${failed.failureReason ?? "没有原因"}` : null;
}

function transcript(facts: Facts): string {
  const lines = facts.messages.map((m) => {
    const head = `### messages#${m.id} ${new Date(m.at).toISOString()} ${m.sender}/${m.kind}`;
    const body = m.kind === "tool" ? `${String(m.meta?.name ?? "")}: ${JSON.stringify(m.meta?.input ?? {})}` : m.text;
    return `${head}\n${clip(body, EVAL_TRANSCRIPT_MAX_CHARS)}\n`;
  });
  const gh = facts.gh.map((g) => `- gh#${g.seq} ${new Date(g.at).toISOString()} \`gh ${g.argv.join(" ")}\` → ${g.action}（退出码 ${g.exitCode}）`);
  const rec = facts.recorded.map((r) => `- ${new Date(r.at).toISOString()} \`${r.tool} ${r.argv.join(" ")}\`（只记录，没执行）`);
  const inj = facts.injected.map((e) => `- ${new Date(e.at).toISOString()} ${e.kind}：${clip(e.detail, EVAL_EVIDENCE_MAX_CHARS)}`);
  return [`# 试跑过程\n`, `## 评测注入的事件\n${inj.join("\n") || "（无）"}\n`, `## gh 替身记录\n${gh.join("\n") || "（无）"}\n`, `## 只记录的替身（ssh、rsync、git push……）\n${rec.join("\n") || "（无）"}\n`, `## 项目经理对话\n`, ...lines].join("\n");
}

export async function runTrial(plan: TrialPlan): Promise<TrialResult> {
  const { scenario } = plan;
  mkdirSync(plan.workRoot, { recursive: true });
  mkdirSync(plan.resultDir, { recursive: true });
  const env = makeEnv({ root: plan.workRoot, prefix: "ah-eval-", detached: true });
  const workDir = env.dir;
  const release = markActive(workDir);
  const releaseResult = markActive(plan.resultDir);
  const pidFile = join(plan.resultDir, "process-groups");
  const cleanup = (releaseMarkers = false) => {
    if (daemon?.child.pid) killGroup(daemon.child.pid);
    if (existsSync(pidFile)) for (const line of readFileSync(pidFile, "utf8").split("\n")) {
      const pid = Number(line);
      if (Number.isSafeInteger(pid) && pid > 1) killGroup(pid);
    }
    if (releaseMarkers) { release(); releaseResult(); }
  };
  const unregister = onExit(() => cleanup(true));
  const ctx: ScenarioContext = { workDir, shotsDir: join(workDir, "shots"), preludeShotsDir: join(workDir, "prelude-shots") };
  const gateFile = join(workDir, "gate-report");
  const ghDir = join(workDir, "gh");
  const binDir = join(workDir, "bin");
  const recordFile = join(workDir, "recorded.jsonl");
  const dbFile = join(env.home, "state", "hub.sqlite");
  const injected: Facts["injected"] = [];
  let daemon: RunningDaemon | null = null;
  let envError: string | null = null;
  let pmConversationId = 0;
  let startedAt = Date.now();
  try {
    copyShots(scenario, ctx);
    const { repo, bare } = prepareProject(plan, scenario, workDir);
    writeGhReplay(ghDir, scenario);
    writeShims({ binDir, ghDir, recordFile }, { node: process.execPath, realGit: realGitPath() });
    let sandbox = plan.pm.mode === "real" ? plan.pm.sandbox : null;
    if (plan.pm.mode === "real") {
      if (!sandbox) throw new Error("真模型必须使用通过 preflight 的沙箱");
      const input = { ...(sandbox.input ?? pmSandboxInput(new URL("../../", import.meta.url).pathname, process.env)) };
      input.writableDirs = [workDir];
      input.projectDirs = [workDir, repo];
      input.readDenied = [...(input.readDenied ?? []), dirname(dirname(plan.resultDir)), plan.workRoot, join(plan.version.daemonMain, "../../../test/eval/replay")];
      const profile = join(workDir, "pm-sandbox.sb");
      writeFileSync(profile, pmSandboxProfile(input));
      const check = preflight(profile, input, { probeDir: workDir, evalPid: process.pid, realClaude: plan.pm.realClaude });
      if (!check.ok) throw new Error(check.lines.join("\n"));
      sandbox = { ...sandbox, profile };
    }
    const routerConfig: RouterConfig =
      plan.pm.mode === "real"
        ? { mode: "real", node: process.execPath, fakeClaude: FAKE_CLAUDE, realClaude: plan.pm.realClaude, sandbox, settingsDir: join(workDir, "router-settings") }
        : { mode: "scripted", node: process.execPath, fakeClaude: FAKE_CLAUDE, settingsDir: join(workDir, "router-settings") };
    const isoEnv = { EVAL_PROCESS_GROUPS: pidFile, ...isolationEnv({ workDir, binDir, ghDir, recordFile, originBare: bare, repo: scenario.gh.repo, routerConfig, jq: whichFirst("jq") }) };
    const pmSessions: FakeSessionScript[] = plan.pm.mode === "scripted" ? [{ role: "pm", script: plan.pm.script(ctx) }] : [];
    env.setScript({ sessions: [...pmSessions, ...workerSessions(plan, scenario, ctx, gateFile)] });
    daemon = await env.start({ vendorPath: ROUTER, main: plan.version.daemonMain, env: isoEnv });
    const client = await Client.login(daemon);
    const created = await client.createPm({
      name: "评测",
      mode: "manage_only",
      vendor: "claude",
      persona: NEUTRAL_PERSONA,
      folder: repo,
      ...(plan.pm.mode === "real" ? { defaultModel: plan.pm.model, effort: plan.pm.effort } : {}),
    });
    pmConversationId = created.conversationId;
    startedAt = Date.now();
    const demand = scenario.demand(ctx);
    injected.push({ at: startedAt, kind: "demand", detail: demand });
    await client.post(created.conversationId, demand);
    envError = (await eventLoop(plan, client, daemon, created, dbFile, gateFile, injected)).envError;
  } catch (error) {
    envError = `试跑出错：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (daemon) await stopDaemon(daemon);
    cleanup();
  }
  const endedAt = Date.now();
  let result: TrialResult;
  if (pmConversationId === 0 || !existsSync(dbFile)) {
    result = { scenario: scenario.id, version: plan.version.label, commit: plan.version.commit, envError: envError ?? "没建出项目经理", checks: [], metrics: emptyMetrics(), promptSha256: null, resultDir: plan.resultDir, workDir };
  } else {
    const facts = readFacts({ dbFile, pmConversationId, ghCallsFile: join(ghDir, "calls.jsonl"), recordFile, injected, startedAt, endedAt });
    envError ??= isolationErrors(facts);
    const checks = runChecks(scenario.checks, facts);
    const promptSha256 = savePrompt(env.home, facts.pmSessionIds[0], plan.resultDir);
    writeFileSync(join(plan.resultDir, "transcript.md"), boundedText(transcript(facts)));
    result = { scenario: scenario.id, version: plan.version.label, commit: plan.version.commit, envError, checks, metrics: readMetrics(dbFile, facts), promptSha256, resultDir: plan.resultDir, workDir };
  }
  const passed = result.envError === null && result.checks.every((c) => c.status !== "fail");
  const keep = !passed || plan.keepWork === true;
  if (plan.pm.mode === "real" && existsSync(dbFile)) removeOwnVendorRecords(dbFile);
  removeOwnClaudeProjects(workDir);
  await env.cleanup({ keepDir: keep });
  result.workDir = keep ? workDir : null;
  writeFileSync(join(plan.resultDir, "result.json"), JSON.stringify(result, null, 2));
  cleanup(true); unregister();
  return result;
}

/** 项目经理当时拿到的提示词拷进结果目录，返回它的 sha256（对照表每一列对得上是哪份提示词）。 */
function savePrompt(home: string, pmSessionId: number | undefined, resultDir: string): string | null {
  if (pmSessionId === undefined) return null;
  const file = join(home, "state", "launch", String(pmSessionId), "prompt.md");
  if (!existsSync(file)) return null;
  writeFileSync(join(resultDir, "pm-prompt.md"), boundedText(readFileSync(file, "utf8")));
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function emptyMetrics(): TrialResult["metrics"] {
  return { pmTurns: 0, toolCalls: 0, hubCalls: 0, asks: 0, unscriptedAnswers: 0, durationMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
