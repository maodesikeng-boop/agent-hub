// Invariant: every registered vendor in AGENT_VENDORS x every platform in VERIFICATION_PLATFORMS has exactly one cell;
// mock-LLM or fake-CLI coverage is never promoted to live_service, and rendered Markdown matches JSON byte-for-byte.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENT_VENDORS, isAgentVendor, vendorLabel, type AgentVendor } from "../src/shared/vendors.ts";
import type { VendorEndpointSupport } from "../test/mock-llm/types.ts";
import { VENDOR_MOCK_ADAPTERS } from "../test/mock-llm/vendors.ts";
import type { InstanceRole, RunRecord } from "../test/tester/types.ts";
import { VENDOR_BENCH } from "../test/tester/vendors.ts";
import { REPO_ROOT, readDesktopAppVersion } from "./stage-runtime-common.ts";

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

export type MatrixValidationCode =
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

export interface MatrixValidationProblem {
  path: string;
  code: MatrixValidationCode;
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

const DEFAULT_FEISHU_LAYOUT: PackagedFeishuLayout = {
  macAppPath: "/Applications/Bellwood.app",
  macRuntimeRelativeDir: "Contents/Resources/runtime",
  macNodeRelativePath: "node/bin/node",
  macFeishuEntryRelativePath: "daemon/src/feishu/main.ts",
  winInstallDirEnv: "$env:LOCALAPPDATA\\Bellwood",
  winNodeRelativePath: "node\\node.exe",
  winFeishuEntryRelativePath: "daemon\\src\\feishu\\main.ts",
  sourceFeishuEntryRelativePath: "src/feishu/main.ts",
};

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:t|u|a)-[A-Za-z0-9._-]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /token=[A-Za-z0-9_-]+/g,
];

const FORBIDDEN_REFERENCE_RE = new RegExp(`\\b(?:${["open", "claw"].join("")}|${["mag", "pie"].join("")})\\b`, "i");

const PLATFORM_LABELS: Readonly<Record<VerificationPlatform, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const TIER_LEGEND: readonly { tier: VerificationTier; meaning: string }[] = [
  { tier: "live_service", meaning: "Real vendor CLI completed a real upstream model turn recorded for this commit." },
  { tier: "real_cli_mock_llm", meaning: "Real vendor CLI ran end-to-end against Bellwood's loopback mock LLM server (non-live model backend)." },
  { tier: "fake_cli_offline", meaning: "Covered by fake CLI smoke or offline driver protocol and contract unit tests on this platform." },
  { tier: "unverified", meaning: "No real-CLI or platform-specific vendor driver test ran on this platform for this commit." },
  { tier: "not_applicable", meaning: "This vendor CLI does not support or ship on this platform." },
];

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function redactText(text: string, maxChars: number = VERIFICATION_FIELD_MAX_CHARS): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out.length > maxChars ? `${out.slice(0, maxChars - 3)}...` : out;
}

const boundedText = z.string().trim().min(1).max(VERIFICATION_FIELD_MAX_CHARS);
const isoDateSchema = z.string().refine(isValidIsoDate, { message: "Expected valid YYYY-MM-DD date" });
const vendorSchema = z.enum(AGENT_VENDORS);
const platformSchema = z.enum(VERIFICATION_PLATFORMS);

const surfaceSchema = z
  .object({
    id: boundedText,
    label: boundedText,
    platform: z.enum([...VERIFICATION_PLATFORMS, "multi"]),
    cliKind: z.enum(["fake", "real"]),
    modelBackend: z.enum(["fake", "mock_llm", "live_service"]),
    workflowOrCommand: boundedText,
    scope: boundedText,
  })
  .strict();

const cellSchema = z.discriminatedUnion("tier", [
  z.object({
    vendor: vendorSchema,
    platform: platformSchema,
    tier: z.literal("live_service"),
    cliVersion: boundedText,
    model: boundedText,
    evidenceRef: boundedText,
    verifiedAt: isoDateSchema,
    note: boundedText.optional(),
  }).strict(),
  z.object({
    vendor: vendorSchema,
    platform: platformSchema,
    tier: z.literal("real_cli_mock_llm"),
    cliVersion: boundedText,
    workflow: boundedText,
    command: boundedText,
    evidenceRef: boundedText,
    gapReason: boundedText,
    fallbackTests: z.array(boundedText).min(1).max(VERIFICATION_MAX_FALLBACK_TESTS),
  }).strict(),
  z.object({
    vendor: vendorSchema,
    platform: platformSchema,
    tier: z.literal("fake_cli_offline"),
    gapReason: boundedText,
    fallbackTests: z.array(boundedText).min(1).max(VERIFICATION_MAX_FALLBACK_TESTS),
  }).strict(),
  z.object({
    vendor: vendorSchema,
    platform: platformSchema,
    tier: z.enum(["unverified", "not_applicable"]),
    gapReason: boundedText,
    fallbackTests: z.array(boundedText).max(VERIFICATION_MAX_FALLBACK_TESTS),
  }).strict(),
]);

const verificationMatrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseVersion: boundedText,
    commit: z.string().regex(COMMIT_SHA_RE, "Expected 7-40 lowercase hex commit SHA"),
    recordedAt: isoDateSchema,
    surfaces: z.array(surfaceSchema).min(1).max(VERIFICATION_MAX_SURFACES),
    cells: z.array(cellSchema).min(1),
  })
  .strict();

export function parseVerificationMatrix(raw: unknown): VerificationMatrix {
  const serialized = JSON.stringify(raw);
  if (serialized === undefined) throw new Error("Verification matrix input is not JSON-serializable");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > VERIFICATION_MATRIX_MAX_BYTES) {
    throw new Error(`Verification matrix size (${bytes} bytes) exceeds ${VERIFICATION_MATRIX_MAX_BYTES} bytes`);
  }
  const parsed = verificationMatrixSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`Invalid verification matrix: ${details}`);
  }
  return parsed.data;
}

interface ParsedWorkflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, { env?: Record<string, unknown>; steps?: Array<{ env?: Record<string, unknown> }> }>;
}

function collectEnvRealCli(env: Record<string, unknown> | undefined, target: Set<AgentVendor>, file: string): void {
  const raw = env?.["BELLWOOD_REQUIRE_REAL_CLI"];
  if (typeof raw !== "string" || raw.trim() === "") return;
  for (const part of raw.split(",")) {
    const vendor = part.trim();
    if (vendor === "") continue;
    if (!isAgentVendor(vendor)) {
      throw new Error(`Workflow ${file} declares unknown vendor "${vendor}" in BELLWOOD_REQUIRE_REAL_CLI`);
    }
    target.add(vendor);
  }
}

export function readWorkflowRealCliVendors(workflowsDir: string): Readonly<Record<string, readonly AgentVendor[]>> {
  const result: Record<string, readonly AgentVendor[]> = {};
  const files = readdirSync(workflowsDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort();
  for (const file of files) {
    const parsed = parseYaml(readFileSync(join(workflowsDir, file), "utf8")) as ParsedWorkflow | null;
    if (!parsed || typeof parsed !== "object") continue;
    const found = new Set<AgentVendor>();
    collectEnvRealCli(parsed.env, found, file);
    for (const job of Object.values(parsed.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      collectEnvRealCli(job.env, found, file);
      for (const step of job.steps ?? []) collectEnvRealCli(step?.env, found, file);
    }
    if (found.size > 0) result[file] = [...found].sort();
  }
  return result;
}

function addProblem(problems: MatrixValidationProblem[], path: string, code: MatrixValidationCode, message: string): void {
  problems.push({ path, code, message });
}

function checkTextField(path: string, value: string | undefined, problems: MatrixValidationProblem[]): void {
  if (value === undefined) return;
  if (value.length > VERIFICATION_FIELD_MAX_CHARS) {
    addProblem(problems, path, "invalid_schema", `Field exceeds ${VERIFICATION_FIELD_MAX_CHARS} characters`);
  }
  if (containsSecret(value)) addProblem(problems, path, "secret_detected", "Field matches a credential or token pattern");
  if (FORBIDDEN_REFERENCE_RE.test(value)) {
    addProblem(problems, path, "forbidden_reference_name", "Field contains a forbidden third-party reference product name");
  }
}

function checkRequiredText(path: string, value: string | undefined, label: string, problems: MatrixValidationProblem[]): void {
  if (!value || value.trim() === "") addProblem(problems, path, "missing_evidence", `${label} is required`);
  else checkTextField(path, value, problems);
}

function validateCellFields(
  cell: VerificationCell,
  path: string,
  facts: RepoVerificationFacts,
  problems: MatrixValidationProblem[],
): void {
  if (cell.tier === "live_service") {
    for (const key of ["cliVersion", "model", "evidenceRef", "verifiedAt"] as const) {
      checkRequiredText(`${path}.${key}`, cell[key], `live_service ${key}`, problems);
    }
    if (cell.verifiedAt && !isValidIsoDate(cell.verifiedAt)) {
      addProblem(problems, `${path}.verifiedAt`, "invalid_date", `Invalid ISO date "${cell.verifiedAt}"`);
    }
    checkTextField(`${path}.note`, cell.note, problems);
    return;
  }

  if (cell.tier === "real_cli_mock_llm") {
    for (const key of ["cliVersion", "workflow", "command", "evidenceRef", "gapReason"] as const) {
      checkRequiredText(`${path}.${key}`, cell[key], `real_cli_mock_llm ${key}`, problems);
    }
    if (facts.mockSupportByVendor[cell.vendor] !== "full") {
      addProblem(
        problems,
        `${path}.tier`,
        "unsupported_mock_vendor",
        `Vendor "${cell.vendor}" does not have full mock-LLM support (${facts.mockSupportByVendor[cell.vendor]})`,
      );
    }
    if (!(facts.workflowRealCliVendors[cell.workflow] ?? []).includes(cell.vendor)) {
      addProblem(
        problems,
        `${path}.workflow`,
        "workflow_mismatch",
        `Workflow "${cell.workflow}" does not declare "${cell.vendor}" in BELLWOOD_REQUIRE_REAL_CLI`,
      );
    }
  } else {
    checkRequiredText(`${path}.gapReason`, cell.gapReason, `${cell.tier} gapReason`, problems);
  }

  if (cell.fallbackTests.length > VERIFICATION_MAX_FALLBACK_TESTS) {
    addProblem(problems, `${path}.fallbackTests`, "invalid_schema", `fallbackTests exceeds max length ${VERIFICATION_MAX_FALLBACK_TESTS}`);
  }
  if ((cell.tier === "real_cli_mock_llm" || cell.tier === "fake_cli_offline") && cell.fallbackTests.length === 0) {
    addProblem(problems, `${path}.fallbackTests`, "missing_evidence", `${cell.tier} cell must list at least one fallback test`);
  }
  cell.fallbackTests.forEach((testPath, idx) =>
    checkRequiredText(`${path}.fallbackTests[${idx}]`, testPath, "fallback test entry", problems),
  );
}

export function validateVerificationMatrix(
  matrix: VerificationMatrix,
  facts: RepoVerificationFacts,
): MatrixValidationProblem[] {
  const problems: MatrixValidationProblem[] = [];

  if (matrix.schemaVersion !== 1) {
    addProblem(problems, "schemaVersion", "invalid_schema", `Expected schemaVersion 1, got ${String(matrix.schemaVersion)}`);
  }
  if (!COMMIT_SHA_RE.test(matrix.commit)) {
    addProblem(problems, "commit", "invalid_commit", `Malformed commit SHA "${matrix.commit}"`);
  } else if (facts.commitExists && !facts.commitExists(matrix.commit)) {
    addProblem(problems, "commit", "unknown_commit", `Commit "${matrix.commit}" was not found in git history`);
  }
  if (!isValidIsoDate(matrix.recordedAt)) {
    addProblem(problems, "recordedAt", "invalid_date", `Invalid ISO date "${matrix.recordedAt}"`);
  }
  if (matrix.releaseVersion !== facts.appVersion) {
    addProblem(
      problems,
      "releaseVersion",
      "version_mismatch",
      `Matrix releaseVersion "${matrix.releaseVersion}" does not match app version "${facts.appVersion}"`,
    );
  }
  checkTextField("releaseVersion", matrix.releaseVersion, problems);

  if (matrix.surfaces.length === 0 || matrix.surfaces.length > VERIFICATION_MAX_SURFACES) {
    addProblem(problems, "surfaces", "invalid_schema", `surfaces must contain 1..${VERIFICATION_MAX_SURFACES} entries`);
  }
  matrix.surfaces.forEach((surface, idx) => {
    for (const key of ["id", "label", "workflowOrCommand", "scope"] as const) {
      checkTextField(`surfaces[${idx}].${key}`, surface[key], problems);
    }
  });

  const allowedVendors = new Set<string>(facts.vendors);
  const allowedPlatforms = new Set<string>(VERIFICATION_PLATFORMS);
  const seenCells = new Set<string>();

  matrix.cells.forEach((cell, idx) => {
    const path = `cells[${idx}]`;
    const vendorOk = allowedVendors.has(cell.vendor);
    const platformOk = allowedPlatforms.has(cell.platform);
    if (!vendorOk) addProblem(problems, `${path}.vendor`, "unknown_vendor", `Unknown vendor "${String(cell.vendor)}"`);
    if (!platformOk) addProblem(problems, `${path}.platform`, "unknown_platform", `Unknown platform "${String(cell.platform)}"`);
    if (vendorOk && platformOk) {
      const key = `${cell.vendor}:${cell.platform}`;
      if (seenCells.has(key)) addProblem(problems, path, "duplicate_cell", `Duplicate cell for ${cell.vendor} on ${cell.platform}`);
      seenCells.add(key);
      validateCellFields(cell, path, facts, problems);
    }
  });

  for (const vendor of facts.vendors) {
    for (const platform of VERIFICATION_PLATFORMS) {
      if (!seenCells.has(`${vendor}:${platform}`)) {
        addProblem(problems, "cells", "missing_cell", `Missing verification cell for ${vendor} on ${platform}`);
      }
    }
  }

  return problems;
}

function commitsAlign(a: string, b: string): boolean {
  const [left, right] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (!COMMIT_SHA_RE.test(left) || !COMMIT_SHA_RE.test(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function ingestTesterRunRecord(
  matrix: VerificationMatrix,
  record: RunRecord,
  opts: { platformByInstance: Readonly<Record<InstanceRole, VerificationPlatform>>; recordedAt: string },
): VerificationMatrix {
  if (!isValidIsoDate(opts.recordedAt)) throw new Error(`Invalid recordedAt date "${opts.recordedAt}"`);
  if (!record || typeof record !== "object" || typeof record.runId !== "string" || record.runId.trim() === "") {
    throw new Error("Invalid RunRecord: missing runId");
  }
  if (!Array.isArray(record.results) || !record.preflight || !Array.isArray(record.preflight.coverage)) {
    throw new Error("Invalid RunRecord: missing results or preflight coverage");
  }
  const recordedCommits = Object.entries(record.commits ?? {}).filter(([, sha]) => typeof sha === "string" && sha.trim() !== "");
  if (recordedCommits.length === 0) throw new Error("RunRecord commit mismatch: no commit recorded in RunRecord");
  for (const [role, sha] of recordedCommits) {
    if (!commitsAlign(sha, matrix.commit)) {
      throw new Error(`RunRecord commit mismatch for ${role}: ${sha} does not match matrix commit ${matrix.commit}`);
    }
  }

  const coverageByKey = new Map(record.preflight.coverage.map((entry) => [`${entry.vendor}:${entry.instance}`, entry]));
  const turnUpdates = new Map<string, { vendor: AgentVendor; instance: InstanceRole; result: RunRecord["results"][number] }>();

  for (const result of record.results) {
    const match = /^model\.turn\.([a-z0-9_-]+)@(local|remote)$/.exec(result.id);
    if (!match || !isAgentVendor(match[1])) continue;
    const vendor = match[1];
    const instance = match[2] as InstanceRole;
    turnUpdates.set(`${vendor}:${opts.platformByInstance[instance]}`, { vendor, instance, result });
  }

  const nextCells: VerificationCell[] = matrix.cells.map((cell) => {
    const hit = turnUpdates.get(`${cell.vendor}:${cell.platform}`);
    if (!hit) return cell;
    const { vendor, instance, result } = hit;
    if (result.verdict === "pass") {
      const readiness = coverageByKey.get(`${vendor}:${instance}`);
      const recipe = VENDOR_BENCH[vendor][instance];
      const model = recipe.coverage === "turn" && recipe.model ? recipe.model : "vendor default";
      const note = result.reason ? redactText(`Run ${record.runId} (${record.cadence}): ${result.reason}`) : undefined;
      return {
        vendor,
        platform: cell.platform,
        tier: "live_service",
        cliVersion: redactText(readiness?.version ?? "unknown"),
        model: redactText(model),
        evidenceRef: redactText(`tester:${record.runId}:${result.id}`),
        verifiedAt: opts.recordedAt,
        ...(note ? { note } : {}),
      };
    }

    const safeReason = redactText(`Bench ${record.runId} (${result.verdict}): ${result.reason}`);
    if (cell.tier === "live_service") {
      return result.verdict === "product_fail"
        ? { vendor, platform: cell.platform, tier: "unverified", gapReason: safeReason, fallbackTests: ["src/vendors/contract.test.ts"] }
        : cell;
    }
    return { ...cell, gapReason: redactText(`${safeReason} | ${cell.gapReason}`) };
  });

  return { ...matrix, recordedAt: opts.recordedAt, cells: nextCells };
}

function escapeCell(text: string): string {
  return text.replace(/—/g, "-").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatSummaryCell(cell: VerificationCell | undefined): string {
  if (!cell) return "`unverified`";
  if (cell.tier === "live_service") return `\`live_service\` (${escapeCell(cell.model)}, CLI ${escapeCell(cell.cliVersion)})`;
  if (cell.tier === "real_cli_mock_llm") return `\`real_cli_mock_llm\` (${escapeCell(cell.workflow)}, CLI ${escapeCell(cell.cliVersion)})`;
  return `\`${cell.tier}\``;
}

function formatDetailColumns(cell: VerificationCell): { runtime: string; evidence: string; gap: string } {
  if (cell.tier === "live_service") {
    return {
      runtime: `CLI ${escapeCell(cell.cliVersion)} / ${escapeCell(cell.model)}`,
      evidence: `${escapeCell(cell.evidenceRef)} (${cell.verifiedAt})`,
      gap: cell.note ? escapeCell(cell.note) : "Live upstream turn passed.",
    };
  }
  const fallback =
    cell.fallbackTests.length > 0 ? ` Fallback: ${cell.fallbackTests.map((t) => `\`${escapeCell(t)}\``).join(", ")}.` : "";
  if (cell.tier === "real_cli_mock_llm") {
    return {
      runtime: `CLI ${escapeCell(cell.cliVersion)} via \`${escapeCell(cell.workflow)}\``,
      evidence: `\`${escapeCell(cell.evidenceRef)}\``,
      gap: `${escapeCell(cell.gapReason)}${fallback}`,
    };
  }
  return { runtime: "-", evidence: "-", gap: `${escapeCell(cell.gapReason)}${fallback}` };
}

export function renderVerificationMatrixMarkdown(matrix: VerificationMatrix): string {
  const cellMap = new Map(matrix.cells.map((cell) => [`${cell.vendor}:${cell.platform}`, cell]));
  const lines: string[] = [
    "# Verification matrix",
    "",
    `> Snapshot: ${matrix.recordedAt} (commit \`${matrix.commit}\`)`,
    "",
    `Commit-bound verification status for Bellwood **v${escapeCell(matrix.releaseVersion)}** across all ${AGENT_VENDORS.length} registered agent CLIs and ${VERIFICATION_PLATFORMS.length} platforms. Generated from [\`docs/verification-matrix.json\`](verification-matrix.json); do not edit by hand.`,
    "",
    "## Verification tiers",
    "",
    "| Tier | Meaning |",
    "| --- | --- |",
    ...TIER_LEGEND.map((item) => `| \`${item.tier}\` | ${escapeCell(item.meaning)} |`),
    "",
    "## Verification surfaces",
    "",
    "| Surface | Platform | CLI | Model backend | Workflow or command | Scope |",
    "| --- | --- | --- | --- | --- | --- |",
    ...matrix.surfaces.map(
      (s) =>
        `| ${escapeCell(s.label)} | \`${s.platform}\` | \`${s.cliKind}\` | \`${s.modelBackend}\` | \`${escapeCell(s.workflowOrCommand)}\` | ${escapeCell(s.scope)} |`,
    ),
    "",
    "## Vendor x platform matrix",
    "",
    `| Vendor | ${VERIFICATION_PLATFORMS.map((p) => PLATFORM_LABELS[p]).join(" | ")} |`,
    `| --- | ${VERIFICATION_PLATFORMS.map(() => "---").join(" | ")} |`,
    ...AGENT_VENDORS.map((vendor) => {
      const row = VERIFICATION_PLATFORMS.map((platform) => formatSummaryCell(cellMap.get(`${vendor}:${platform}`)));
      return `| **${escapeCell(vendorLabel(vendor))}** (\`${vendor}\`) | ${row.join(" | ")} |`;
    }),
    "",
    "## Detailed coverage and gaps",
    "",
    "| Vendor | Platform | Tier | CLI / Model / Workflow | Evidence | Coverage notes and fallback tests |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const vendor of AGENT_VENDORS) {
    for (const platform of VERIFICATION_PLATFORMS) {
      const cell = cellMap.get(`${vendor}:${platform}`);
      if (!cell) continue;
      const d = formatDetailColumns(cell);
      lines.push(`| \`${vendor}\` | ${PLATFORM_LABELS[platform]} | \`${cell.tier}\` | ${d.runtime} | ${d.evidence} | ${d.gap} |`);
    }
  }

  lines.push(
    "",
    "## Reproduce and update",
    "",
    "```sh",
    "node scripts/verification-matrix.ts check",
    "node scripts/verification-matrix.ts render --write",
    "node scripts/verification-matrix.ts ingest-tester --run <run-record.json> --write",
    "```",
    "",
  );

  return lines.join("\n");
}

const joinPosix = (...parts: string[]) =>
  parts.map((p, idx) => (idx === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""))).join("/");
const joinWin = (...parts: string[]) =>
  parts.map((p, idx) => (idx === 0 ? p.replace(/\\+$/, "") : p.replace(/^\\+|\\+$/g, ""))).join("\\");

export function packagedFeishuCommands(layout: PackagedFeishuLayout): PackagedFeishuCommands {
  const macRuntime = joinPosix(layout.macAppPath, layout.macRuntimeRelativeDir);
  const macNode = joinPosix(macRuntime, layout.macNodeRelativePath);
  const macEntry = joinPosix(macRuntime, layout.macFeishuEntryRelativePath);
  const winNode = joinWin(layout.winInstallDirEnv, layout.winNodeRelativePath);
  const winEntry = joinWin(layout.winInstallDirEnv, layout.winFeishuEntryRelativePath);
  const sourceEntry = layout.sourceFeishuEntryRelativePath.replace(/^\/+/, "");
  return {
    macConnect: `${macNode} ${macEntry} connect`,
    macStatus: `${macNode} ${macEntry} status`,
    winConnectPowerShell: `& "${winNode}" "${winEntry}" connect`,
    winStatusPowerShell: `& "${winNode}" "${winEntry}" status`,
    sourceConnect: `node ${sourceEntry} connect`,
    sourceStatus: `node ${sourceEntry} status`,
  };
}

function extractSection(markdown: string, startHeading: RegExp, endHeading: RegExp): string {
  const startMatch = startHeading.exec(markdown);
  if (!startMatch) return "";
  const rest = markdown.slice(startMatch.index);
  const nextMatch = endHeading.exec(rest.slice(startMatch[0].length));
  return nextMatch ? rest.slice(0, startMatch[0].length + nextMatch.index) : rest;
}

function checkReadmeFeishuQuickStart(opts: {
  label: string;
  markdown: string;
  step4Heading: RegExp;
  feishuSectionHeading: RegExp;
  sourceScopePattern: RegExp;
  cliOnlyDisclosurePattern: RegExp;
  commands: PackagedFeishuCommands;
  problems: string[];
}): void {
  const { label, markdown, step4Heading, feishuSectionHeading, sourceScopePattern, cliOnlyDisclosurePattern, commands, problems } =
    opts;
  if (!markdown.includes("docs/verification-matrix.md")) problems.push(`${label}: missing link to docs/verification-matrix.md`);

  const step4 = extractSection(markdown, step4Heading, /^(?:### |## |<details>)/m);
  if (!step4) {
    problems.push(`${label}: missing Quick start step 4 section`);
    return;
  }

  for (const [name, cmd] of Object.entries(commands)) {
    if (!step4.includes(cmd)) problems.push(`${label}: Quick start step 4 missing ${name} command`);
  }
  if (!cliOnlyDisclosurePattern.test(step4)) {
    problems.push(`${label}: Quick start step 4 must disclose that Feishu setup uses the bundled CLI rather than an in-app Settings tab`);
  }
  if (!step4.includes("Settings → Computers") && !step4.includes("Settings -> Computers")) {
    problems.push(`${label}: Quick start step 4 must reference Settings -> Computers for bot host status`);
  }

  const sourceLines = step4.split(/\r?\n/).filter((line) => line.includes(commands.sourceConnect));
  if (sourceLines.length === 0 || sourceLines.some((line) => !sourceScopePattern.test(line))) {
    problems.push(`${label}: Quick start step 4 must scope "${commands.sourceConnect}" to Linux or source checkouts`);
  }

  const feishuSection = extractSection(markdown, feishuSectionHeading, /^## /m);
  if (!feishuSection) {
    problems.push(`${label}: missing Feishu overview section`);
    return;
  }
  const bareLines = feishuSection.split(/\r?\n/).filter((line) => line.includes(commands.sourceConnect) && !sourceScopePattern.test(line));
  if (bareLines.length > 0) {
    problems.push(`${label}: Feishu section uses unqualified "${commands.sourceConnect}" without Linux/source scoping`);
  }
}

export function validateFeishuQuickStartDocs(input: {
  readmeEn: string;
  readmeZh: string;
  commands: PackagedFeishuCommands;
}): string[] {
  const problems: string[] = [];
  checkReadmeFeishuQuickStart({
    label: "README.md",
    markdown: input.readmeEn,
    step4Heading: /^### 4\. Connect Feishu/m,
    feishuSectionHeading: /^## Feishu on mobile and in team groups$/m,
    sourceScopePattern: /linux|source/i,
    cliOnlyDisclosurePattern: /(?:bundled|terminal)?\s*CLI[\s\S]{0,120}(?:no in-app|rather than an in-app|not yet in-app|in-app)/i,
    commands: input.commands,
    problems,
  });
  checkReadmeFeishuQuickStart({
    label: "README.zh-CN.md",
    markdown: input.readmeZh,
    step4Heading: /^### 4\. 接入飞书/m,
    feishuSectionHeading: /^## 飞书入口$/m,
    sourceScopePattern: /linux|源码/i,
    cliOnlyDisclosurePattern: /(?:内置命令行|命令行)[\s\S]{0,60}(?:暂未提供应用内|暂无应用内|非应用内|没有应用内)/,
    commands: input.commands,
    problems,
  });
  return problems;
}

function fullHistoryCommitChecker(repoRoot: string): ((sha: string) => boolean) | undefined {
  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (shallow !== "false") return undefined;
    return (sha: string) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
  } catch {
    return undefined;
  }
}

function collectRepoFacts(repoRoot: string, appVersionOverride?: string): RepoVerificationFacts {
  const mockSupportByVendor = Object.fromEntries(
    AGENT_VENDORS.map((vendor) => [vendor, VENDOR_MOCK_ADAPTERS[vendor].support]),
  ) as Record<AgentVendor, VendorEndpointSupport>;
  return {
    vendors: AGENT_VENDORS,
    mockSupportByVendor,
    workflowRealCliVendors: readWorkflowRealCliVendors(join(repoRoot, ".github", "workflows")),
    appVersion: appVersionOverride ?? readDesktopAppVersion(repoRoot),
    commitExists: fullHistoryCommitChecker(repoRoot),
  };
}

export function validateRepoVerificationMatrix(repoRoot: string, appVersionOverride?: string): MatrixValidationProblem[] {
  const jsonPath = join(repoRoot, "docs", "verification-matrix.json");
  const mdPath = join(repoRoot, "docs", "verification-matrix.md");
  if (!existsSync(jsonPath)) {
    return [{ path: "docs/verification-matrix.json", code: "missing_evidence", message: "docs/verification-matrix.json does not exist" }];
  }
  let matrix: VerificationMatrix;
  try {
    matrix = parseVerificationMatrix(JSON.parse(readFileSync(jsonPath, "utf8")) as unknown);
  } catch (error) {
    return [{ path: "docs/verification-matrix.json", code: "invalid_schema", message: error instanceof Error ? error.message : String(error) }];
  }

  const problems = validateVerificationMatrix(matrix, collectRepoFacts(repoRoot, appVersionOverride));
  const expectedMd = renderVerificationMatrixMarkdown(matrix);
  if (!existsSync(mdPath) || readFileSync(mdPath, "utf8") !== expectedMd) {
    addProblem(
      problems,
      "docs/verification-matrix.md",
      "markdown_drift",
      "docs/verification-matrix.md is missing or out of sync with docs/verification-matrix.json (run: node scripts/verification-matrix.ts render --write)",
    );
  }

  const [readmeEnPath, readmeZhPath] = [join(repoRoot, "README.md"), join(repoRoot, "README.zh-CN.md")];
  if (existsSync(readmeEnPath) && existsSync(readmeZhPath)) {
    const docProblems = validateFeishuQuickStartDocs({
      readmeEn: readFileSync(readmeEnPath, "utf8"),
      readmeZh: readFileSync(readmeZhPath, "utf8"),
      commands: packagedFeishuCommands(DEFAULT_FEISHU_LAYOUT),
    });
    for (const msg of docProblems) addProblem(problems, "README", "missing_evidence", msg);
  }

  return problems;
}

function parseCliFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(arg.slice(2), "true");
    } else {
      flags.set(arg.slice(2), next);
      i += 1;
    }
  }
  return flags;
}

const CLI_USAGE = [
  "Usage: node scripts/verification-matrix.ts check",
  "  | render [--write]",
  "  | ingest-tester --run <run-record.json> [--date YYYY-MM-DD] [--write]",
].join("\n");

export function runVerificationMatrixCli(argv: readonly string[], opts?: { repoRoot?: string }): number {
  const repoRoot = opts?.repoRoot ?? REPO_ROOT;
  const [command, ...rest] = argv;
  const flags = parseCliFlags(rest);
  const jsonPath = join(repoRoot, "docs", "verification-matrix.json");
  const mdPath = join(repoRoot, "docs", "verification-matrix.md");

  try {
    if (command === "check") {
      const problems = validateRepoVerificationMatrix(repoRoot);
      for (const p of problems) console.error(`[${p.code}] ${p.path}: ${redactText(p.message)}`);
      return problems.length > 0 ? 1 : 0;
    }

    if (command === "render") {
      const matrix = parseVerificationMatrix(JSON.parse(readFileSync(jsonPath, "utf8")) as unknown);
      const rendered = renderVerificationMatrixMarkdown(matrix);
      if (flags.has("write")) writeFileAtomic.sync(mdPath, rendered, "utf8");
      else process.stdout.write(rendered);
      return 0;
    }

    if (command === "ingest-tester") {
      const runFile = flags.get("run");
      if (!runFile || runFile === "true") {
        console.error("Missing --run <run-record.json>");
        return 2;
      }
      const matrix = parseVerificationMatrix(JSON.parse(readFileSync(jsonPath, "utf8")) as unknown);
      const record = JSON.parse(readFileSync(resolve(repoRoot, runFile), "utf8")) as RunRecord;
      const recordedAt = flags.get("date") ?? (typeof record.finishedAt === "string" ? record.finishedAt.slice(0, 10) : matrix.recordedAt);
      const updated = ingestTesterRunRecord(matrix, record, { platformByInstance: { local: "macos", remote: "linux" }, recordedAt });
      const problems = validateVerificationMatrix(updated, collectRepoFacts(repoRoot));
      if (problems.length > 0) {
        for (const p of problems) console.error(`[${p.code}] ${p.path}: ${redactText(p.message)}`);
        return 1;
      }
      const nextJson = `${JSON.stringify(updated, null, 2)}\n`;
      if (flags.has("write")) {
        writeFileAtomic.sync(jsonPath, nextJson, "utf8");
        writeFileAtomic.sync(mdPath, renderVerificationMatrixMarkdown(updated), "utf8");
      } else {
        process.stdout.write(nextJson);
      }
      return 0;
    }

    console.error(CLI_USAGE);
    return 2;
  } catch (error) {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runVerificationMatrixCli(process.argv.slice(2));
}
