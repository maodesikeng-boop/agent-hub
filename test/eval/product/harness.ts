// Tier 1 deterministic product capability harness runner exercising real Bellwood src/ paths at $0 API cost.
// Invariant: isolates all CLI configs in scratch directories and never masks check or real-CLI probe failures.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSessionTokens } from "../../../src/daemon/agent-api/tokens.ts";
import { osSandboxAvailable } from "../../../src/daemon/driver/write-scope.ts";
import { createLedger } from "../../../src/daemon/ledger/index.ts";
import { isSystemMessageCurrent } from "../../../src/daemon/ledger/notice-currency.ts";
import { createRouterDispatcher } from "../../../src/daemon/router/dispatcher.ts";
import { formatFleetDigestForPrompt } from "../../../src/daemon/router/prompt.ts";
import { createRouterSandboxGuard } from "../../../src/daemon/router/sandbox.ts";
import { createRouterTurnPurposes, createRouterTurnRunner } from "../../../src/daemon/router/single-turn.ts";
import { createLocalTargetPort, createRouterTargetRegistry } from "../../../src/daemon/router/target-port.ts";
import { openDatabase } from "../../../src/daemon/store/db.ts";
import { migrate } from "../../../src/daemon/store/migrate.ts";
import {
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  bundledModelCatalog,
  utf8Bytes,
  type Driver,
  type DriverEventListener,
  type DriverSendInput,
  type DriverSendResult,
  type SessionId,
} from "../../../src/shared/index.ts";
import { appendDeliverySuffix } from "../../../src/shared/pm-agenda.ts";
import { AGENT_VENDORS, vendorSpec } from "../../../src/shared/vendors.ts";
import { sandboxAllowsNestedSandbox } from "../../sandbox-probes.ts";
import type { CheckResult } from "../types.ts";
import { extractScaleSafeFacts, listProductEvalScenarios, selectEvalScenarios } from "./catalog.ts";
import { runFirstMessageEfficiencyScenario, runResidentEfficiencyScenario } from "./harness-efficiency.ts";
import { type ScaleBenchmarkMetrics } from "./harness-report.ts";
import { appendBaselineEntry, readBaselineLedger } from "./ledger.ts";
import {
  PRODUCT_EVAL_HISTORY_MAX_RUNS,
  PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS,
  PRODUCT_EVAL_MAX_ENV_ERROR_RATE,
  PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import { startMockModelServer } from "./mock-model-server.ts";
import { probeRealCliMatrix, type RealCliProbeOutcome } from "./real-cli-probes.ts";
import {
  aggregateScenarioTrials,
  computeGraderFingerprint,
  evaluateTier1Scorecard,
} from "./scoring.ts";
import {
  CAPABILITY_DIMENSIONS,
  type CapabilityScorecard,
  type EvalScenarioSpec,
  type TrialOutcome,
  type VendorCoverageRow,
} from "./types.ts";
import {
  buildVendorCoverageMatrix,
  getVendorEvalProfile,
  getVendorEvalProfiles,
  resolveVendorMockEnv,
} from "./vendor-profiles.ts";

export { renderTier1BaselineReport, type ScaleBenchmarkMetrics } from "./harness-report.ts";
export type { RealCliProbeOutcome } from "./real-cli-probes.ts";

const SCALE_BENCHMARK_RUNS = 5;

export interface Tier1HarnessOptions {
  readonly runId?: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly probeRealClis?: boolean;
  readonly ledgerFile?: string;
}

export interface Tier1HarnessResult {
  readonly runId: string;
  readonly recordedAt: string;
  readonly branch: string;
  readonly commit: string;
  readonly durationMs: number;
  readonly scenarios: readonly EvalScenarioSpec[];
  readonly trials: readonly TrialOutcome[];
  readonly scorecard: CapabilityScorecard;
  readonly vendorMatrix: readonly VendorCoverageRow[];
  readonly realCliProbes: readonly RealCliProbeOutcome[];
  readonly scaleBenchmark: ScaleBenchmarkMetrics;
}

function gitMetadata(): { branch: string; commit: string } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return { branch: branch || "HEAD", commit: commit || "unknown" };
  } catch {
    return { branch: "HEAD", commit: "unknown" };
  }
}

function makeOutcome(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha256: string,
  checks: readonly CheckResult[],
  prefixStable: boolean | null,
  turns = 2,
): TrialOutcome {
  return {
    scenarioId: spec.id,
    dimension: spec.dimension,
    suite: spec.suite,
    split: spec.split,
    versionLabel: "head",
    commit,
    vendor: "claude",
    model: "tier1-mock",
    effort: null,
    trialIndex: 0,
    envError: null,
    checks,
    efficiency: {
      turns,
      toolCalls: checks.length,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 80,
      cacheReadRatio: 0.8,
      prefixStable,
    },
    promptSha256: null,
    graderSha256,
  };
}

class ZeroLlmSpyDriver implements Driver {
  started = 0;
  sent = 0;
  private readonly listeners = new Set<DriverEventListener>();
  async start(_sessionId: SessionId): Promise<void> {
    this.started += 1;
  }
  async send(_sessionId: SessionId, _input: DriverSendInput): Promise<DriverSendResult> {
    this.sent += 1;
    return { kind: "written" };
  }
  async interrupt(_sessionId: SessionId): Promise<void> {}
  async end(_sessionId: SessionId): Promise<void> {}
  async shutdown(): Promise<void> {}
  async cleanupStale(): Promise<void> {}
  async queryCommands(): Promise<null> {
    return null;
  }
  onEvent(listener: DriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

async function runRoutingScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): Promise<TrialOutcome> {
  const routeRoot = join(workDir, "route-track-a");
  const dataHome = join(routeRoot, "data");
  const stateDir = join(dataHome, "state");
  const launchDir = join(stateDir, "launch");
  const uploadsDir = join(stateDir, "uploads");
  const proj1Dir = join(routeRoot, "eval-route-proj");
  const proj2Dir = join(routeRoot, "eval-other-proj");
  for (const dir of [stateDir, launchDir, uploadsDir, proj1Dir, proj2Dir]) {
    mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase(join(routeRoot, "router.sqlite"));
  migrate(db);
  const ledger = createLedger(db, {
    pmHomeRoot: join(stateDir, "pm-home"),
    personasDir: join(dataHome, "personas"),
    dataHome,
    uploadsDir,
  });
  const spyDriver = new ZeroLlmSpyDriver();
  const localPort = createLocalTargetPort({
    ledger,
    deviceId: "dev-local",
    deviceName: "EvalHost",
    uploadsDir,
    probeWorkspace: async () => ({ kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false }),
  });
  const dispatcher = createRouterDispatcher({
    ledger,
    runTurn: createRouterTurnRunner({
      ledger,
      driver: spyDriver,
      tokens: createSessionTokens(),
      purposes: createRouterTurnPurposes(),
      stateDir,
      launchDir,
    }),
    sandboxGuard: createRouterSandboxGuard(),
    targetRegistry: createRouterTargetRegistry({ localPort }),
    models: { list: async () => [bundledModelCatalog("claude")] },
    resolveAttachment: () => null,
    agentTimeoutMs: 500,
  });

  try {
    const pm1 = ledger.createPm({ name: "Route PM 1", mode: "manage_only", vendor: "claude", persona: "" });
    ledger.hubCall(pm1.sessionId, "project.create", { folder: proj1Dir, name: "eval-route-proj" });
    const pm2 = ledger.createPm({ name: "Route PM 2", mode: "manage_only", vendor: "claude", persona: "" });
    ledger.hubCall(pm2.sessionId, "project.create", { folder: proj2Dir, name: "eval-other-proj" });

    const verbatimBody = "请检查构建脚本并原样保留 $HOME";
    const cmd1 = await dispatcher.submitCommand({
      clientId: "tier1-track-a-1",
      text: `@eval-route-proj ${verbatimBody}`,
    });
    const cmdDup = await dispatcher.submitCommand({
      clientId: "tier1-track-a-1",
      text: `@eval-route-proj ${verbatimBody}`,
    });

    const pm1UserMsgs = ledger.messagesBefore(pm1.conversation.id, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user");
    const pm2UserMsgs = ledger.messagesBefore(pm2.conversation.id, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "user");

    const receiptRow = db.get<{ status: string; dispatched_json: string | null }>(
      "SELECT status, dispatched_json FROM router_commands WHERE id = ?",
      cmd1.id,
    );
    const parsedDispatched = receiptRow?.dispatched_json
      ? (JSON.parse(receiptRow.dispatched_json) as Array<{ op?: string; pmId?: number; verbatim?: boolean }>)
      : [];

    const digest = formatFleetDigestForPrompt(
      [
        {
          deviceId: "dev-local",
          deviceName: "EvalHost",
          online: true,
          pms: ledger.getRouterDigest().pms.map((p) => ({
            pmId: p.pmId,
            pmName: p.name,
            project: p.project ? { id: p.project.id, name: p.project.name, description: p.project.description } : null,
            activeWorkers: [],
            activeWorkerTotal: 0,
            pendingDecisionCount: 0,
          })),
        },
      ],
      [],
    );
    const digestOk = utf8Bytes(digest) <= ROUTER_FLEET_DIGEST_MAX_BYTES && digest.includes("eval-route-proj");

    const trackAOk =
      cmd1.status === "dispatched" &&
      cmd1.plan?.track === "A" &&
      cmd1.model === null &&
      spyDriver.started === 0 &&
      spyDriver.sent === 0 &&
      pm1UserMsgs.length === 1 &&
      pm1UserMsgs[0]?.text === verbatimBody &&
      pm2UserMsgs.length === 0 &&
      digestOk;

    const durableReceiptOk =
      receiptRow?.status === "dispatched" &&
      parsedDispatched.length === 1 &&
      parsedDispatched[0]?.op === "pm.forward" &&
      parsedDispatched[0]?.pmId === pm1.pm.id &&
      parsedDispatched[0]?.verbatim === true &&
      cmdDup.id === cmd1.id &&
      pm1UserMsgs.length === 1;

    const checks: CheckResult[] = [
      {
        id: "RT1",
        title: "Router Track A resolveAtMention dispatches @target verbatim with 0 LLM calls and bounded fleet digest",
        status: trackAOk ? "pass" : "fail",
        reason: `track=${String(cmd1.plan?.track)}, driverCalls=${spyDriver.started}/${spyDriver.sent}, pm1Msgs=${pm1UserMsgs.length}, digestBytes=${utf8Bytes(digest)}`,
        evidence: [],
      },
      {
        id: "RT2",
        title: "Router persists durable delivery receipt in router_commands and preserves clientId idempotency",
        status: durableReceiptOk ? "pass" : "fail",
        reason: `receiptStatus=${String(receiptRow?.status)}, dispatched=${parsedDispatched.length}, dupIdMatch=${cmdDup.id === cmd1.id}`,
        evidence: [],
      },
    ];
    return makeOutcome(spec, commit, graderSha, checks, true, 1);
  } finally {
    await dispatcher.close();
    ledger.close();
    db.close();
  }
}

function runOrchestrationScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): TrialOutcome {
  const appended = appendDeliverySuffix("Initial user request", "[PM Agenda Delta] step-1 waiting_pm");
  const tailPreserved =
    appended.startsWith("Initial user request") && appended.endsWith("[PM Agenda Delta] step-1 waiting_pm");

  const dbPath = join(workDir, "orch-notice.sqlite");
  const projDir = join(workDir, "orch-proj");
  mkdirSync(projDir, { recursive: true });
  const db = openDatabase(dbPath);
  let staleDropped = false;
  try {
    migrate(db);
    const ledger = createLedger(db, { pmHomeRoot: join(workDir, "pm-home"), dataHome: join(workDir, "data") });
    try {
      const pm = ledger.createPm({ name: "Eval PM", mode: "manage_only", persona: "", folder: projDir });
      const created = ledger.hubCall(pm.sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: "Notice currency check",
          nodes: [{ key: "step-1", title: "Step 1" }],
        }),
      }).data as { graph: { id: number } };
      ledger.hubCall(pm.sessionId, "graph.skip", {
        graphId: created.graph.id,
        nodeKey: "step-1",
        reason: "trigger ready notice",
      });
      const noticeRow = db.get<{ id: number }>(
        `SELECT id FROM messages WHERE conversation_id = ? AND meta ->> '$.subject.kind' = 'graph.ready_to_finish' ORDER BY id DESC LIMIT 1`,
        pm.conversation.id,
      );
      const currentBeforePatch =
        noticeRow !== undefined && isSystemMessageCurrent(db, noticeRow.id, Date.now(), () => false, () => false);
      ledger.hubCall(pm.sessionId, "graph.patch", {
        graphId: created.graph.id,
        specJson: JSON.stringify({ addSteps: [{ key: "step-2", title: "Added step" }] }),
      });
      const currentAfterPatch =
        noticeRow !== undefined && isSystemMessageCurrent(db, noticeRow.id, Date.now(), () => false, () => false);
      staleDropped = currentBeforePatch && !currentAfterPatch;
    } finally {
      ledger.close();
    }
  } finally {
    db.close();
  }

  const checks: CheckResult[] = [
    {
      id: "OR1",
      title: "PM delivery suffix appends at tail to preserve prompt-cache prefix",
      status: tailPreserved ? "pass" : "fail",
      reason: tailPreserved ? "Suffix appended strictly at tail" : "Prefix mutated",
      evidence: [],
    },
    {
      id: "OR2",
      title: "Notice currency filter drops stale graph.ready_to_finish notice after graph.patch",
      status: staleDropped ? "pass" : "fail",
      reason: staleDropped
        ? "Notice current before patch and dropped after adding pending step"
        : "Stale notice was not dropped",
      evidence: [],
    },
  ];
  return makeOutcome(spec, commit, graderSha, checks, true, 1);
}

function runExecutionScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): { outcome: TrialOutcome; matrix: VendorCoverageRow[] } {
  const profiles = getVendorEvalProfiles();
  const matrix = buildVendorCoverageMatrix(profiles);
  const allMatched = AGENT_VENDORS.every(
    (v) => getVendorEvalProfile(v).systemPromptChannel === vendorSpec(v).capabilities.systemPrompt,
  );
  const claudeCfg = resolveVendorMockEnv("claude", "http://127.0.0.1:43123", join(workDir, "claude-home"));
  const codexCfg = resolveVendorMockEnv("codex", "http://127.0.0.1:43123", join(workDir, "codex-home"));
  let rejectedNonLoopback = false;
  try {
    resolveVendorMockEnv("claude", "https://api.example.com", join(workDir, "bad"));
  } catch (err) {
    rejectedNonLoopback = err instanceof RangeError;
  }
  const sandboxState =
    process.platform === "darwin" ? `darwin_nested=${sandboxAllowsNestedSandbox()}` : `os_sandbox=${osSandboxAvailable()}`;

  const checks: CheckResult[] = [
    {
      id: "EX1",
      title: "All 8 registered vendors declare exhaustive profiles matching vendorSpec systemPromptChannel",
      status: matrix.length === AGENT_VENDORS.length && allMatched ? "pass" : "fail",
      reason: `${matrix.length}/${AGENT_VENDORS.length} vendors mapped (${sandboxState})`,
      evidence: [],
    },
    {
      id: "EX2",
      title: "Isolated mock-server launch configs redirect loopback only and reject external hosts",
      status: claudeCfg.supported && codexCfg.supported && rejectedNonLoopback ? "pass" : "fail",
      reason: "Isolated claude/codex loopback launch verified and non-loopback rejected",
      evidence: [],
    },
  ];
  return { outcome: makeOutcome(spec, commit, graderSha, checks, true, 1), matrix };
}

async function runFaultResilienceScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
): Promise<TrialOutcome> {
  const cap = Math.min(2048, PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES);
  const server = await startMockModelServer({
    maxBodyBytes: cap,
    turns: [
      { text: "", fault: { kind: "http_error", statusCode: 429, body: '{"error":"rate_limit"}' } },
      { text: "", fault: { kind: "truncated_sse", body: 'event: message_start\ndata: {"partial":' } },
    ],
  });
  try {
    const oversize = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(cap + 512) }] }),
    });
    const f1 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "a" }] }),
    });
    const f2 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "b" }] }),
    });
    const f2Body = await f2.text();

    const dummySpec: EvalScenarioSpec = { ...spec, minimumTrials: 3 };
    const passingChecks: CheckResult[] = dummySpec.checkIds.map((id) => ({
      id,
      title: id,
      status: "pass",
      reason: "ok",
      evidence: [],
    }));
    const sample = makeOutcome(dummySpec, commit, graderSha, passingChecks, true, 1);
    const noisy = aggregateScenarioTrials(dummySpec, [
      sample,
      sample,
      sample,
      { ...sample, trialIndex: 3, envError: "http_429" },
      { ...sample, trialIndex: 4, envError: "truncated_sse" },
    ]);
    const k1 = aggregateScenarioTrials(dummySpec, [sample]);

    const checks: CheckResult[] = [
      {
        id: "RS1",
        title: "Mock server enforces 413 body cap and injects 429 and truncated SSE faults",
        status: oversize.status === 413 && f1.status === 429 && f2Body.includes("partial") ? "pass" : "fail",
        reason: `oversize=${oversize.status}, fault1=${f1.status}, fault2_truncated=${f2Body.includes("partial")}`,
        evidence: [],
      },
      {
        id: "RS2",
        title: "Scoring quarantines envError above 20% as invalid_run and marks k=1 inconclusive",
        status:
          noisy.status === "invalid_run" &&
          noisy.envErrorRate > PRODUCT_EVAL_MAX_ENV_ERROR_RATE &&
          k1.status === "inconclusive"
            ? "pass"
            : "fail",
        reason: `noisy=${noisy.status} (${(noisy.envErrorRate * 100).toFixed(0)}%), k1=${k1.status}`,
        evidence: [],
      },
    ];
    return makeOutcome(spec, commit, graderSha, checks, true, 2);
  } finally {
    await server.close();
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function runScaleResilienceScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): { outcome: TrialOutcome; benchmark: ScaleBenchmarkMetrics } {
  const dbFile = join(workDir, "one-month-bench.sqlite");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE workers (id INTEGER PRIMARY KEY, status TEXT, title TEXT, task TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, sender TEXT, text TEXT, meta TEXT);
      CREATE TABLE session_steps (id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT, detail TEXT);
      CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id INTEGER, outcome TEXT);
      CREATE TABLE router_commands (id INTEGER PRIMARY KEY, status TEXT, plan_json TEXT, dispatched_json TEXT);
    `);
    db.exec("BEGIN");
    const insW = db.prepare("INSERT INTO workers (status, title, task) VALUES (?, ?, ?)");
    for (let i = 0; i < 300; i += 1) insW.run("done", `Worker #${i + 1}`, "Implement scoped task and run tests");
    const insM = db.prepare("INSERT INTO messages (conversation_id, sender, text, meta) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 29_998; i += 1) insM.run(1, i % 2 === 0 ? "user" : "agent", `Message body ${i}`, '{"ok":true}');
    insM.run(1, "agent", "Corrupt meta 1", "{corrupt");
    insM.run(1, "agent", "Corrupt meta 2", "bad-json");
    const insS = db.prepare("INSERT INTO session_steps (session_id, kind, detail) VALUES (?, ?, ?)");
    for (let i = 0; i < 50_000; i += 1) insS.run(1, "turn_started", '{"step":1}');
    const insT = db.prepare("INSERT INTO turns (session_id, outcome) VALUES (?, ?)");
    for (let i = 0; i < 395; i += 1) insT.run(1, "ok");
    for (let i = 0; i < 5; i += 1) insT.run(1, "interrupted");
    const insR = db.prepare("INSERT INTO router_commands (status, plan_json, dispatched_json) VALUES (?, ?, ?)");
    for (let i = 0; i < 150; i += 1) insR.run("dispatched", '{"track":"A"}', '[{"op":"pm.forward"}]');
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  // Warm-up pass (not reported) followed by SCALE_BENCHMARK_RUNS timed passes per benchmark-checklist.
  extractScaleSafeFacts({ dbFile, maxRows: PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS });
  const durations: number[] = [];
  const heapDeltas: number[] = [];
  let facts = extractScaleSafeFacts({ dbFile, maxRows: PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS });
  for (let i = 0; i < SCALE_BENCHMARK_RUNS; i += 1) {
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    facts = extractScaleSafeFacts({ dbFile, maxRows: PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS });
    durations.push(Math.round((performance.now() - t0) * 100) / 100);
    heapDeltas.push(process.memoryUsage().heapUsed - heapBefore);
  }
  const scanDurationMs = Math.round(medianOf(durations) * 100) / 100;
  const scanMinMs = Math.min(...durations);
  const scanMaxMs = Math.max(...durations);
  const heapDeltaBytes = Math.round(medianOf(heapDeltas));

  const ledgerFile = join(workDir, "torn-baseline.jsonl");
  const dummyCard: CapabilityScorecard = {
    schemaVersion: 1,
    runId: "20261128-000000",
    baseRef: "absolute-gate",
    baseCommit: "tier1",
    headRef: "head",
    headCommit: commit,
    graderSha256Base: graderSha,
    graderSha256Head: graderSha,
    graderMatched: true,
    envErrorRate: 0,
    publicDelta: null,
    holdoutDelta: null,
    overfitGap: null,
    dimensions: CAPABILITY_DIMENSIONS.map((d) => ({
      dimension: d,
      suite: "regression",
      basePassPowK: null,
      headPassPowK: 1,
      basePassAtK: null,
      headPassAtK: 1,
      cacheReadDelta: null,
      turnDelta: null,
      prefixRegressed: false,
      status: "pass",
      reasons: [],
    })),
    scenarioAggregates: [],
    verdict: "pass",
    releaseGatePass: true,
    reasons: [],
  };
  writeFileSync(
    ledgerFile,
    `${JSON.stringify({ recordedAt: "2026-11-27T00:00:00.000Z", scorecard: { ...dummyCard, schemaVersion: undefined } })}\n{"truncated":`,
    "utf8",
  );
  const recovered = readBaselineLedger(ledgerFile);
  appendBaselineEntry(
    ledgerFile,
    { schemaVersion: 1, recordedAt: "2026-11-28T00:00:00.000Z", scorecard: dummyCard },
    PRODUCT_EVAL_HISTORY_MAX_RUNS,
  );
  const afterAppend = readBaselineLedger(ledgerFile);

  const factsOk =
    facts.workerCount === 300 &&
    facts.messageCount === 30_000 &&
    facts.stepLogCount === 50_000 &&
    facts.turnCount === 400 &&
    facts.interruptedTurnCount === 5 &&
    facts.routerCommandCount === 150 &&
    facts.malformedMetaCount === 2 &&
    !facts.truncated;
  const recoveryOk =
    recovered.skippedMalformedLines === 1 &&
    recovered.upgradedLegacyLines === 1 &&
    afterAppend.entries.length === 2 &&
    afterAppend.skippedMalformedLines === 0;

  const checks: CheckResult[] = [
    {
      id: "RS3",
      title: "One-month ledger scan extracts exact bounded facts",
      status: factsOk ? "pass" : "fail",
      reason: `Scanned 300 workers / 30,000 messages / 50,000 steps / 400 turns / 150 router commands in median ${scanDurationMs} ms (${SCALE_BENCHMARK_RUNS} runs, ${scanMinMs}..${scanMaxMs} ms)`,
      evidence: [],
    },
    {
      id: "RS4",
      title: "JSONL baseline ledger recovers from torn EOF and upgrades v0 entries",
      status: recoveryOk ? "pass" : "fail",
      reason: `skippedMalformed=${recovered.skippedMalformedLines}, upgradedLegacy=${recovered.upgradedLegacyLines}, postAppend=${afterAppend.entries.length}`,
      evidence: [],
    },
  ];

  return {
    outcome: makeOutcome(spec, commit, graderSha, checks, true, 1),
    benchmark: {
      ...facts,
      runs: SCALE_BENCHMARK_RUNS,
      scanDurationMs,
      scanMinMs,
      scanMaxMs,
      heapDeltaBytes,
    },
  };
}

export async function runTier1Harness(options: Tier1HarnessOptions = {}): Promise<Tier1HarnessResult> {
  const started = performance.now();
  const recordedAt = new Date().toISOString();
  const git = gitMetadata();
  const branch = options.branch ?? git.branch;
  const commit = options.commit ?? git.commit;
  const runId = options.runId ?? recordedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

  const scenarios = selectEvalScenarios({ tiers: ["harness"] }, listProductEvalScenarios());
  const graderSha = computeGraderFingerprint(scenarios);
  const workDir = mkdtempSync(join(tmpdir(), "bellwood-tier1-harness-"));

  try {
    const byId = new Map(scenarios.map((s) => [s.id, s]));
    const routing = await runRoutingScenario(byId.get("route-track-a-mention")!, commit, graderSha, workDir);
    const orch = runOrchestrationScenario(byId.get("orch-pm-agenda-stale-notice")!, commit, graderSha, workDir);
    const exec = runExecutionScenario(byId.get("exec-worker-isolation-matrix")!, commit, graderSha, workDir);
    const effRes = await runResidentEfficiencyScenario(
      byId.get("eff-prefix-stability-resident")!,
      commit,
      graderSha,
      workDir,
    );
    const effFirst = await runFirstMessageEfficiencyScenario(
      byId.get("eff-prefix-stability-first-message")!,
      commit,
      graderSha,
      workDir,
    );
    const resFault = await runFaultResilienceScenario(byId.get("res-fault-injection-and-quarantine")!, commit, graderSha);
    const resScale = runScaleResilienceScenario(
      byId.get("res-scale-ledger-and-restart-recovery")!,
      commit,
      graderSha,
      workDir,
    );

    const trials: TrialOutcome[] = [
      routing,
      orch,
      exec.outcome,
      effRes,
      effFirst,
      resFault,
      resScale.outcome,
    ];

    const realCliProbes: RealCliProbeOutcome[] =
      options.probeRealClis === false ? [] : await probeRealCliMatrix(workDir);

    const scorecard = evaluateTier1Scorecard({
      runId,
      ref: branch,
      commit,
      scenarios,
      trials,
      realCliProbes,
    });

    if (options.ledgerFile) {
      appendBaselineEntry(options.ledgerFile, {
        schemaVersion: 1,
        recordedAt,
        scorecard,
      });
    }

    const durationMs = Math.round(performance.now() - started);
    return {
      runId,
      recordedAt,
      branch,
      commit,
      durationMs,
      scenarios,
      trials,
      scorecard,
      vendorMatrix: exec.matrix,
      realCliProbes,
      scaleBenchmark: resScale.benchmark,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
