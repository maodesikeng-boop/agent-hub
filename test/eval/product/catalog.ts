// Unified five-dimension scenario catalog, external holdout loader, and scale-safe ledger fact extractor.
// Invariant: orchestration scenarios derive directly from test/eval/scenarios.ts with no hand-synced duplicate table.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCENARIOS } from "../scenarios.ts";
import {
  PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS,
  PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS,
  PRODUCT_EVAL_MIN_REGRESSION_TRIALS,
} from "./limits.ts";
import {
  CAPABILITY_DIMENSIONS,
  EVAL_SPLITS,
  EVAL_SUITES,
  EVAL_TIERS,
  RELEASE_GATE_LEVELS,
  type CapabilityDimension,
  type EvalDimensionFacts,
  type EvalEntryPoint,
  type EvalScenarioSpec,
  type EvalSelectionFilter,
  type EvalSplit,
  type EvalSuiteKind,
  type EvalTargetRole,
  type EvalTier,
  type ReleaseGateLevel,
  type ScaleSafeFactsInput,
} from "./types.ts";

const VALID_ROLES = new Set<EvalTargetRole>(["router", "pm", "worker", "system"]);
const VALID_ENTRY_POINTS = new Set<EvalEntryPoint>(["web", "feishu", "hub_cli", "mesh", "daemon"]);

const NATIVE_SCENARIOS: readonly EvalScenarioSpec[] = [
  {
    id: "route-track-a-mention",
    title: "Router Track A @target fast-path dispatch and durable receipt",
    dimension: "routing",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "router",
    entryPoints: ["web", "feishu", "mesh", "daemon"],
    minimumTrials: 1,
    triggers: ["src/daemon/router/**", "src/daemon/feishu/**", "src/daemon/mesh/**"],
    checkIds: ["RT1", "RT2"],
  },
  {
    id: "route-track-b-natural-verbatim",
    title: "Router Track B natural-language project selection and --verbatim quote preservation",
    dimension: "routing",
    tier: "replay",
    suite: "regression",
    split: "public",
    gateLevel: "rc_blocking",
    targetRole: "router",
    entryPoints: ["web", "feishu", "daemon"],
    minimumTrials: PRODUCT_EVAL_MIN_REGRESSION_TRIALS,
    triggers: ["src/daemon/router/**", "src/daemon/router/prompt.ts"],
    checkIds: ["RT3", "RT4"],
  },
  {
    id: "orch-pm-agenda-stale-notice",
    title: "PM agenda cursor delta injection and stale system notice filtering",
    dimension: "orchestration",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "pm",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: 1,
    triggers: ["src/daemon/ledger/pm-delivery.ts", "src/daemon/ledger/pm-agenda.ts", "src/daemon/ledger/notice-currency.ts"],
    checkIds: ["OR1", "OR2"],
  },
  {
    id: "exec-worker-isolation-matrix",
    title: "Worker cross-vendor profile coverage, isolated mock env, and write-scope contract",
    dimension: "execution",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "worker",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: 1,
    triggers: ["src/vendors/**", "src/daemon/driver/write-scope.ts", "src/daemon/ledger/workers/**"],
    checkIds: ["EX1", "EX2"],
  },
  {
    id: "exec-worker-handover-continuity",
    title: "Worker handover brief continuity across multi-turn execution",
    dimension: "execution",
    tier: "replay",
    suite: "capability",
    split: "public",
    gateLevel: "advisory",
    targetRole: "worker",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS,
    triggers: ["src/daemon/ledger/handover*", "src/daemon/prompt.ts"],
    checkIds: ["EX3"],
  },
  {
    id: "eff-prefix-stability-resident",
    title: "Prompt-cache prefix stability across consecutive turns on resident prompt channel",
    dimension: "efficiency",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "pm",
    entryPoints: ["daemon"],
    minimumTrials: 1,
    triggers: ["src/daemon/prompt.ts", "src/daemon/driver/**", "src/daemon/ledger/pm-delivery.ts", "src/vendors/**"],
    checkIds: ["EF1", "EF2"],
  },
  {
    id: "eff-prefix-stability-first-message",
    title: "Prompt-cache prefix stability across consecutive turns on first_message prompt channel",
    dimension: "efficiency",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "pm",
    entryPoints: ["daemon"],
    minimumTrials: 1,
    triggers: ["src/daemon/prompt.ts", "src/vendors/_common/acp/**", "src/vendors/cursor/**", "src/vendors/opencode/**", "src/vendors/kimi/**"],
    checkIds: ["EF3"],
  },
  {
    id: "eff-live-cache-read-canary",
    title: "Live multi-turn TokenUsage.cacheRead preservation canary",
    dimension: "efficiency",
    tier: "canary",
    suite: "capability",
    split: "public",
    gateLevel: "advisory",
    targetRole: "pm",
    entryPoints: ["daemon", "web"],
    minimumTrials: PRODUCT_EVAL_DEFAULT_CAPABILITY_TRIALS,
    triggers: ["src/daemon/prompt.ts", "src/vendors/**"],
    checkIds: ["EF4"],
  },
  {
    id: "res-fault-injection-and-quarantine",
    title: "Abnormal vendor HTTP/SSE fault handling and environment-error quarantine",
    dimension: "resilience",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "system",
    entryPoints: ["daemon", "hub_cli"],
    minimumTrials: 1,
    triggers: ["src/daemon/ledger/turns.ts", "src/daemon/ledger/turn-completions.ts", "src/daemon/ledger/task-graphs/slots.ts"],
    checkIds: ["RS1", "RS2"],
  },
  {
    id: "res-scale-ledger-and-restart-recovery",
    title: "One-month ledger scan bounds, pre-0058 compatibility, and torn JSONL recovery",
    dimension: "resilience",
    tier: "harness",
    suite: "regression",
    split: "public",
    gateLevel: "pr_blocking",
    targetRole: "system",
    entryPoints: ["daemon"],
    minimumTrials: 1,
    triggers: ["src/daemon/ledger/**", "test/eval/product/**"],
    checkIds: ["RS3", "RS4"],
  },
];

const BUILTIN_CATALOG: readonly EvalScenarioSpec[] = [
  ...NATIVE_SCENARIOS,
  ...SCENARIOS.map(
    (legacy): EvalScenarioSpec => ({
      id: legacy.id,
      title: legacy.title,
      dimension: "orchestration",
      tier: "replay",
      suite: "regression",
      split: "public",
      gateLevel: "rc_blocking",
      targetRole: "pm",
      entryPoints: ["daemon", "hub_cli"],
      minimumTrials: PRODUCT_EVAL_MIN_REGRESSION_TRIALS,
      triggers: [
        "src/daemon/prompt.ts",
        "src/daemon/ledger/pm-delivery.ts",
        "src/daemon/ledger/task-graphs/**",
        "src/shared/task-graph-skill.ts",
        "src/hub/**",
      ],
      legacyScenarioId: legacy.id,
      checkIds: legacy.checks.map((c) => c.id),
    }),
  ),
];

export function listProductEvalScenarios(): readonly EvalScenarioSpec[] {
  return BUILTIN_CATALOG;
}

function globMatches(pattern: string, target: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedTarget = target.replace(/\\/g, "/");
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalizedTarget);
}

export function selectEvalScenarios(
  filter: EvalSelectionFilter,
  catalog: readonly EvalScenarioSpec[] = BUILTIN_CATALOG,
): EvalScenarioSpec[] {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  if (filter.ids) {
    for (const id of filter.ids) {
      if (!byId.has(id)) {
        throw new Error(`Unknown scenario id: ${id}`);
      }
    }
  }

  const idSet = filter.ids ? new Set(filter.ids) : null;
  const tierSet = filter.tiers ? new Set(filter.tiers) : null;
  const dimSet = filter.dimensions ? new Set(filter.dimensions) : null;
  const suiteSet = filter.suites ? new Set(filter.suites) : null;
  const splitSet = filter.splits ? new Set(filter.splits) : null;
  const gateSet = filter.gateLevels ? new Set(filter.gateLevels) : null;

  return catalog.filter((spec) => {
    if (idSet && !idSet.has(spec.id)) return false;
    if (tierSet && !tierSet.has(spec.tier)) return false;
    if (dimSet && !dimSet.has(spec.dimension)) return false;
    if (suiteSet && !suiteSet.has(spec.suite)) return false;
    if (splitSet && !splitSet.has(spec.split)) return false;
    if (gateSet && !gateSet.has(spec.gateLevel)) return false;
    if (filter.changedPaths && filter.changedPaths.length > 0) {
      const hit = filter.changedPaths.some((changed) => spec.triggers.some((trig) => globMatches(trig, changed)));
      if (!hit) return false;
    }
    return true;
  });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string" && item.trim() !== "");
}

function validateHoldoutSpec(raw: unknown, filePath: string): EvalScenarioSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Malformed holdout scenario in ${filePath}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    throw new Error(`Malformed holdout scenario in ${filePath}: missing string id`);
  }
  if (typeof obj.title !== "string" || obj.title.trim() === "") {
    throw new Error(`Malformed holdout scenario in ${filePath}: missing string title`);
  }
  if (!CAPABILITY_DIMENSIONS.includes(obj.dimension as CapabilityDimension)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid dimension ${String(obj.dimension)}`);
  }
  if (!EVAL_TIERS.includes(obj.tier as EvalTier)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid tier ${String(obj.tier)}`);
  }
  if (!EVAL_SUITES.includes(obj.suite as EvalSuiteKind)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid suite ${String(obj.suite)}`);
  }
  if (!EVAL_SPLITS.includes(obj.split as EvalSplit) || obj.split !== "holdout") {
    throw new Error(`Holdout scenario ${obj.id} in ${filePath} must declare split: "holdout" (got ${String(obj.split)})`);
  }
  if (!RELEASE_GATE_LEVELS.includes(obj.gateLevel as ReleaseGateLevel)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid gateLevel ${String(obj.gateLevel)}`);
  }
  if (!VALID_ROLES.has(obj.targetRole as EvalTargetRole)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid targetRole ${String(obj.targetRole)}`);
  }
  if (!isStringArray(obj.entryPoints) || !obj.entryPoints.every((e) => VALID_ENTRY_POINTS.has(e as EvalEntryPoint))) {
    throw new Error(`Malformed holdout scenario ${obj.id}: invalid entryPoints`);
  }
  if (!Number.isInteger(obj.minimumTrials) || (obj.minimumTrials as number) < 1) {
    throw new Error(`Malformed holdout scenario ${obj.id}: minimumTrials must be a positive integer`);
  }
  if (!isStringArray(obj.triggers) || !isStringArray(obj.checkIds)) {
    throw new Error(`Malformed holdout scenario ${obj.id}: triggers and checkIds must be non-empty string arrays`);
  }
  return {
    id: obj.id,
    title: obj.title,
    dimension: obj.dimension as CapabilityDimension,
    tier: obj.tier as EvalTier,
    suite: obj.suite as EvalSuiteKind,
    split: "holdout",
    gateLevel: obj.gateLevel as ReleaseGateLevel,
    targetRole: obj.targetRole as EvalTargetRole,
    entryPoints: obj.entryPoints as EvalEntryPoint[],
    minimumTrials: obj.minimumTrials as number,
    triggers: obj.triggers,
    ...(typeof obj.legacyScenarioId === "string" ? { legacyScenarioId: obj.legacyScenarioId } : {}),
    checkIds: obj.checkIds,
  };
}

export function loadHoldoutScenarios(holdoutDir: string): EvalScenarioSpec[] {
  if (!existsSync(holdoutDir) || !statSync(holdoutDir).isDirectory()) {
    throw new Error(`Holdout directory does not exist: ${holdoutDir}`);
  }
  const files = readdirSync(holdoutDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const seen = new Set<string>();
  const specs: EvalScenarioSpec[] = [];

  for (const name of files) {
    const full = join(holdoutDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8")) as unknown;
    } catch (err) {
      throw new Error(`Failed to parse holdout JSON ${full}: ${String(err)}`, { cause: err });
    }
    const spec = validateHoldoutSpec(parsed, full);
    if (seen.has(spec.id)) {
      throw new Error(`Duplicate holdout scenario id: ${spec.id}`);
    }
    seen.add(spec.id);
    specs.push(spec);
  }

  return specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function countQuery(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

export function extractScaleSafeFacts(input: ScaleSafeFactsInput): EvalDimensionFacts {
  const maxRows = input.maxRows ?? PRODUCT_EVAL_LEDGER_SCAN_MAX_ROWS;
  const db = new DatabaseSync(input.dbFile);
  try {
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map((r) => r.name));

    const workerCount = tables.has("workers") ? countQuery(db, "SELECT count(*) AS n FROM workers") : 0;
    const messageCount = tables.has("messages") ? countQuery(db, "SELECT count(*) AS n FROM messages") : 0;
    const stepLogCount = tables.has("session_steps") ? countQuery(db, "SELECT count(*) AS n FROM session_steps") : 0;
    const turnCount = tables.has("turns") ? countQuery(db, "SELECT count(*) AS n FROM turns") : 0;

    let interruptedTurnCount = 0;
    if (tables.has("turns") && tableColumns(db, "turns").has("outcome")) {
      interruptedTurnCount = countQuery(db, "SELECT count(*) AS n FROM turns WHERE outcome = 'interrupted'");
    }

    const routerCommandCount = tables.has("router_commands")
      ? countQuery(db, "SELECT count(*) AS n FROM router_commands")
      : 0;

    // Validate meta JSON in SQLite over a bounded slice so 30,000-row scans stay near-zero JS heap.
    let malformedMetaCount = 0;
    if (tables.has("messages") && tableColumns(db, "messages").has("meta")) {
      malformedMetaCount = countQuery(
        db,
        "SELECT count(*) AS n FROM (SELECT meta FROM messages ORDER BY id LIMIT ?) WHERE meta IS NOT NULL AND meta != '' AND json_valid(meta) = 0",
        maxRows,
      );
    }

    const truncated =
      workerCount > maxRows ||
      messageCount > maxRows ||
      stepLogCount > maxRows ||
      turnCount > maxRows ||
      routerCommandCount > maxRows;

    return {
      workerCount,
      messageCount,
      stepLogCount,
      turnCount,
      interruptedTurnCount,
      routerCommandCount,
      malformedMetaCount,
      truncated,
    };
  } finally {
    db.close();
  }
}
