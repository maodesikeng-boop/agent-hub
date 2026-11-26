// Orchestrates one tester run: guards, preflight, flows grouped by local CLI mode, verdicts, history, summary.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_PATHS, ENV_HOME, VENDOR_LIST, type FeishuStatusView } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { assertNotProduction, BenchConfigError, openBench, parseBenchConfig, type Bench, type BenchConfig } from "./bench.ts";
import { createFeishuDriver, type FeishuDriver } from "./feishu-driver.ts";
import { FLOWS, RUNNERS, selectFlows } from "./flows.ts";
import { appendRun, HISTORY_FILE, LATEST_DIR, newRunId, pruneEvidence, readRuns } from "./history.ts";
import { TESTER_EVIDENCE_KEEP_RUNS, TESTER_HISTORY_MAX_RUNS, TESTER_NIGHTLY_BUDGET_MS, TESTER_POLL_MS } from "./limits.ts";
import { benchLayout } from "./local-instance.ts";
import { configuredCapabilities, driverSecretsFile, preflight } from "./preflight.ts";
import { renderSummary, summarize, type RunSummary } from "./report.ts";
import type { BenchCapability, Cadence, ExternalError, FlowObservation, FlowResult, FlowRunner, FlowSpec, InstanceRole, PreflightResult, RunRecord } from "./types.ts";
import { alertsFor, classifyFlow, gateFlow } from "./verdict.ts";
import { probeVendor } from "./vendors.ts";

export interface RunOptions {
  cadence: Cadence;
  benchConfigPath: string;
  /** Checkout the local test computer runs; the remote is deployed to the same commit for pr and rc runs. */
  codeDir: string;
  flowIds?: readonly string[];
  changedPaths?: readonly string[];
  /** Test seams; production runs use the real bench and Feishu driver. */
  open?: typeof openBench;
  driver?: (config: BenchConfig, bench: Bench) => Promise<FeishuDriver | null>;
  catalog?: readonly FlowSpec[];
  runners?: Readonly<Record<string, FlowRunner>>;
  now?: () => Date;
}

export function loadBenchConfig(file: string): BenchConfig {
  if (!existsSync(file)) throw new BenchConfigError(`no bench config at ${file}; see .agents/skills/tester/references/bench-setup.md`);
  return parseBenchConfig(JSON.parse(readFileSync(file, "utf8")));
}

/** Flows whose model is fake need the local computer in fake mode; the others need real CLIs. */
export const modeOf = (spec: FlowSpec): "real" | "fake" => (spec.boundaries.model === "fake" ? "fake" : "real");

/** One entry per run of a flow: once, or once per computer for a perInstance flow. Remote runs are kept even without a remote. */
export function expand(selection: readonly FlowSpec[]): Array<{ spec: FlowSpec; instance: InstanceRole; id: string }> {
  return selection.flatMap((spec) => (spec.perInstance ? (["local", "remote"] as const).map((instance) => ({ spec, instance, id: `${spec.id}@${instance}` })) : [{ spec, instance: "local" as const, id: spec.id }]));
}

async function localRouterChatIds(bench: Bench, appId: string): Promise<string[]> {
  try {
    const view = await bench.local().api.json<FeishuStatusView>("GET", API_PATHS.feishu);
    return view.appId === appId ? view.chats.filter((c) => c.target.kind === "router").map((c) => c.chatId) : [];
  } catch {
    return [];
  }
}

function routerChatLookup(bench: Bench, appId: string): () => Promise<string[]> {
  let cached: { ids: Promise<string[]>; expiresAt: number } | undefined;
  const remote = async () => {
    const chats = bench.hasRemote() ? bench.remote().routerChats : undefined;
    const text = await chats?.().catch(() => "") ?? "";
    return text.split("\n").flatMap((row) => {
      const [tag, bot, chat] = row.split(" ");
      return tag === "router-chat" && bot === appId && chat && /^oc_[\da-z]+$/i.test(chat) ? [chat] : [];
    });
  };
  return async () => {
    const local = await localRouterChatIds(bench, appId);
    if (local.length > 0) return local;
    if (!cached || Date.now() >= cached.expiresAt) cached = { ids: remote(), expiresAt: Date.now() + TESTER_POLL_MS };
    return cached.ids;
  };
}

export async function defaultDriver(config: BenchConfig, bench: Bench): Promise<FeishuDriver | null> {
  if (config.feishu === undefined || !existsSync(driverSecretsFile(config.root))) return null;
  const local = bench.local().config;
  return createFeishuDriver({
    driverAppId: config.feishu.driverAppId,
    driverSecretsFile: driverSecretsFile(config.root),
    testBotAppId: config.feishu.botAppId,
    botSecretsFile: resolveHubPaths({ [ENV_HOME]: local.dataDir }, local.userHome).feishuSecretsFile,
    routerChatIds: routerChatLookup(bench, config.feishu.botAppId),
  });
}

function emptyPreflight(problem: ExternalError): PreflightResult {
  return {
    available: [],
    problems: [problem],
    coverage: VENDOR_LIST.flatMap(({ id }) => (["local", "remote"] as const).map((instance) => probeVendor(id, { instance, provider: null, unreachable: problem.detail, platform: process.platform }))),
  };
}

type Entry = ReturnType<typeof expand>[number];

async function runOne(bench: Bench, driver: FeishuDriver | null, entry: Entry, runners: Readonly<Record<string, FlowRunner>>, dir: string): Promise<FlowObservation | Error> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error(`timeout after ${entry.spec.timeoutMs / 1000} s`));
    }, entry.spec.timeoutMs);
  });
  const log = (line: string) => writeFileSync(join(dir, "runner.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  try {
    return await Promise.race([runners[entry.spec.id]!({ bench, feishu: driver, evidenceDir: dir, instance: entry.instance, signal: controller.signal, log }), timeout]);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function commitsOf(bench: Bench): Promise<Record<string, string>> {
  const local = bench.local();
  const commits: Record<string, string> = { [local.name]: local.commit() };
  if (bench.hasRemote()) {
    const status = bench.remote().status;
    const text = status ? await status().catch(() => "") : "";
    commits[bench.remote().name] = /^commit (\S+)/m.exec(text)?.[1] ?? "unknown";
  }
  return commits;
}

interface Executed {
  results: FlowResult[];
  preflight: PreflightResult;
  commits: Record<string, string>;
}

async function execute(bench: Bench, config: BenchConfig, options: RunOptions, entries: readonly Entry[], runDir: string): Promise<Executed> {
  const problems: ExternalError[] = [];
  if (options.cadence !== "nightly" && bench.hasRemote()) {
    const deploy = bench.remote().deploy;
    if (deploy) await deploy(bench.local().commit()).catch((error: unknown) => problems.push({ service: "bench", detail: `remote_instance: deploy failed: ${String(error)}` }));
  }
  const driver = await (options.driver ?? defaultDriver)(config, bench).catch((error: unknown) => {
    problems.push({ service: "feishu", detail: `feishu_driver: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  });
  const configured: BenchCapability[] = configuredCapabilities(config);
  const pre = await preflight(bench, driver, configured);
  pre.problems.push(...problems);
  for (const p of problems) pre.available = pre.available.filter((c) => !p.detail.startsWith(`${c}:`));
  const runners = options.runners ?? RUNNERS;
  const budgetEnd = Date.now() + TESTER_NIGHTLY_BUDGET_MS;
  const results: FlowResult[] = [];
  for (const entry of entries) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const gate = gateFlow(entry.spec, entry.instance, pre, configured);
    let verdict = gate;
    let outcome: FlowObservation | Error | null = null;
    const dir = join(runDir, entry.id.replace(/[^\w.@-]/g, "_"));
    if (verdict === null && Date.now() >= budgetEnd) verdict = { verdict: "env_unavailable", reason: `the run budget of ${TESTER_NIGHTLY_BUDGET_MS / 60_000} min ran out before this flow` };
    if (verdict === null) {
      const mode = modeOf(entry.spec);
      if (bench.local().mode !== mode) await bench.local().restart(mode);
      mkdirSync(dir, { recursive: true });
      outcome = await runOne(bench, driver, entry, runners, dir);
      verdict = classifyFlow(entry.spec, entry.instance, outcome, pre, configured);
    }
    const observation = outcome !== null && !(outcome instanceof Error) ? outcome : null;
    results.push({
      id: entry.id,
      verdict: verdict.verdict,
      reason: verdict.reason,
      checks: observation?.checks ?? [],
      externalErrors: observation?.externalErrors ?? [],
      metrics: observation?.metrics ?? {},
      evidence: (observation?.evidence ?? []).map((f) => join(dir, f)),
      startedAt,
      durationMs: Date.now() - started,
    });
  }
  return { results, preflight: pre, commits: await commitsOf(bench) };
}

/**
 * Postcondition: one RunRecord appended to history, its evidence under runs/<runId>/, and summary.md plus summary.json
 * written beside it and copied to runs/latest/. Runs flows one at a time within TESTER_NIGHTLY_BUDGET_MS; a flow past its
 * own timeoutMs is aborted and recorded as product_fail with reason "timeout" unless preflight already explained it.
 * Throws ProductionGuardError before touching any instance when the config fails the production guards.
 */
export async function runTester(options: RunOptions): Promise<{ record: RunRecord; summary: RunSummary }> {
  const config = loadBenchConfig(options.benchConfigPath);
  assertNotProduction(config);
  const catalog = options.catalog ?? FLOWS;
  const selection = selectFlows(catalog, { cadence: options.cadence, ...(options.flowIds ? { ids: options.flowIds } : {}), ...(options.changedPaths ? { changedPaths: options.changedPaths } : {}) }).filter((f) => !f.manual);
  const entries = [...expand(selection.filter((f) => modeOf(f) === "fake")), ...expand(selection.filter((f) => modeOf(f) === "real"))];
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = newRunId(startedAt, options.cadence);
  const runsDir = benchLayout(config.root).runsDir;
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  let executed: Executed;
  let bench: Bench | null = null;
  try {
    bench = await (options.open ?? openBench)(config, { codeDir: options.codeDir, mode: "real" });
    executed = await execute(bench, config, options, entries, runDir);
  } catch (error) {
    if (!(error instanceof BenchConfigError)) throw error;
    const pre = emptyPreflight({ service: "bench", detail: `local_instance: ${error.message}` });
    executed = { preflight: pre, commits: {}, results: entries.map((e) => ({ id: e.id, verdict: "env_unavailable", reason: `bench: ${error.message}`, checks: [], externalErrors: [], metrics: {}, evidence: [], startedAt: startedAt.toISOString(), durationMs: 0 })) };
  } finally {
    await bench?.close();
  }
  const record: RunRecord = { runId, cadence: options.cadence, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), commits: executed.commits, preflight: executed.preflight, results: executed.results };
  const historyFile = join(runsDir, HISTORY_FILE);
  appendRun(historyFile, record);
  const alerts = alertsFor(readRuns(historyFile, TESTER_HISTORY_MAX_RUNS).runs, catalog, options.cadence);
  const summary = summarize(record, alerts, runDir);
  writeFileSync(join(runDir, "summary.md"), renderSummary(summary, record, catalog));
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const latest = join(runsDir, LATEST_DIR);
  rmSync(latest, { recursive: true, force: true });
  mkdirSync(latest, { recursive: true });
  for (const file of ["summary.md", "summary.json"]) cpSync(join(runDir, file), join(latest, file));
  pruneEvidence(runsDir, TESTER_EVIDENCE_KEEP_RUNS);
  return { record, summary };
}
