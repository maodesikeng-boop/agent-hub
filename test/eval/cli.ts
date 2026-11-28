// Unified entry point for Bellwood product capability evaluation (pnpm eval).
// Subcommands: preflight, harness (Tier 1), compare (Tier 2 paired replay), scorecard (render ledger/scorecard).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type PmSandboxInput,
  buildCompareSandboxInput,
  pmSandboxProfile,
  preflight,
  probeClaudeShimPath,
  SANDBOX_EXEC,
  scrubProcessEnv,
  whichFirst,
} from "./isolation.ts";
import { boundedText, killGroup, markActive, onExit } from "./lifecycle.ts";
import { EVAL_DEFAULT_PARALLEL, EVAL_MAX_PARALLEL } from "./limits.ts";
import { listProductEvalScenarios, loadHoldoutScenarios, selectEvalScenarios } from "./product/catalog.ts";
import { renderTier1BaselineReport, runTier1Harness } from "./product/harness.ts";
import { appendBaselineEntry, readBaselineLedger, renderCapabilityReport } from "./product/ledger.ts";
import { PRODUCT_EVAL_MIN_REGRESSION_TRIALS } from "./product/limits.ts";
import { computeGraderFingerprint, evaluateComparison } from "./product/scoring.ts";
import type { CapabilityScorecard, EvalScenarioSpec, TrialOutcome } from "./product/types.ts";
import { pruneFailedWork, pruneRuns, runIdOf, type Summary, type VersionInfo } from "./report.ts";
import { resolveExecutableScenario, SCENARIOS } from "./scenarios.ts";
import type { SelfTestKind } from "./selftest-scripts.ts";
import type { Scenario, ScenarioId, TrialResult } from "./types.ts";
import { prepareVersion, pruneVersions } from "./versions.ts";

export interface PlanFile {
  runDir: string;
  workRoot: string;
  sourceRepo: string;
  keepWork: boolean;
  holdoutDir?: string;
  holdoutSpecs?: EvalScenarioSpec[];
  pm:
    | {
        mode: "real";
        realClaude: string;
        model: string | null;
        effort: string | null;
        sandbox: { exec: string; profile: string; input?: PmSandboxInput } | null;
      }
    | { mode: "scripted"; kind: SelfTestKind };
  trials: Array<{
    scenario: ScenarioId;
    trialIndex?: number;
    version: { label: string; commit: string; daemonMain: string };
    resultDir: string;
  }>;
}

const PROBE_MODEL = "claude-haiku-5-5";
const SOURCE_REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]+$/, "");
const HELP = `Usage:
  pnpm eval harness [--out <report.md>] [--json <result.json>] [--ledger <baseline.jsonl>] [--no-real-cli]
  pnpm eval compare --base <git-ref> --head <git-ref> [options]
  pnpm eval scorecard --ledger <baseline.jsonl> | --file <scorecard.json> [--format markdown|terminal]
  pnpm eval preflight [--holdout-dir <dir>]

Compare options:
  --scenario <id>      Run only selected scenario IDs (repeatable; default: ${SCENARIOS.map((s) => s.id).join(", ")} + holdout)
  --trials <k>         Trials per scenario per version (default: ${PRODUCT_EVAL_MIN_REGRESSION_TRIALS} for real, 1 for scripted)
  --holdout-dir <dir>  External holdout scenario directory outside the repository (denied inside real PM sandbox)
  --parallel <n>       Concurrent trials (default ${EVAL_DEFAULT_PARALLEL}, max ${EVAL_MAX_PARALLEL})
  --model <name>       Target model override
  --effort <level>     Target effort override (default xhigh)
  --root <dir>         Evaluation workspace root (default ~/.agent-hub-eval)
  --ledger <file>      Append resulting CapabilityScorecard to a JSONL baseline ledger
  --require-gate       Exit non-zero if CapabilityScorecard.releaseGatePass is false (or chain pnpm eval scorecard --file <runDir>/scorecard.json)
  --keep-work          Keep trial workspace directories even when checks pass
  --scripted <kind>    Run scripted PM self-test (positive | negative | nothing) at zero API cost`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function resolveCompareSelection(opts: {
  readonly requestedIds?: readonly string[];
  readonly holdoutDir?: string;
}): {
  readonly holdoutSpecs: EvalScenarioSpec[];
  readonly catalog: EvalScenarioSpec[];
  readonly scenarios: Scenario[];
  readonly evalSpecs: EvalScenarioSpec[];
} {
  const holdoutSpecs = opts.holdoutDir ? loadHoldoutScenarios(opts.holdoutDir) : [];
  const catalog = [...listProductEvalScenarios(), ...holdoutSpecs];
  const selectedIds =
    opts.requestedIds && opts.requestedIds.length > 0
      ? [...opts.requestedIds]
      : [...SCENARIOS.map((s) => s.id), ...holdoutSpecs.map((s) => s.id)];
  const scenarios = selectedIds.map((id) => resolveExecutableScenario(id, holdoutSpecs));
  const evalSpecs = selectEvalScenarios({ ids: scenarios.map((s) => s.id) }, catalog);
  return { holdoutSpecs, catalog, scenarios, evalSpecs };
}

export function buildInterleavedTrials(input: {
  readonly scenarios: readonly Pick<Scenario, "id">[];
  readonly versions: readonly { readonly label: string; readonly commit: string; readonly daemonMain: string }[];
  readonly trialCount: number;
  readonly runDir: string;
}): PlanFile["trials"] {
  return input.scenarios.flatMap((s) =>
    Array.from({ length: input.trialCount }, (_, trialIndex) =>
      input.versions.map((v) => ({
        scenario: s.id,
        trialIndex,
        version: { label: v.label, commit: v.commit, daemonMain: v.daemonMain },
        resultDir: join(input.runDir, `${s.id}-${v.label}-t${trialIndex}`),
      })),
    ).flat(),
  );
}

function toTrialOutcome(
  result: TrialResult,
  spec: EvalScenarioSpec,
  trialIndex: number,
  graderSha256: string,
  model: string,
  effort: string | null,
): TrialOutcome {
  const totalInput = result.metrics.tokens.input + result.metrics.tokens.cacheRead + result.metrics.tokens.cacheWrite;
  const cacheReadRatio = totalInput > 0 ? result.metrics.tokens.cacheRead / totalInput : null;
  return {
    scenarioId: spec.id,
    dimension: spec.dimension,
    suite: spec.suite,
    split: spec.split,
    versionLabel: result.version,
    commit: result.commit,
    vendor: "claude",
    model,
    effort,
    trialIndex,
    envError: result.envError,
    checks: result.checks,
    efficiency: {
      turns: result.metrics.pmTurns,
      toolCalls: result.metrics.toolCalls,
      inputTokens: result.metrics.tokens.input,
      outputTokens: result.metrics.tokens.output,
      cacheReadTokens: result.metrics.tokens.cacheRead,
      cacheWriteTokens: result.metrics.tokens.cacheWrite,
      cacheReadRatio,
      prefixStable: null,
    },
    promptSha256: result.promptSha256,
    graderSha256,
  };
}

async function runHarnessCommand(values: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const outPath = typeof values.out === "string" ? values.out : undefined;
  const jsonPath = typeof values.json === "string" ? values.json : undefined;
  const ledgerFile = typeof values.ledger === "string" ? values.ledger : undefined;
  const probeRealClis = values["no-real-cli"] !== true;

  const result = await runTier1Harness({
    probeRealClis,
    ...(ledgerFile ? { ledgerFile } : {}),
  });
  const report = renderTier1BaselineReport(result);

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, boundedText(report), "utf8");
  }
  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
  }
  process.stdout.write(report);
  process.exitCode = result.scorecard.releaseGatePass ? 0 : 1;
}

function runScorecardCommand(values: Record<string, string | boolean | string[] | undefined>): void {
  const format = values.format === "terminal" ? "terminal" : "markdown";
  const filePath = typeof values.file === "string" ? values.file : undefined;
  const ledgerPath = typeof values.ledger === "string" ? values.ledger : undefined;
  if (!filePath && !ledgerPath) {
    fail("scorecard requires --ledger <baseline.jsonl> or --file <scorecard.json>");
  }

  let scorecard: CapabilityScorecard;
  if (filePath) {
    if (!existsSync(filePath)) fail(`Scorecard file not found: ${filePath}`);
    scorecard = JSON.parse(readFileSync(filePath, "utf8")) as CapabilityScorecard;
  } else {
    const read = readBaselineLedger(ledgerPath!);
    if (read.entries.length === 0) fail(`No baseline entries found in ${ledgerPath}`);
    scorecard = read.entries[read.entries.length - 1]!.scorecard;
  }

  process.stdout.write(`${renderCapabilityReport(scorecard, { format })}\n`);
  process.exitCode = scorecard.releaseGatePass ? 0 : 1;
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  const [command, ...rest] = rawArgs;
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      scenario: { type: "string", multiple: true },
      trials: { type: "string" },
      "holdout-dir": { type: "string" },
      parallel: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      root: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      ledger: { type: "string" },
      file: { type: "string" },
      format: { type: "string" },
      "no-real-cli": { type: "boolean" },
      "require-gate": { type: "boolean" },
      "keep-work": { type: "boolean" },
      scripted: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !command || !["compare", "preflight", "harness", "scorecard"].includes(command)) {
    process.stdout.write(`${HELP}\n`);
    process.exit(values.help ? 0 : 1);
  }

  if (command === "harness") {
    await runHarnessCommand(values);
    return;
  }
  if (command === "scorecard") {
    runScorecardCommand(values);
    return;
  }

  scrubProcessEnv();
  const scripted = values.scripted as SelfTestKind | undefined;
  if (scripted !== undefined && !["positive", "negative", "nothing"].includes(scripted)) {
    fail("--scripted must be one of positive, negative, or nothing");
  }
  if (scripted === undefined && process.platform !== "darwin") {
    fail("Real-model replay compare requires macOS sandbox-exec; use --scripted or `pnpm eval harness` on other platforms.");
  }

  const holdoutDir = typeof values["holdout-dir"] === "string" ? resolve(values["holdout-dir"]) : undefined;
  const root = values.root ?? join(homedir(), ".agent-hub-eval");
  const workRoot = join(root, "w");
  const versionsDir = join(root, "v");
  const runsDir = join(root, "runs");
  const startedAt = new Date();
  const runId = `${runIdOf(startedAt)}-${String(startedAt.getMilliseconds()).padStart(3, "0")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const release = markActive(runDir);
  onExit(release);
  mkdirSync(workRoot, { recursive: true });
  const log = (line: string) => process.stdout.write(`${line}\n`);

  let pm: PlanFile["pm"];
  if (scripted !== undefined) {
    pm = { mode: "scripted", kind: scripted };
    log(`Scripted PM (${scripted}): zero-cost self-test pipeline.`);
  } else {
    const realClaude = originalEnv.AGENT_HUB_CLAUDE || whichFirst("claude", originalEnv.PATH);
    if (!realClaude) fail("claude binary not found; install and sign in before running real-model compare.");
    const input = buildCompareSandboxInput(SOURCE_REPO, originalEnv, {
      runsDir,
      ...(holdoutDir ? { holdoutDir } : {}),
    });
    const probeDir = join(runDir, "probe");
    mkdirSync(probeDir, { recursive: true });
    input.writableDirs = [probeDir];
    input.projectDirs = [probeDir];
    const profile = join(runDir, "pm-sandbox.sb");
    writeFileSync(profile, pmSandboxProfile(input));
    log("Isolation preflight checks:");
    const check = preflight(profile, input, { probeDir, evalPid: process.pid, realClaude });
    for (const line of check.lines) log(`  ${line}`);
    if (!check.ok) fail(`Isolation preflight failed; sandbox profile: ${profile}`);
    const probe = await probeClaudeShimPath(profile, { realClaude, dir: probeDir, model: PROBE_MODEL });
    log(`  ${probe.line}`);
    if (!probe.ok) fail("Real claude Bash did not resolve shimmed gh; aborting.");
    pm = {
      mode: "real",
      realClaude,
      model: values.model ?? null,
      effort: values.effort ?? "xhigh",
      sandbox: { exec: SANDBOX_EXEC, profile, input },
    };
  }

  if (command === "preflight") {
    release();
    pruneRuns(runsDir);
    return;
  }

  if (!values.base || !values.head) fail(`compare requires --base and --head.\n\n${HELP}`);
  const parallel = Math.min(
    EVAL_MAX_PARALLEL,
    Math.max(1, Number(values.parallel ?? EVAL_DEFAULT_PARALLEL) || EVAL_DEFAULT_PARALLEL),
  );
  const trialCount = Math.max(
    1,
    Number(values.trials ?? (scripted !== undefined ? 1 : PRODUCT_EVAL_MIN_REGRESSION_TRIALS)) || 1,
  );
  const { holdoutSpecs, scenarios, evalSpecs } = resolveCompareSelection({
    ...(values.scenario ? { requestedIds: values.scenario } : {}),
    ...(holdoutDir ? { holdoutDir } : {}),
  });
  const specById = new Map(evalSpecs.map((s) => [s.id, s]));
  const graderSha = computeGraderFingerprint(evalSpecs);

  for (const p of [...pruneRuns(runsDir), ...pruneFailedWork(workRoot)]) log(`Pruned expired: ${p}`);
  const versions = [
    prepareVersion(SOURCE_REPO, versionsDir, "base", values.base, log),
    prepareVersion(SOURCE_REPO, versionsDir, "head", values.head, log),
  ];
  pruneVersions(versionsDir, versions.map((v) => v.dir));

  const plan: PlanFile = {
    runDir,
    workRoot,
    sourceRepo: SOURCE_REPO,
    keepWork: values["keep-work"] === true,
    ...(holdoutDir ? { holdoutDir } : {}),
    ...(holdoutSpecs.length > 0 ? { holdoutSpecs } : {}),
    pm,
    trials: buildInterleavedTrials({ scenarios, versions, trialCount, runDir }),
  };
  const planFile = join(runDir, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  log(`Starting ${plan.trials.length} trial(s) (k=${trialCount}, parallel=${parallel}) in ${runDir}`);

  const vitest = spawn("pnpm", ["exec", "vitest", "run", "--config", join(SOURCE_REPO, "vitest.eval.config.ts")], {
    detached: true,
    cwd: SOURCE_REPO,
    stdio: "inherit",
    env: { ...process.env, EVAL_PLAN: planFile, EVAL_PARALLEL: String(parallel) },
  });

  const unregisterVitest = onExit(() => {
    if (vitest.pid) killGroup(vitest.pid, "SIGTERM");
  });
  const vitestStatus = await new Promise<number | null>((resolveExit, reject) => {
    vitest.once("error", reject);
    vitest.once("exit", resolveExit);
  });
  unregisterVitest();
  if (vitest.pid) killGroup(vitest.pid);

  for (const p of pruneFailedWork(workRoot)) log(`Pruned expired: ${p}`);

  const trials: TrialResult[] = [];
  const baseOutcomes: TrialOutcome[] = [];
  const headOutcomes: TrialOutcome[] = [];
  const modelLabel = pm.mode === "real" ? (pm.model ?? "default") : `scripted:${pm.kind}`;
  const effortLabel = pm.mode === "real" ? pm.effort : null;

  for (const planned of plan.trials) {
    const file = join(planned.resultDir, "result.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8")) as TrialResult;
    trials.push(raw);
    const spec = specById.get(planned.scenario);
    if (!spec) continue;
    const outcome = toTrialOutcome(raw, spec, planned.trialIndex ?? 0, graderSha, modelLabel, effortLabel);
    if (planned.version.label === "base") baseOutcomes.push(outcome);
    else headOutcomes.push(outcome);
  }

  const finishedAt = new Date().toISOString();
  const [baseVer, headVer] = versions;
  const scorecard = evaluateComparison({
    runId,
    baseRef: baseVer!.ref,
    baseCommit: baseVer!.commit,
    headRef: headVer!.ref,
    headCommit: headVer!.commit,
    scenarios: evalSpecs,
    baseTrials: baseOutcomes,
    headTrials: headOutcomes,
  });

  const summary: Summary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt,
    versions: versions.map((v): VersionInfo => ({ label: v.label, ref: v.ref, commit: v.commit, subject: v.subject })),
    scenarios: scenarios.map((s) => ({ id: s.id, title: s.title, source: s.source })),
    trials,
  };

  const md = renderCapabilityReport(scorecard, { format: "markdown" });
  const term = renderCapabilityReport(scorecard, { format: "terminal" });
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(runDir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
  writeFileSync(join(runDir, "summary.md"), boundedText(md));
  if (typeof values.ledger === "string") {
    appendBaselineEntry(values.ledger, { schemaVersion: 1, recordedAt: finishedAt, scorecard });
  }

  log(`\n${term}`);
  log(`Scorecard: ${join(runDir, "summary.md")}\nJSON: ${join(runDir, "scorecard.json")}`);
  if (trials.length < plan.trials.length) {
    log(`${plan.trials.length - trials.length} trial(s) produced no result (vitest exit ${String(vitestStatus)}).`);
  }
  const allCompleted = trials.length === plan.trials.length && trials.every((t) => t.envError === null);
  const gateOk = values["require-gate"] === true ? scorecard.releaseGatePass : true;
  process.exitCode = allCompleted && gateOk ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
