// Invariant: every registered vendor in AGENT_VENDORS x every platform in VERIFICATION_PLATFORMS has exactly one cell;
// mock-LLM or fake-CLI coverage is never promoted to live_service, and rendered Markdown matches JSON byte-for-byte.
import type { AgentVendor } from "../src/shared/vendors.ts";
import type { InstanceRole, RunRecord } from "../test/tester/types.ts";
import type { VendorEndpointSupport } from "../test/mock-llm/types.ts";

export const VERIFICATION_PLATFORMS = ["macos", "windows", "linux"] as const;
export type VerificationPlatform = (typeof VERIFICATION_PLATFORMS)[number];

export const VERIFICATION_TIERS = [
  "live_service",
  "real_cli_mock_llm",
  "fake_cli_offline",
  "unverified",
  "not_applicable",
] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export const VERIFICATION_MATRIX_MAX_BYTES = 256 * 1024;
export const VERIFICATION_FIELD_MAX_CHARS = 400;
export const VERIFICATION_MAX_FALLBACK_TESTS = 16;
export const VERIFICATION_MAX_SURFACES = 16;

export interface VerificationCellBase {
  vendor: AgentVendor;
  platform: VerificationPlatform;
}

export interface LiveServiceCell extends VerificationCellBase {
  tier: "live_service";
  cliVersion: string;
  model: string;
  evidenceRef: string;
  verifiedAt: string;
  note?: string;
}

export interface RealCliMockLlmCell extends VerificationCellBase {
  tier: "real_cli_mock_llm";
  cliVersion: string;
  workflow: string;
  command: string;
  evidenceRef: string;
  gapReason: string;
  fallbackTests: readonly string[];
}

export interface FakeCliOfflineCell extends VerificationCellBase {
  tier: "fake_cli_offline";
  gapReason: string;
  fallbackTests: readonly string[];
}

export interface GapCell extends VerificationCellBase {
  tier: "unverified" | "not_applicable";
  gapReason: string;
  fallbackTests: readonly string[];
}

export type VerificationCell = LiveServiceCell | RealCliMockLlmCell | FakeCliOfflineCell | GapCell;

export interface VerificationSurfaceSummary {
  id: string;
  label: string;
  platform: VerificationPlatform | "multi";
  cliKind: "fake" | "real";
  modelBackend: "fake" | "mock_llm" | "live_service";
  workflowOrCommand: string;
  scope: string;
}

export interface VerificationMatrix {
  schemaVersion: 1;
  releaseVersion: string;
  commit: string;
  recordedAt: string;
  surfaces: readonly VerificationSurfaceSummary[];
  cells: readonly VerificationCell[];
}

export interface RepoVerificationFacts {
  vendors: readonly AgentVendor[];
  mockSupportByVendor: Readonly<Record<AgentVendor, VendorEndpointSupport>>;
  workflowRealCliVendors: Readonly<Record<string, readonly AgentVendor[]>>;
  appVersion: string;
  commitExists?: (sha: string) => boolean;
}

export interface MatrixValidationProblem {
  path: string;
  code:
    | "invalid_schema"
    | "missing_cell"
    | "duplicate_cell"
    | "unknown_vendor"
    | "unknown_platform"
    | "invalid_commit"
    | "unknown_commit"
    | "invalid_date"
    | "version_mismatch"
    | "unsupported_mock_vendor"
    | "workflow_mismatch"
    | "missing_evidence"
    | "secret_detected"
    | "forbidden_reference_name"
    | "markdown_drift";
  message: string;
}

export interface PackagedFeishuLayout {
  macAppPath: string;
  macRuntimeRelativeDir: string;
  macNodeRelativePath: string;
  macFeishuEntryRelativePath: string;
  winInstallDirEnv: string;
  winNodeRelativePath: string;
  winFeishuEntryRelativePath: string;
  sourceFeishuEntryRelativePath: string;
}

export interface PackagedFeishuCommands {
  macConnect: string;
  macStatus: string;
  winConnectPowerShell: string;
  winStatusPowerShell: string;
  sourceConnect: string;
  sourceStatus: string;
}

/**
 * Precondition: `raw` is a parsed JSON value whose serialized size is within VERIFICATION_MATRIX_MAX_BYTES.
 * Postcondition: returns a strictly typed VerificationMatrix; throws an Error with field details on malformed input.
 */
export function parseVerificationMatrix(_raw: unknown): VerificationMatrix {
  throw new Error("Not implemented");
}

/**
 * Precondition: `workflowsDir` points to the repository's `.github/workflows` directory.
 * Postcondition: returns a map from workflow filename (such as `windows.yml` or `nightly.yml`) to the sorted unique
 * `AgentVendor` list configured in `BELLWOOD_REQUIRE_REAL_CLI` across its jobs.
 */
export function readWorkflowRealCliVendors(_workflowsDir: string): Readonly<Record<string, readonly AgentVendor[]>> {
  throw new Error("Not implemented");
}

/**
 * Precondition: `matrix` is a parsed VerificationMatrix and `facts` holds live repository registries and workflow facts.
 * Postcondition: returns an empty array when the matrix covers every vendor x platform exactly once with valid commit,
 * date, version, mock-LLM support, CI workflow parity, non-empty evidence, zero secrets, and zero reference product names;
 * otherwise returns structured problems describing every violation.
 */
export function validateVerificationMatrix(
  _matrix: VerificationMatrix,
  _facts: RepoVerificationFacts,
): MatrixValidationProblem[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: `matrix` is valid, `record` is a tester RunRecord whose commits align with `matrix.commit` (matching prefix),
 * and `opts.platformByInstance` maps bench instance roles to VerificationPlatform values.
 * Postcondition: returns a new VerificationMatrix where `model.turn.<vendor>@<role>` results with verdict `pass` promote
 * their cell to `live_service` (with redacted evidence metadata), while non-pass or accepted-gap results never falsely promote.
 * Throws on commit mismatch or malformed RunRecord inputs.
 */
export function ingestTesterRunRecord(
  _matrix: VerificationMatrix,
  _record: RunRecord,
  _opts: {
    platformByInstance: Readonly<Record<InstanceRole, VerificationPlatform>>;
    recordedAt: string;
  },
): VerificationMatrix {
  throw new Error("Not implemented");
}

/**
 * Precondition: `matrix` is a valid VerificationMatrix.
 * Postcondition: returns deterministic GitHub-Flavored Markdown starting with `# Verification matrix` and
 * `> Snapshot: <recordedAt> (commit \`<commit>\`)`, followed by tier legend, verification surfaces, full vendor x platform
 * table, and reproduction commands. Never includes em dashes or raw secrets.
 */
export function renderVerificationMatrixMarkdown(_matrix: VerificationMatrix): string {
  throw new Error("Not implemented");
}

/**
 * Precondition: `layout` holds the verified relative paths from macOS and Windows packaging scripts.
 * Postcondition: returns exact copy-pasteable Feishu `connect` and `status` commands for packaged macOS, packaged Windows
 * PowerShell, and source/Linux checkouts.
 */
export function packagedFeishuCommands(_layout: PackagedFeishuLayout): PackagedFeishuCommands {
  throw new Error("Not implemented");
}

/**
 * Precondition: `readmeEn` and `readmeZh` are the full contents of `README.md` and `README.zh-CN.md`.
 * Postcondition: returns an empty array when both Quick Start Step 4 and Feishu sections give packaged macOS/Windows
 * commands matching `commands`, scope `node src/feishu/main.ts` to Linux or source checkouts, honestly state Feishu setup
 * runs through the CLI rather than an unbuilt Settings tab, and link to `docs/verification-matrix.md`.
 */
export function validateFeishuQuickStartDocs(_input: {
  readmeEn: string;
  readmeZh: string;
  commands: PackagedFeishuCommands;
}): string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: `argv` is CLI arguments (`check`, `render`, or `ingest-tester --run <file> [--write]`).
 * Postcondition: returns exit code 0 on success and non-zero on validation error or usage error without leaking secrets.
 */
export function runVerificationMatrixCli(
  _argv: readonly string[],
  _opts?: { repoRoot?: string },
): number {
  throw new Error("Not implemented");
}
