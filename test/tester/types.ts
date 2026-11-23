// Shared shapes for the tester: flow catalog entries, observations, verdicts, run records, and alerts.
// Invariant: a flow never talks to production data, production bots, or production accounts; bench.ts enforces it before any flow runs.
import type { AgentVendor } from "../../src/shared/vendors.ts";
import type { Bench } from "./bench.ts";
import type { FeishuDriver } from "./feishu-driver.ts";
import type { VendorReadiness } from "./vendors.ts";

export type Cadence = "nightly" | "rc" | "pr";

export type InstanceRole = "local" | "remote";

/** Which external boundaries a flow exercises for real. */
export interface FlowBoundaries {
  feishu: "real" | "none";
  network: "relay" | "loopback";
  model: "real" | "fake";
  devices: 1 | 2;
}

export type BenchCapability =
  | "local_instance"
  | "remote_instance"
  | "remote_control"
  | "feishu_bot"
  | "feishu_driver"
  | `vendor:${AgentVendor}`;

/** How many failures a flow may show before it alerts. */
export type FlowTolerance =
  | { kind: "consecutive"; failures: number }
  | { kind: "rate"; window: number; minPasses: number };

export type FlowArea = "feishu" | "mesh" | "model" | "lifecycle";

export interface FlowSpec {
  /** Stable id such as `feishu.group-round-trip`; history and alerts key on it, so never rename one. */
  id: string;
  area: FlowArea;
  title: string;
  /** What the user does, in one or two plain sentences. */
  story: string;
  boundaries: FlowBoundaries;
  needs: readonly BenchCapability[];
  cadences: readonly Cadence[];
  /** Repository path globs; a PR touching any of them selects this flow for a PR run. */
  triggers: readonly string[];
  /** Pass criteria; each entry names one check the runner reports by the same id. */
  pass: readonly { check: string; rule: string }[];
  /** Files a run saves under the flow's evidence directory. */
  evidence: readonly string[];
  tolerance: FlowTolerance;
  timeoutMs: number;
  /** Escaped bugs this flow guards, as PR references such as `#411`. */
  escapes: readonly string[];
  /** A checklist item a person or the AI tester performs by hand; the script layer only lists it. */
  manual?: true;
  /**
   * Run once on each bench computer; results are keyed `<id>@<role>` so a gap on one computer never hides the other.
   * Each run needs its target computer, and a `vendor:<id>` need is judged on that computer only.
   */
  perInstance?: true;
}

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export type ExternalService = "feishu" | "relay" | "github" | "vendor" | "bench";

/** A failure caused outside Bellwood, such as a Feishu 5xx or an unreachable bench host. */
export interface ExternalError {
  service: ExternalService;
  detail: string;
  status?: number;
}

/** What one flow run saw, before classification. */
export interface FlowObservation {
  checks: CheckResult[];
  externalErrors: ExternalError[];
  /** Set when a vendor reported quota or login trouble instead of an answer. */
  vendorTrouble?: { vendor: AgentVendor; kind: "quota" | "auth"; detail: string };
  metrics: Record<string, number>;
  evidence: string[];
}

export interface FlowContext {
  bench: Bench;
  feishu: FeishuDriver | null;
  /** Directory the runner writes its evidence files into; it exists and is empty. */
  evidenceDir: string;
  /** The computer a perInstance flow targets; `local` for every other flow. */
  instance: InstanceRole;
  signal: AbortSignal;
  log(line: string): void;
}

/** Runs one flow. Postcondition: every `pass` entry of the flow's spec appears once in `checks`; an external failure goes into `externalErrors`, never into a failed check. */
export type FlowRunner = (ctx: FlowContext) => Promise<FlowObservation>;

/**
 * not_ready: the bench cannot run the flow because something it needs is missing, such as a vendor CLI that is not
 * installed or not signed in. It is reported with the reason and the fix in every summary; nothing is ever skipped silently.
 */
export type Verdict = "pass" | "product_fail" | "env_unavailable" | "quota" | "not_ready";

export interface FlowResult {
  /** The flow id, or `<id>@<role>` for a perInstance flow. */
  id: string;
  verdict: Verdict;
  reason: string;
  checks: CheckResult[];
  externalErrors: ExternalError[];
  metrics: Record<string, number>;
  evidence: string[];
  startedAt: string;
  durationMs: number;
}

export interface PreflightResult {
  /** Capabilities that answered; a flow whose needs are not all here is not_ready or env_unavailable, never dropped. */
  available: BenchCapability[];
  problems: ExternalError[];
  /** One entry per vendor in VENDOR_LIST per bench computer, ready or not. */
  coverage: VendorReadiness[];
}

export interface RunRecord {
  runId: string;
  cadence: Cadence;
  startedAt: string;
  finishedAt: string;
  /** The commit each bench instance ran, keyed by instance name. */
  commits: Record<string, string>;
  preflight: PreflightResult;
  results: FlowResult[];
}

export interface Alert {
  flowId: string;
  /** product: likely a Bellwood defect; bench: the environment needs care; coverage: a vendor or computer the bench cannot test yet. */
  kind: "product" | "bench" | "coverage";
  reason: string;
  runIds: string[];
}
