// Canonical VerificationMatrix types, bounds, Zod schema parser, redaction helpers, and deterministic Markdown renderer.
import { createRequire } from "node:module";
import { posix } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";
import { AGENT_VENDORS, vendorLabel, type AgentVendor } from "../src/shared/vendors.ts";
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
export const VERIFICATION_MAX_RECORDED_RUNS = 64;

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
  evidenceRef?: string;
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

export interface VerificationRunRecord {
  id: string;
  source: string;
  platform: VerificationPlatform;
  kind: "live_service" | "real_cli_mock_llm" | "fake_cli_offline";
  commit: string;
  urlOrRef: string;
  completedAt: string;
  vendors?: readonly AgentVendor[];
}

export interface VerificationMatrix {
  schemaVersion: 1;
  releaseVersion: string;
  commit: string;
  recordedAt: string;
  surfaces: readonly VerificationSurfaceSummary[];
  recordedRuns: readonly VerificationRunRecord[];
  cells: readonly VerificationCell[];
}

export type WorkflowRealCliPlatformMap = Readonly<Record<string, Readonly<Partial<Record<VerificationPlatform, readonly AgentVendor[]>>>>>;

export interface RepoVerificationFacts {
  vendors: readonly AgentVendor[];
  mockSupportByVendor: Readonly<Record<AgentVendor, VendorEndpointSupport>>;
  workflowRealCliVendors: Readonly<Record<string, readonly AgentVendor[]>>;
  workflowPlatforms?: Readonly<Record<string, readonly VerificationPlatform[]>>;
  workflowRealCliPlatforms?: WorkflowRealCliPlatformMap;
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
  | "platform_mismatch"
  | "unverified_run_evidence"
  | "invalid_cli_version"
  | "missing_evidence"
  | "secret_detected"
  | "forbidden_reference_name"
  | "markdown_drift";

export interface MatrixValidationProblem {
  path: string;
  code: MatrixValidationCode;
  message: string;
}

export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
export const PLACEHOLDER_VALUE_RE = /^(?:unknown|n\/a|na|none|null|undefined|tbd|latest|unverified|manual|ok|passed|local|placeholder|-|\?)$/i;
export const FORBIDDEN_REFERENCE_RE = new RegExp(`\\b(?:${["open", "claw"].join("")}|${["mag", "pie"].join("")})\\b`, "i");
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MATRIX_LINK_TARGET_RE = /(?:^|\/)verification-matrix(?:\.(?:md|json))?(?:$|\/)/i;
const releaseMarkdown = unified().use(remarkParse).use(remarkGfm);
type MarkdownRoot = ReturnType<typeof releaseMarkdown.parse>;
type MarkdownNode = MarkdownRoot | MarkdownRoot["children"][number];
const require = createRequire(import.meta.url);

function htmlLinkTargets(html: string): string[] {
  const { JSDOM } = require("jsdom") as {
    JSDOM: { fragment(html: string): { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> } };
  };
  return Array.from(JSDOM.fragment(html).querySelectorAll("a[href]"), (anchor) => anchor.getAttribute("href")!);
}

function normalizedLinkPath(url: URL): string {
  try {
    return posix.normalize(decodeURIComponent(url.pathname));
  } catch {
    return url.pathname;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isValidReleaseRefForVersion(ref: string, version: string): boolean {
  const trimmed = ref.trim();
  if (trimmed === "" || /^(?:main|master|HEAD|develop)$/i.test(trimmed)) return false;
  if (COMMIT_SHA_RE.test(trimmed)) return true;
  return new RegExp(`^v${escapeRegex(version)}(?:-rc\\.[1-9]\\d*)?$`).test(trimmed);
}

export function extractMatrixLinkTargets(markdown: string): string[] {
  const links: string[] = [];
  const references = new Set<string>();
  const definitions = new Map<string, string>();
  const walk = (node: MarkdownNode): void => {
    if (node.type === "link" && node.url) links.push(node.url);
    if (node.type === "linkReference" && node.identifier) references.add(node.identifier);
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if (node.type === "html" && node.value) links.push(...htmlLinkTargets(node.value));
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(releaseMarkdown.parse(markdown));
  for (const id of references) {
    const target = definitions.get(id);
    if (target) links.push(target);
  }
  return [...new Set(links)].filter((target) => {
    const url = URL.parse(target, "https://github.com/");
    return url !== null && MATRIX_LINK_TARGET_RE.test(normalizedLinkPath(url));
  });
}

export function validateRenderedReleaseMatrixLinks(
  renderedDownloads: string,
  opts: { repo: string; ref: string },
): string[] {
  const problems: string[] = [];
  const repo = opts.repo.trim();
  const ref = opts.ref.trim();
  if (!GITHUB_REPO_RE.test(repo)) {
    problems.push(`Release downloads repo must be owner/name, got "${repo}"`);
    return problems;
  }
  const targets = extractMatrixLinkTargets(renderedDownloads);
  if (targets.length === 0) {
    problems.push("Release downloads template must include a pinned link to docs/verification-matrix.md");
    return problems;
  }
  const expectedPath = `/${repo}/blob/${ref}/docs/verification-matrix`;
  for (const target of targets) {
    const url = URL.parse(target);
    const path = url && normalizedLinkPath(url);
    if (url?.origin !== "https://github.com" || url.username || url.password || url.search ||
      (url.hash && !/^#[A-Za-z0-9_.-]+$/.test(url.hash)) || (path !== `${expectedPath}.md` && path !== `${expectedPath}.json`)) {
      problems.push(
        `Release downloads matrix link "${target}" must point to release ref "${ref}" on "${repo}" (expected https://github.com/${repo}/blob/${ref}/docs/verification-matrix.md), not a floating branch or another ref`,
      );
    }
  }
  return problems;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:t|u|a)-[A-Za-z0-9._-]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /token=[A-Za-z0-9_-]+/g,
];

const PLATFORM_LABELS: Readonly<Record<VerificationPlatform, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const TIER_LEGEND: readonly { tier: VerificationTier; meaning: string }[] = [
  { tier: "live_service", meaning: "Real vendor CLI completed a real upstream model turn recorded for this commit." },
  { tier: "real_cli_mock_llm", meaning: "Real vendor CLI ran end-to-end against Bellwood's loopback mock LLM server (non-live model backend) on this commit." },
  { tier: "fake_cli_offline", meaning: "Covered by fake CLI smoke or offline driver protocol and contract unit tests recorded on this platform for this commit." },
  { tier: "unverified", meaning: "No real-CLI or platform-specific vendor driver test run was recorded on this platform for this commit." },
  { tier: "not_applicable", meaning: "This vendor CLI does not support or ship on this platform." },
];

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function isValidConcreteCliVersion(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > VERIFICATION_FIELD_MAX_CHARS) return false;
  if (PLACEHOLDER_VALUE_RE.test(trimmed)) return false;
  return /\d/.test(trimmed);
}

export function commitsAlign(a: string, b: string): boolean {
  const [left, right] = [a.trim().toLowerCase(), b.trim().toLowerCase()];
  if (!COMMIT_SHA_RE.test(left) || !COMMIT_SHA_RE.test(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactText(text: string, maxChars: number = VERIFICATION_FIELD_MAX_CHARS): string {
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

const recordedRunSchema = z
  .object({
    id: boundedText,
    source: boundedText,
    platform: platformSchema,
    kind: z.enum(["live_service", "real_cli_mock_llm", "fake_cli_offline"]),
    commit: z.string().regex(COMMIT_SHA_RE, "Expected 7-40 lowercase hex commit SHA"),
    urlOrRef: boundedText,
    completedAt: isoDateSchema,
    vendors: z.array(vendorSchema).min(1).max(AGENT_VENDORS.length).optional(),
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
    evidenceRef: boundedText.optional(),
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
    recordedRuns: z.array(recordedRunSchema).max(VERIFICATION_MAX_RECORDED_RUNS),
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
  if (cell.tier === "fake_cli_offline" && cell.evidenceRef) {
    return { runtime: "-", evidence: `\`${escapeCell(cell.evidenceRef)}\``, gap: `${escapeCell(cell.gapReason)}${fallback}` };
  }
  return { runtime: "-", evidence: "-", gap: `${escapeCell(cell.gapReason)}${fallback}` };
}

export function renderVerificationMatrixMarkdown(matrix: VerificationMatrix): string {
  const cellMap = new Map(matrix.cells.map((cell) => [`${cell.vendor}:${cell.platform}`, cell]));
  const runs = matrix.recordedRuns ?? [];
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
    "## Configured verification surfaces",
    "",
    "Static workflows and benches configured in the repository (having a configured surface does not prove it ran on this commit; see recorded runs below).",
    "",
    "| Surface | Platform | CLI | Model backend | Workflow or command | Scope |",
    "| --- | --- | --- | --- | --- | --- |",
    ...matrix.surfaces.map(
      (s) =>
        `| ${escapeCell(s.label)} | \`${s.platform}\` | \`${s.cliKind}\` | \`${s.modelBackend}\` | \`${escapeCell(s.workflowOrCommand)}\` | ${escapeCell(s.scope)} |`,
    ),
    "",
    "## Recorded runs for this commit",
    "",
    ...(runs.length === 0
      ? ["No runs recorded for this commit yet."]
      : [
          "| Run ID | Source | Platform | Kind | Commit | Completed | Evidence |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...runs.map(
            (r) =>
              `| \`${escapeCell(r.id)}\` | \`${escapeCell(r.source)}\` | ${PLATFORM_LABELS[r.platform]} | \`${r.kind}\` | \`${r.commit.slice(0, 8)}\` | ${r.completedAt} | \`${escapeCell(r.urlOrRef)}\` |`,
          ),
        ]),
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
    "Offline `check` validates schema, commit-bound run references, workflow configs, Markdown sync, and packaged Feishu commands without network access. Pass `--verify-runs` to also check the commit, workflow, runner platform, and successful completion of the required test steps against GitHub Actions metadata for each recorded CI run.",
    "",
    "```sh",
    "node scripts/verification-matrix.ts check",
    "node scripts/verification-matrix.ts check --verify-runs",
    "node scripts/verification-matrix.ts render --write",
    "node scripts/verification-matrix.ts ingest-tester --run <run-record.json> --write",
    "```",
    "",
  );

  return lines.join("\n");
}
