// Tier 1 deterministic product capability harness runner and real-CLI loopback probe.
// Invariant: costs 0 USD, isolates all CLI configs in scratch directories, and never mutates real user config files.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { osSandboxAvailable } from "../../../src/daemon/driver/write-scope.ts";
import { createLedger } from "../../../src/daemon/ledger/index.ts";
import { isSystemMessageCurrent } from "../../../src/daemon/ledger/notice-currency.ts";
import { formatFleetDigestForPrompt } from "../../../src/daemon/router/prompt.ts";
import { openDatabase } from "../../../src/daemon/store/db.ts";
import { migrate } from "../../../src/daemon/store/migrate.ts";
import { ROUTER_FLEET_DIGEST_MAX_BYTES, utf8Bytes } from "../../../src/shared/index.ts";
import { appendDeliverySuffix } from "../../../src/shared/pm-agenda.ts";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "../../../src/shared/vendors.ts";
import { sandboxAllowsNestedSandbox } from "../../sandbox-probes.ts";
import type { CheckResult } from "../types.ts";
import { extractScaleSafeFacts, listProductEvalScenarios, selectEvalScenarios } from "./catalog.ts";
import { appendBaselineEntry, readBaselineLedger, renderCapabilityReport } from "./ledger.ts";
import {
  PRODUCT_EVAL_HISTORY_MAX_RUNS,
  PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS,
  PRODUCT_EVAL_MAX_ENV_ERROR_RATE,
  PRODUCT_EVAL_MAX_REQUEST_BODY_BYTES,
} from "./limits.ts";
import {
  checkPromptPrefixStability,
  normalizeContextSnapshot,
  startMockModelServer,
} from "./mock-model-server.ts";
import {
  aggregateScenarioTrials,
  computeGraderFingerprint,
  evaluateComparison,
} from "./scoring.ts";
import {
  CAPABILITY_DIMENSIONS,
  type CapabilityScorecard,
  type EvalScenarioSpec,
  type PrefixStabilityReport,
  type TrialOutcome,
  type VendorCoverageRow,
} from "./types.ts";
import {
  buildVendorCoverageMatrix,
  getVendorEvalProfile,
  getVendorEvalProfiles,
  resolveVendorMockEnv,
} from "./vendor-profiles.ts";

export interface ScaleBenchmarkMetrics {
  readonly workerCount: number;
  readonly messageCount: number;
  readonly stepLogCount: number;
  readonly turnCount: number;
  readonly interruptedTurnCount: number;
  readonly routerCommandCount: number;
  readonly malformedMetaCount: number;
  readonly scanDurationMs: number;
  readonly heapDeltaBytes: number;
  readonly truncated: boolean;
}

export interface RealCliProbeOutcome {
  readonly vendor: AgentVendor;
  readonly binaryPath: string | null;
  readonly status: "verified" | "not_verified";
  readonly detail: string;
  readonly resumePrefixStable: boolean | null;
  readonly freshSessionDriftCaught: boolean | null;
  readonly userConfigUntouched: boolean;
  readonly recordedTurns: number;
}

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

interface FileFingerprint {
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs: number | null;
  readonly sha256: string | null;
}

function fingerprintFile(path: string): FileFingerprint {
  if (!existsSync(path)) {
    return { path, exists: false, mtimeMs: null, sha256: null };
  }
  const st = statSync(path);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, exists: true, mtimeMs: st.mtimeMs, sha256: hash };
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
}

function whichBinary(command: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [command], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0]?.trim();
  return first || null;
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

function runRoutingScenario(spec: EvalScenarioSpec, commit: string, graderSha: string): TrialOutcome {
  const digest = formatFleetDigestForPrompt(
    [
      {
        deviceId: "dev-local",
        deviceName: "Local Mac",
        online: true,
        pms: Array.from({ length: 12 }, (_, i) => ({
          pmId: i + 1,
          pmName: `PM ${i + 1}`,
          project: { id: i + 1, name: `project-${i + 1}`, description: `Project description ${i + 1}` },
          activeWorkers: [],
          activeWorkerTotal: 0,
          pendingDecisionCount: i % 2,
        })),
      },
    ],
    [],
  );
  const withinBudget = utf8Bytes(digest) <= ROUTER_FLEET_DIGEST_MAX_BYTES;
  const hasProject = digest.includes("project-1");

  const checks: CheckResult[] = [
    {
      id: "RT1",
      title: "Fleet digest stays within ROUTER_FLEET_DIGEST_MAX_BYTES",
      status: withinBudget ? "pass" : "fail",
      reason: `Rendered ${utf8Bytes(digest)} bytes (limit ${ROUTER_FLEET_DIGEST_MAX_BYTES})`,
      evidence: [],
    },
    {
      id: "RT2",
      title: "Fleet digest preserves active project identifiers for routing",
      status: hasProject ? "pass" : "fail",
      reason: hasProject ? "Project identifiers preserved in digest" : "Missing expected project identifier",
      evidence: [],
    },
  ];
  return makeOutcome(spec, commit, graderSha, checks, true, 1);
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

async function runResidentEfficiencyScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
): Promise<TrialOutcome> {
  const server = await startMockModelServer({
    turns: [{ text: "resident reply 1" }, { text: "resident reply 2" }],
  });
  try {
    const r1 = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-mock",
        instructions: "System rules for PM.",
        prompt_cache_key: "resident-sess-1",
        tools: [{ type: "function", name: "Bash" }],
        input: [{ role: "user", content: "Turn one" }],
      }),
    });
    await r1.text();
    const r2 = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-mock",
        instructions: "System rules for PM.",
        prompt_cache_key: "resident-sess-1",
        tools: [{ type: "function", name: "Bash" }],
        input: [
          { role: "user", content: "Turn one" },
          { role: "assistant", content: "resident reply 1" },
          { role: "user", content: "Turn two" },
        ],
      }),
    });
    await r2.text();

    const recorded = server.requests();
    const stableReport = checkPromptPrefixStability(recorded);
    const mutated = [
      recorded[0]!,
      { ...recorded[1]!, systemText: "System rules for PM. Mutated mid-session." },
    ];
    const brokenReport = checkPromptPrefixStability(mutated);
    const snapshot = normalizeContextSnapshot(
      { ...recorded[0]!, systemText: "Path /Users/alice/repo C:\\Users\\bob\\app 2026-11-28T02:00:00.000Z" },
      { dynamicRoots: ["/private/tmp/work"] },
    );
    const redactedOk =
      !snapshot.includes("/Users/alice") &&
      !snapshot.includes("C:\\Users\\bob") &&
      snapshot.includes("<USER_HOME>") &&
      snapshot.includes("<TIMESTAMP>");

    const checks: CheckResult[] = [
      {
        id: "EF1",
        title: "Resident prompt channel preserves prefix across consecutive turns and catches mutations",
        status: stableReport.stable && !brokenReport.stable && brokenReport.firstDivergenceTurn === 1 ? "pass" : "fail",
        reason: `append-only stable=${stableReport.stable}, mutation caught at turn=${brokenReport.firstDivergenceTurn}`,
        evidence: [],
      },
      {
        id: "EF2",
        title: "Model-visible context snapshot redacts cross-platform paths and timestamps",
        status: redactedOk ? "pass" : "fail",
        reason: redactedOk ? "Normalized snapshot redacted user paths and timestamps" : "Leak detected in snapshot",
        evidence: [],
      },
    ];
    return makeOutcome(spec, commit, graderSha, checks, stableReport.stable, 2);
  } finally {
    await server.close();
  }
}

async function runFirstMessageEfficiencyScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
): Promise<TrialOutcome> {
  const server = await startMockModelServer({
    turns: [{ text: "first_message reply 1" }, { text: "first_message reply 2" }],
  });
  try {
    const r1 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "first-msg-mock",
        messages: [{ role: "user", content: "[SYSTEM]\nInitial request" }],
      }),
    });
    await r1.text();
    const r2 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "first-msg-mock",
        messages: [
          { role: "user", content: "[SYSTEM]\nInitial request" },
          { role: "assistant", content: "first_message reply 1" },
          { role: "user", content: "Follow up\n[PM Agenda Delta]" },
        ],
      }),
    });
    await r2.text();

    const recorded = server.requests();
    const stableReport = checkPromptPrefixStability(recorded);
    const brokenReport = checkPromptPrefixStability([
      recorded[0]!,
      {
        ...recorded[1]!,
        inputMessages: [
          { role: "user", content: "[SYSTEM MUTATED]\nInitial request" },
          ...recorded[1]!.inputMessages.slice(1),
        ],
      },
    ]);
    const passed =
      stableReport.stable &&
      !brokenReport.stable &&
      brokenReport.violations.some((v) => v.kind === "input_prefix_mutated");

    const checks: CheckResult[] = [
      {
        id: "EF3",
        title: "first_message prompt channel preserves message-0 prefix and catches edits",
        status: passed ? "pass" : "fail",
        reason: `append-only stable=${stableReport.stable}, message-0 edit caught=${!brokenReport.stable}`,
        evidence: [],
      },
    ];
    return makeOutcome(spec, commit, graderSha, checks, stableReport.stable, 2);
  } finally {
    await server.close();
  }
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
    const sample = makeOutcome(dummySpec, commit, graderSha, [], true, 1);
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
      CREATE TABLE workers (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, meta TEXT);
      CREATE TABLE session_steps (id INTEGER PRIMARY KEY, kind TEXT);
      CREATE TABLE turns (id INTEGER PRIMARY KEY, outcome TEXT);
      CREATE TABLE router_commands (id INTEGER PRIMARY KEY, status TEXT);
    `);
    db.exec("BEGIN");
    const insW = db.prepare("INSERT INTO workers (status) VALUES (?)");
    for (let i = 0; i < 300; i += 1) insW.run("done");
    const insM = db.prepare("INSERT INTO messages (meta) VALUES (?)");
    for (let i = 0; i < 29_998; i += 1) insM.run('{"ok":true}');
    insM.run("{corrupt");
    insM.run("bad-json");
    const insS = db.prepare("INSERT INTO session_steps (kind) VALUES (?)");
    for (let i = 0; i < 50_000; i += 1) insS.run("turn_started");
    const insT = db.prepare("INSERT INTO turns (outcome) VALUES (?)");
    for (let i = 0; i < 395; i += 1) insT.run("ok");
    for (let i = 0; i < 5; i += 1) insT.run("interrupted");
    const insR = db.prepare("INSERT INTO router_commands (status) VALUES (?)");
    for (let i = 0; i < 150; i += 1) insR.run("done");
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const facts = extractScaleSafeFacts({ dbFile, maxRows: PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS });
  const scanDurationMs = Math.round((performance.now() - t0) * 100) / 100;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  const ledgerFile = join(workDir, "torn-baseline.jsonl");
  const dummyCard: CapabilityScorecard = {
    schemaVersion: 1,
    runId: "20261128-000000",
    baseRef: "main",
    baseCommit: commit,
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
      basePassPowK: 1,
      headPassPowK: 1,
      basePassAtK: 1,
      headPassAtK: 1,
      cacheReadDelta: 0,
      turnDelta: 0,
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
      reason: `Scanned 300 workers / 30,000 messages / 50,000 steps / 400 turns / 150 router commands in ${scanDurationMs} ms`,
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
      scanDurationMs,
      heapDeltaBytes,
    },
  };
}

function writeLaunchConfigFiles(scratchHome: string, configFiles: readonly { readonly relativePath: string; readonly content: string }[]): void {
  for (const file of configFiles) {
    const full = join(scratchHome, file.relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, "utf8");
  }
}

async function runChildAsync(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      stderr += String(err);
      done(1);
    });
    child.once("close", (code) => done(code));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      done(null);
    }, options.timeoutMs);
  });
}

async function probeRealCodexCli(workDir: string): Promise<RealCliProbeOutcome> {
  const binaryPath = whichBinary("codex");
  const realConfig = join(homedir(), ".codex", "config.toml");
  const before = fingerprintFile(realConfig);

  if (!binaryPath) {
    return {
      vendor: "codex",
      binaryPath: null,
      status: "not_verified",
      detail: "codex binary not installed on PATH",
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched: true,
      recordedTurns: 0,
    };
  }

  const scratchHome = join(workDir, "real-codex-home");
  const scratchRepo = join(workDir, "real-codex-repo");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchRepo, { recursive: true });

  const server = await startMockModelServer({
    turns: [{ text: "mock reply 1" }, { text: "mock reply 2" }, { text: "mock reply fresh" }],
  });
  try {
    const launch = resolveVendorMockEnv("codex", server.baseUrl, scratchHome);
    writeLaunchConfigFiles(scratchHome, launch.configFiles);
    const env = { ...process.env, ...launch.env };

    const t1 = await runChildAsync(binaryPath, ["exec", "--skip-git-repo-check", "hello one"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const t2 = await runChildAsync(binaryPath, ["exec", "resume", "--last", "--skip-git-repo-check", "hello two"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const resumeReqs = server.requests();
    const resumeReport: PrefixStabilityReport = checkPromptPrefixStability(resumeReqs);

    const t3 = await runChildAsync(binaryPath, ["exec", "--skip-git-repo-check", "fresh turn"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const allReqs = server.requests();
    const freshCheck =
      resumeReqs.length >= 2 && allReqs.length >= 3
        ? checkPromptPrefixStability([resumeReqs[0]!, allReqs[allReqs.length - 1]!])
        : null;
    const driftCaught =
      freshCheck !== null &&
      !freshCheck.stable &&
      freshCheck.violations.some((v) => v.kind === "cache_key_changed");

    const after = fingerprintFile(realConfig);
    const userConfigUntouched = sameFingerprint(before, after);
    const ok =
      t1.status === 0 &&
      t2.status === 0 &&
      t3.status === 0 &&
      resumeReqs.length >= 2 &&
      resumeReport.stable &&
      driftCaught &&
      userConfigUntouched;

    return {
      vendor: "codex",
      binaryPath,
      status: ok ? "verified" : "not_verified",
      detail: ok
        ? `Real codex 2-turn resume prefix stable=true (${resumeReqs.length} turns); fresh session cache_key_changed caught; real ~/.codex/config.toml untouched`
        : `codex exits=(${String(t1.status)},${String(t2.status)},${String(t3.status)}) reqs=${allReqs.length} resumeStable=${String(resumeReport.stable)} driftCaught=${String(driftCaught)}`,
      resumePrefixStable: resumeReqs.length >= 2 ? resumeReport.stable : null,
      freshSessionDriftCaught: driftCaught,
      userConfigUntouched,
      recordedTurns: allReqs.length,
    };
  } finally {
    await server.close();
  }
}

async function probeRealClaudeCli(workDir: string): Promise<RealCliProbeOutcome> {
  const binaryPath = whichBinary("claude");
  const realConfig = join(homedir(), ".claude.json");
  const before = fingerprintFile(realConfig);

  if (!binaryPath) {
    return {
      vendor: "claude",
      binaryPath: null,
      status: "not_verified",
      detail: "claude binary not installed on PATH",
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched: true,
      recordedTurns: 0,
    };
  }

  const scratchHome = join(workDir, "real-claude-home");
  const scratchRepo = join(workDir, "real-claude-repo");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchRepo, { recursive: true });

  const server = await startMockModelServer({
    turns: [{ text: "claude mock reply 1" }, { text: "claude mock reply 2" }],
  });
  try {
    const launch = resolveVendorMockEnv("claude", server.baseUrl, scratchHome);
    const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const sessionId = "11111111-2222-4333-8444-555555555555";
    const t1 = await runChildAsync(
      binaryPath,
      ["-p", "--output-format", "json", "--session-id", sessionId, "--model", "claude-sonnet-4-5", "hello one"],
      { cwd: scratchRepo, env, timeoutMs: 30_000 },
    );
    const afterT1 = server.requests();
    if (t1.status === 0 && afterT1.length >= 1) {
      const t2 = await runChildAsync(
        binaryPath,
        ["-p", "--output-format", "json", "--resume", sessionId, "--model", "claude-sonnet-4-5", "hello two"],
        { cwd: scratchRepo, env, timeoutMs: 30_000 },
      );
      const allReqs = server.requests();
      const mainReqs = allReqs.filter((r) => r.model.includes("sonnet"));
      const report = mainReqs.length >= 2 ? checkPromptPrefixStability(mainReqs) : null;
      const after = fingerprintFile(realConfig);
      const userConfigUntouched = sameFingerprint(before, after);
      const ok = t2.status === 0 && mainReqs.length >= 2 && (report?.stable ?? false) && userConfigUntouched;
      return {
        vendor: "claude",
        binaryPath,
        status: ok ? "verified" : "not_verified",
        detail: `Real claude 2-turn resume requests=${mainReqs.length} (total=${allReqs.length}), exits=(${String(t1.status)},${String(t2.status)}), prefixStable=${String(report?.stable ?? null)}, real ~/.claude.json untouched=${String(userConfigUntouched)}`,
        resumePrefixStable: report?.stable ?? null,
        freshSessionDriftCaught: null,
        userConfigUntouched,
        recordedTurns: mainReqs.length,
      };
    }

    const after = fingerprintFile(realConfig);
    const userConfigUntouched = sameFingerprint(before, after);
    const reason = (t1.stderr || t1.stdout || `exit ${String(t1.status)}`).trim().split(/\r?\n/)[0] ?? "unknown";
    return {
      vendor: "claude",
      binaryPath,
      status: "not_verified",
      detail: `Isolated HOME loopback probe did not complete (${afterT1.length} requests, exit ${String(t1.status)}): ${reason.slice(0, 160)}`,
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched,
      recordedTurns: afterT1.length,
    };
  } finally {
    await server.close();
  }
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
    const routing = runRoutingScenario(byId.get("route-track-a-mention")!, commit, graderSha);
    const orch = runOrchestrationScenario(byId.get("orch-pm-agenda-stale-notice")!, commit, graderSha, workDir);
    const exec = runExecutionScenario(byId.get("exec-worker-isolation-matrix")!, commit, graderSha, workDir);
    const effRes = await runResidentEfficiencyScenario(byId.get("eff-prefix-stability-resident")!, commit, graderSha);
    const effFirst = await runFirstMessageEfficiencyScenario(
      byId.get("eff-prefix-stability-first-message")!,
      commit,
      graderSha,
    );
    const resFault = await runFaultResilienceScenario(byId.get("res-fault-injection-and-quarantine")!, commit, graderSha);
    const resScale = runScaleResilienceScenario(
      byId.get("res-scale-ledger-and-restart-recovery")!,
      commit,
      graderSha,
      workDir,
    );

    const headTrials: TrialOutcome[] = [
      routing,
      orch,
      exec.outcome,
      effRes,
      effFirst,
      resFault,
      resScale.outcome,
    ];
    const baseTrials: TrialOutcome[] = headTrials.map((t) => ({
      ...t,
      versionLabel: "base",
    }));

    const scorecard = evaluateComparison({
      runId,
      baseRef: branch,
      baseCommit: commit,
      headRef: branch,
      headCommit: commit,
      scenarios,
      baseTrials,
      headTrials,
    });

    if (options.ledgerFile) {
      appendBaselineEntry(options.ledgerFile, {
        schemaVersion: 1,
        recordedAt,
        scorecard,
      });
    }

    const realCliProbes: RealCliProbeOutcome[] = [];
    if (options.probeRealClis !== false) {
      realCliProbes.push(await probeRealCodexCli(workDir));
      realCliProbes.push(await probeRealClaudeCli(workDir));
      for (const vendor of AGENT_VENDORS) {
        if (vendor === "codex" || vendor === "claude") continue;
        const profile = getVendorEvalProfile(vendor);
        const bin = whichBinary(vendorSpec(vendor).cli.command);
        realCliProbes.push({
          vendor,
          binaryPath: bin,
          status: "not_verified",
          detail:
            profile.tier1Coverage === "fake_driver_contract"
              ? `fake_driver_contract (${profile.gapReason ?? "no loopback override"})`
              : bin
                ? "Installed; covered by loopback launch contract (live probe skipped in baseline smoke)"
                : `${vendorSpec(vendor).cli.command} binary not installed on PATH`,
          resumePrefixStable: null,
          freshSessionDriftCaught: null,
          userConfigUntouched: true,
          recordedTurns: 0,
        });
      }
    }

    const durationMs = Math.round(performance.now() - started);
    return {
      runId,
      recordedAt,
      branch,
      commit,
      durationMs,
      scenarios,
      trials: headTrials,
      scorecard,
      vendorMatrix: exec.matrix,
      realCliProbes,
      scaleBenchmark: resScale.benchmark,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function renderTier1BaselineReport(result: Tier1HarnessResult): string {
  const lines: string[] = [
    renderCapabilityReport(result.scorecard, { format: "markdown" }),
    "",
    "## Tier 1 Execution Summary",
    "",
    `- Recorded At: \`${result.recordedAt}\``,
    `- Branch / Commit: \`${result.branch}\` (\`${result.commit}\`)`,
    `- Wall Duration: \`${result.durationMs} ms\` | API Cost: \`$0.00\``,
    `- Tier 1 Scenarios Passed: \`${result.trials.filter((t) => t.checks.every((c) => c.status === "pass")).length}/${result.trials.length}\``,
    "",
    "### Check Details",
    "",
    "| Scenario | Dimension | Check | Status | Reason |",
    "|---|---|---|---|---|",
  ];

  for (const trial of result.trials) {
    for (const check of trial.checks) {
      lines.push(`| ${trial.scenarioId} | ${trial.dimension} | ${check.id} ${check.title} | ${check.status} | ${check.reason} |`);
    }
  }

  lines.push(
    "",
    "## One-Month Ledger Scale Benchmark",
    "",
    `- Seeded Volume: \`${result.scaleBenchmark.workerCount}\` workers, \`${result.scaleBenchmark.messageCount}\` messages (\`${result.scaleBenchmark.malformedMetaCount}\` corrupt meta), \`${result.scaleBenchmark.stepLogCount}\` step logs, \`${result.scaleBenchmark.turnCount}\` turns (\`${result.scaleBenchmark.interruptedTurnCount}\` interrupted), \`${result.scaleBenchmark.routerCommandCount}\` router commands`,
    `- Scan Duration: \`${result.scaleBenchmark.scanDurationMs} ms\` | Heap Delta: \`${(result.scaleBenchmark.heapDeltaBytes / (1024 * 1024)).toFixed(2)} MiB\` | Truncated: \`${String(result.scaleBenchmark.truncated)}\``,
    "",
    "## Cross-Vendor Coverage Matrix",
    "",
    "| Vendor | Tier 1 Coverage | Prompt-Cache Check | Replay Support | Gap / Notes |",
    "|---|---|---|---|---|",
  );

  for (const row of result.vendorMatrix) {
    lines.push(
      `| ${row.vendor} | ${row.tier1Coverage} | ${row.promptCacheCheck} | ${row.replaySupport} | ${row.gapReason ?? "none"} |`,
    );
  }

  if (result.realCliProbes.length > 0) {
    lines.push(
      "",
      "## Real-CLI Loopback Verification",
      "",
      "| Vendor | Binary | Status | Recorded Turns | User Config Untouched | Detail |",
      "|---|---|---|---|---|---|",
    );
    for (const probe of result.realCliProbes) {
      lines.push(
        `| ${probe.vendor} | ${probe.binaryPath ? "installed" : "missing"} | ${probe.status} | ${probe.recordedTurns} | ${String(probe.userConfigUntouched)} | ${probe.detail} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
