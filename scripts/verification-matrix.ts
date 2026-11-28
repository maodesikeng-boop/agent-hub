// Invariant: every registered vendor in AGENT_VENDORS x every platform in VERIFICATION_PLATFORMS has exactly one cell;
// static workflow configs never substitute for commit-bound run records, and rendered Markdown matches JSON byte-for-byte.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml } from "yaml";
import { AGENT_VENDORS, isAgentVendor, type AgentVendor } from "../src/shared/vendors.ts";
import type { VendorEndpointSupport } from "../test/mock-llm/types.ts";
import { VENDOR_MOCK_ADAPTERS } from "../test/mock-llm/vendors.ts";
import type { InstanceRole, RunRecord } from "../test/tester/types.ts";
import { VENDOR_BENCH } from "../test/tester/vendors.ts";
import { REPO_ROOT, readDesktopAppVersion } from "./stage-runtime-common.ts";
import {
  packagedFeishuCommands,
  readPackagedFeishuLayout,
  validateFeishuQuickStartDocs,
  type PackagedFeishuCommands,
  type PackagedFeishuLayout,
} from "./verification-matrix-feishu.ts";
import {
  COMMIT_SHA_RE,
  FORBIDDEN_REFERENCE_RE,
  PLACEHOLDER_VALUE_RE,
  VERIFICATION_FIELD_MAX_CHARS,
  VERIFICATION_MATRIX_MAX_BYTES,
  VERIFICATION_MAX_FALLBACK_TESTS,
  VERIFICATION_MAX_RECORDED_RUNS,
  VERIFICATION_MAX_SURFACES,
  VERIFICATION_PLATFORMS,
  VERIFICATION_TIERS,
  commitsAlign,
  containsSecret,
  isValidConcreteCliVersion,
  isValidIsoDate,
  parseVerificationMatrix,
  redactText,
  renderVerificationMatrixMarkdown,
  type FakeCliOfflineCell,
  type GapCell,
  type LiveServiceCell,
  type MatrixValidationCode,
  type MatrixValidationProblem,
  type RealCliMockLlmCell,
  type RepoVerificationFacts,
  type VerificationCell,
  type VerificationCellBase,
  type VerificationMatrix,
  type VerificationPlatform,
  type VerificationRunRecord,
  type VerificationSurfaceSummary,
  type VerificationTier,
  type WorkflowRealCliPlatformMap,
} from "./verification-matrix-model.ts";

export {
  VERIFICATION_FIELD_MAX_CHARS,
  VERIFICATION_MATRIX_MAX_BYTES,
  VERIFICATION_MAX_FALLBACK_TESTS,
  VERIFICATION_MAX_RECORDED_RUNS,
  VERIFICATION_MAX_SURFACES,
  VERIFICATION_PLATFORMS,
  VERIFICATION_TIERS,
  packagedFeishuCommands,
  parseVerificationMatrix,
  readPackagedFeishuLayout,
  renderVerificationMatrixMarkdown,
  validateFeishuQuickStartDocs,
  type FakeCliOfflineCell,
  type GapCell,
  type LiveServiceCell,
  type MatrixValidationCode,
  type MatrixValidationProblem,
  type PackagedFeishuCommands,
  type PackagedFeishuLayout,
  type RealCliMockLlmCell,
  type RepoVerificationFacts,
  type VerificationCell,
  type VerificationCellBase,
  type VerificationMatrix,
  type VerificationPlatform,
  type VerificationRunRecord,
  type VerificationSurfaceSummary,
  type VerificationTier,
  type WorkflowRealCliPlatformMap,
};

const STATIC_WORKFLOW_PATH_RE = /^(?:\.?\/)?\.github\/workflows\/|^[^/:\\]+\.ya?ml$/i;
const GITHUB_RUN_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/job\/\d+)?$/;
const TESTER_CELL_REF_RE = /^tester:([^:\s]+):model\.turn\.([a-z0-9_-]+)@(local|remote)#([^\s#]+)$/;
const TESTER_RUN_ID_RE = /^tester:([^:\s]+)@(local|remote)$/;
const TRACEABLE_LIVE_REF_RE = /^(?:https:\/\/\S+|tester:[^:\s]+:model\.turn\.[a-z0-9_-]+@(?:local|remote)#[^\s#]+|tester:[^:\s]+@(?:local|remote)|local-run:\S+)$/;

const isStaticWorkflowPath = (ref: string): boolean => STATIC_WORKFLOW_PATH_RE.test(ref.trim());
const isWorkflowFilename = (source: string): boolean => /\.ya?ml$/i.test(source.trim());

interface ParsedWorkflowJob {
  "runs-on"?: string | string[];
  env?: Record<string, unknown>;
  steps?: Array<{ env?: Record<string, unknown> }>;
}

interface ParsedWorkflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, ParsedWorkflowJob>;
}

function platformsFromRunsOn(runsOn: string | string[] | undefined): VerificationPlatform[] {
  const labels = Array.isArray(runsOn) ? runsOn : typeof runsOn === "string" ? [runsOn] : [];
  const found = new Set<VerificationPlatform>();
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower.startsWith("ubuntu") || lower.includes("linux")) found.add("linux");
    else if (lower.startsWith("windows")) found.add("windows");
    else if (lower.startsWith("macos")) found.add("macos");
  }
  return [...found].sort();
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

function scanWorkflows(workflowsDir: string): {
  realCliVendors: Record<string, readonly AgentVendor[]>;
  platforms: Record<string, readonly VerificationPlatform[]>;
  realCliPlatforms: Record<string, Partial<Record<VerificationPlatform, readonly AgentVendor[]>>>;
} {
  const realCliVendors: Record<string, readonly AgentVendor[]> = {};
  const platforms: Record<string, readonly VerificationPlatform[]> = {};
  const realCliPlatforms: Record<string, Partial<Record<VerificationPlatform, readonly AgentVendor[]>>> = {};
  const files = readdirSync(workflowsDir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort();
  for (const file of files) {
    const parsed = parseYaml(readFileSync(join(workflowsDir, file), "utf8")) as ParsedWorkflow | null;
    if (!parsed || typeof parsed !== "object") continue;
    const wfVendors = new Set<AgentVendor>();
    const wfPlatforms = new Set<VerificationPlatform>();
    const byPlatform: Partial<Record<VerificationPlatform, Set<AgentVendor>>> = {};
    const topEnvVendors = new Set<AgentVendor>();
    collectEnvRealCli(parsed.env, topEnvVendors, file);
    for (const v of topEnvVendors) wfVendors.add(v);

    for (const job of Object.values(parsed.jobs ?? {})) {
      if (!job || typeof job !== "object") continue;
      const jobPlatforms = platformsFromRunsOn(job["runs-on"]);
      for (const p of jobPlatforms) wfPlatforms.add(p);
      const jobVendors = new Set<AgentVendor>(topEnvVendors);
      collectEnvRealCli(job.env, jobVendors, file);
      for (const step of job.steps ?? []) collectEnvRealCli(step?.env, jobVendors, file);
      for (const v of jobVendors) wfVendors.add(v);
      if (jobVendors.size > 0) {
        for (const p of jobPlatforms) {
          byPlatform[p] ??= new Set<AgentVendor>();
          for (const v of jobVendors) byPlatform[p]!.add(v);
        }
      }
    }
    if (wfPlatforms.size > 0) platforms[file] = [...wfPlatforms].sort();
    if (wfVendors.size > 0) realCliVendors[file] = [...wfVendors].sort();
    const mapped = Object.fromEntries(
      Object.entries(byPlatform).map(([p, set]) => [p, [...set!].sort()]),
    ) as Partial<Record<VerificationPlatform, readonly AgentVendor[]>>;
    if (Object.keys(mapped).length > 0) realCliPlatforms[file] = mapped;
  }
  return { realCliVendors, platforms, realCliPlatforms };
}

export function readWorkflowRealCliVendors(workflowsDir: string): Readonly<Record<string, readonly AgentVendor[]>> {
  return scanWorkflows(workflowsDir).realCliVendors;
}

export function readWorkflowPlatforms(workflowsDir: string): Readonly<Record<string, readonly VerificationPlatform[]>> {
  return scanWorkflows(workflowsDir).platforms;
}

export function readWorkflowRealCliPlatforms(workflowsDir: string): WorkflowRealCliPlatformMap {
  return scanWorkflows(workflowsDir).realCliPlatforms;
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

function matchesTesterCellRef(cell: LiveServiceCell, run: VerificationRunRecord): boolean {
  const runMatch = TESTER_RUN_ID_RE.exec(run.id);
  const cellMatch = TESTER_CELL_REF_RE.exec(cell.evidenceRef);
  if (!runMatch || !cellMatch) return false;
  return runMatch[1] === cellMatch[1] && cellMatch[2] === cell.vendor && runMatch[2] === cellMatch[3];
}

function validateRecordedRuns(
  matrix: VerificationMatrix,
  facts: RepoVerificationFacts,
  problems: MatrixValidationProblem[],
): VerificationRunRecord[] {
  const runs = matrix.recordedRuns ?? [];
  if (runs.length > VERIFICATION_MAX_RECORDED_RUNS) {
    addProblem(problems, "recordedRuns", "invalid_schema", `recordedRuns exceeds max length ${VERIFICATION_MAX_RECORDED_RUNS}`);
  }
  const seenIds = new Set<string>();
  const validRuns: VerificationRunRecord[] = [];
  for (let idx = 0; idx < runs.length; idx += 1) {
    const run = runs[idx]!;
    const path = `recordedRuns[${idx}]`;
    const before = problems.length;
    checkRequiredText(`${path}.id`, run.id, "recordedRun id", problems);
    checkRequiredText(`${path}.source`, run.source, "recordedRun source", problems);
    checkRequiredText(`${path}.urlOrRef`, run.urlOrRef, "recordedRun urlOrRef", problems);
    if (seenIds.has(run.id)) addProblem(problems, `${path}.id`, "invalid_schema", `Duplicate recordedRun id "${run.id}"`);
    seenIds.add(run.id);
    if (!VERIFICATION_PLATFORMS.includes(run.platform)) {
      addProblem(problems, `${path}.platform`, "unknown_platform", `Unknown platform "${String(run.platform)}"`);
    }
    if (!isValidIsoDate(run.completedAt)) {
      addProblem(problems, `${path}.completedAt`, "invalid_date", `Invalid ISO date "${run.completedAt}"`);
    }
    if (!commitsAlign(run.commit, matrix.commit)) {
      addProblem(
        problems,
        `${path}.commit`,
        "unverified_run_evidence",
        `Recorded run "${run.id}" commit "${run.commit}" does not match matrix commit "${matrix.commit}"`,
      );
    }
    if (isStaticWorkflowPath(run.urlOrRef)) {
      addProblem(
        problems,
        `${path}.urlOrRef`,
        "unverified_run_evidence",
        `Recorded run "${run.id}" urlOrRef "${run.urlOrRef}" points to a static workflow config instead of a concrete run`,
      );
    }
    if (isWorkflowFilename(run.source)) {
      if (!GITHUB_RUN_URL_RE.test(run.urlOrRef)) {
        addProblem(
          problems,
          `${path}.urlOrRef`,
          "unverified_run_evidence",
          `Workflow run "${run.id}" must reference a GitHub Actions run URL, got "${run.urlOrRef}"`,
        );
      }
      const wfPlatforms = facts.workflowPlatforms?.[run.source];
      if (wfPlatforms && !wfPlatforms.includes(run.platform)) {
        addProblem(
          problems,
          `${path}.platform`,
          "platform_mismatch",
          `Workflow "${run.source}" runs on [${wfPlatforms.join(", ")}], not "${run.platform}"`,
        );
      }
      if (run.kind === "real_cli_mock_llm") {
        const configured = facts.workflowRealCliPlatforms?.[run.source]?.[run.platform] ?? facts.workflowRealCliVendors[run.source] ?? [];
        if (configured.length === 0) {
          addProblem(
            problems,
            `${path}.source`,
            "workflow_mismatch",
            `Workflow "${run.source}" does not configure real-CLI mock-LLM coverage on "${run.platform}"`,
          );
        }
        for (const vendor of run.vendors ?? []) {
          if (!configured.includes(vendor)) {
            addProblem(
              problems,
              `${path}.vendors`,
              "workflow_mismatch",
              `Workflow "${run.source}" on "${run.platform}" does not configure vendor "${vendor}"`,
            );
          }
        }
      }
    } else if (!TRACEABLE_LIVE_REF_RE.test(run.urlOrRef)) {
      addProblem(
        problems,
        `${path}.urlOrRef`,
        "unverified_run_evidence",
        `Recorded run "${run.id}" urlOrRef "${run.urlOrRef}" is not a traceable run reference`,
      );
    }
    if (problems.length === before) validRuns.push(run);
  }
  return validRuns;
}

function surfacePlatformForWorkflow(matrix: VerificationMatrix, workflow: string): VerificationPlatform | undefined {
  const hit = matrix.surfaces.find((s) => s.workflowOrCommand === workflow || s.workflowOrCommand.endsWith(`/${workflow}`));
  return hit && hit.platform !== "multi" ? hit.platform : undefined;
}

function validateLiveCell(
  cell: LiveServiceCell,
  path: string,
  validRuns: readonly VerificationRunRecord[],
  problems: MatrixValidationProblem[],
): void {
  for (const key of ["cliVersion", "model", "evidenceRef", "verifiedAt"] as const) {
    checkRequiredText(`${path}.${key}`, cell[key], `live_service ${key}`, problems);
  }
  if (!isValidConcreteCliVersion(cell.cliVersion)) {
    addProblem(problems, `${path}.cliVersion`, "invalid_cli_version", `live_service cliVersion must be a concrete non-unknown version, got "${cell.cliVersion}"`);
  }
  if (PLACEHOLDER_VALUE_RE.test(cell.model.trim())) {
    addProblem(problems, `${path}.model`, "missing_evidence", `live_service model must not be a placeholder ("${cell.model}")`);
  }
  if (cell.verifiedAt && !isValidIsoDate(cell.verifiedAt)) {
    addProblem(problems, `${path}.verifiedAt`, "invalid_date", `Invalid ISO date "${cell.verifiedAt}"`);
  }
  if (isStaticWorkflowPath(cell.evidenceRef) || !TRACEABLE_LIVE_REF_RE.test(cell.evidenceRef.trim())) {
    addProblem(problems, `${path}.evidenceRef`, "unverified_run_evidence", `live_service evidenceRef "${cell.evidenceRef}" must be a traceable run artifact`);
  } else {
    const matched = validRuns.some(
      (run) =>
        run.kind === "live_service" &&
        run.platform === cell.platform &&
        (!run.vendors || run.vendors.includes(cell.vendor)) &&
        (cell.evidenceRef === run.urlOrRef || cell.evidenceRef === run.id || matchesTesterCellRef(cell, run)),
    );
    if (!matched) {
      addProblem(
        problems,
        `${path}.evidenceRef`,
        "unverified_run_evidence",
        `live_service cell ${cell.vendor}@${cell.platform} lacks a matching same-commit live_service recordedRun`,
      );
    }
  }
  checkTextField(`${path}.note`, cell.note, problems);
}

function validateMockCell(
  cell: RealCliMockLlmCell,
  path: string,
  matrix: VerificationMatrix,
  facts: RepoVerificationFacts,
  validRuns: readonly VerificationRunRecord[],
  problems: MatrixValidationProblem[],
): void {
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
  const configuredAnyPlatform = facts.workflowRealCliVendors[cell.workflow] ?? [];
  if (!configuredAnyPlatform.includes(cell.vendor)) {
    addProblem(
      problems,
      `${path}.workflow`,
      "workflow_mismatch",
      `Workflow "${cell.workflow}" does not declare "${cell.vendor}" in BELLWOOD_REQUIRE_REAL_CLI`,
    );
  } else {
    const byPlatform = facts.workflowRealCliPlatforms?.[cell.workflow];
    const surfacePlatform = surfacePlatformForWorkflow(matrix, cell.workflow);
    if (byPlatform && !(byPlatform[cell.platform] ?? []).includes(cell.vendor)) {
      addProblem(
        problems,
        `${path}.platform`,
        "platform_mismatch",
        `Workflow "${cell.workflow}" does not run real CLI "${cell.vendor}" on platform "${cell.platform}"`,
      );
    } else if (!byPlatform && surfacePlatform && surfacePlatform !== cell.platform) {
      addProblem(
        problems,
        `${path}.platform`,
        "platform_mismatch",
        `Workflow "${cell.workflow}" targets "${surfacePlatform}", not "${cell.platform}"`,
      );
    }
  }

  if (isStaticWorkflowPath(cell.evidenceRef)) {
    addProblem(
      problems,
      `${path}.evidenceRef`,
      "unverified_run_evidence",
      `real_cli_mock_llm evidenceRef "${cell.evidenceRef}" points to a static workflow config instead of a commit-bound run`,
    );
  } else {
    const matched = validRuns.some(
      (run) =>
        run.kind === "real_cli_mock_llm" &&
        run.source === cell.workflow &&
        run.platform === cell.platform &&
        (!run.vendors || run.vendors.includes(cell.vendor)) &&
        (run.urlOrRef === cell.evidenceRef || run.id === cell.evidenceRef),
    );
    if (!matched) {
      addProblem(
        problems,
        `${path}.evidenceRef`,
        "unverified_run_evidence",
        `real_cli_mock_llm cell ${cell.vendor}@${cell.platform} lacks a matching same-commit recordedRun for ${cell.workflow}`,
      );
    }
  }
}

function validateCellFields(
  cell: VerificationCell,
  path: string,
  matrix: VerificationMatrix,
  facts: RepoVerificationFacts,
  validRuns: readonly VerificationRunRecord[],
  problems: MatrixValidationProblem[],
): void {
  if (cell.tier === "live_service") {
    validateLiveCell(cell, path, validRuns, problems);
    return;
  }

  if (cell.tier === "real_cli_mock_llm") {
    validateMockCell(cell, path, matrix, facts, validRuns, problems);
  } else {
    checkRequiredText(`${path}.gapReason`, cell.gapReason, `${cell.tier} gapReason`, problems);
    if (cell.tier === "fake_cli_offline") {
      checkTextField(`${path}.evidenceRef`, cell.evidenceRef, problems);
      if (cell.evidenceRef && isStaticWorkflowPath(cell.evidenceRef)) {
        addProblem(
          problems,
          `${path}.evidenceRef`,
          "unverified_run_evidence",
          `fake_cli_offline evidenceRef "${cell.evidenceRef}" must reference a commit-bound run, not a static workflow file`,
        );
      } else {
        const matched = validRuns.some(
          (run) =>
            run.kind === "fake_cli_offline" &&
            run.platform === cell.platform &&
            (!run.vendors || run.vendors.includes(cell.vendor)) &&
            (!cell.evidenceRef || run.urlOrRef === cell.evidenceRef || run.id === cell.evidenceRef),
        );
        if (!matched) {
          addProblem(
            problems,
            path,
            "unverified_run_evidence",
            `fake_cli_offline cell ${cell.vendor}@${cell.platform} lacks a matching same-commit recordedRun on ${cell.platform}`,
          );
        }
      }
    }
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
    const wfMatch = /^\.github\/workflows\/([^/\s]+\.ya?ml)$/.exec(surface.workflowOrCommand);
    if (wfMatch && surface.platform !== "multi" && facts.workflowPlatforms?.[wfMatch[1]!]) {
      const wfPlatforms = facts.workflowPlatforms[wfMatch[1]!]!;
      if (!wfPlatforms.includes(surface.platform)) {
        addProblem(
          problems,
          `surfaces[${idx}].platform`,
          "platform_mismatch",
          `Surface "${surface.id}" maps ${wfMatch[1]} to "${surface.platform}", but workflow runs on [${wfPlatforms.join(", ")}]`,
        );
      }
    }
  });

  const validRuns = validateRecordedRuns(matrix, facts, problems);
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
      validateCellFields(cell, path, matrix, facts, validRuns, problems);
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

export function ingestTesterRunRecord(
  matrix: VerificationMatrix,
  record: RunRecord,
  opts: {
    platformByInstance: Readonly<Record<InstanceRole, VerificationPlatform>>;
    recordedAt: string;
    commitKeyByInstance?: Partial<Record<InstanceRole, string>>;
  },
): VerificationMatrix {
  if (!isValidIsoDate(opts.recordedAt)) throw new Error(`Invalid recordedAt date "${opts.recordedAt}"`);
  if (!record || typeof record !== "object" || typeof record.runId !== "string" || record.runId.trim() === "") {
    throw new Error("Invalid RunRecord: missing runId");
  }
  if (!Array.isArray(record.results) || !record.preflight || !Array.isArray(record.preflight.coverage)) {
    throw new Error("Invalid RunRecord: missing results or preflight coverage");
  }
  const commits = record.commits ?? {};
  const recordedCommits = Object.entries(commits).filter(([, sha]) => typeof sha === "string" && sha.trim() !== "");
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

  const liveRunsByInstance = new Map<InstanceRole, { platform: VerificationPlatform; commit: string; vendors: Set<AgentVendor> }>();

  const nextCells: VerificationCell[] = matrix.cells.map((cell) => {
    const hit = turnUpdates.get(`${cell.vendor}:${cell.platform}`);
    if (!hit) return cell;
    const { vendor, instance, result } = hit;
    if (result.verdict === "pass") {
      const commitKey = opts.commitKeyByInstance?.[instance] ?? instance;
      const instanceCommit = commits[commitKey];
      if (typeof instanceCommit !== "string" || !commitsAlign(instanceCommit, matrix.commit)) {
        throw new Error(
          `RunRecord commit mismatch for instance "${instance}" (key "${commitKey}"): ${String(instanceCommit ?? "missing")} does not match matrix commit ${matrix.commit}`,
        );
      }
      const readiness = coverageByKey.get(`${vendor}:${instance}`);
      if (!readiness || !isValidConcreteCliVersion(readiness.version)) {
        throw new Error(
          `RunRecord missing valid non-unknown CLI version for ${vendor}@${instance} (got ${JSON.stringify(readiness?.version ?? null)})`,
        );
      }
      const evidenceItems = (Array.isArray(result.evidence) ? result.evidence : [])
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item !== "");
      if (evidenceItems.length === 0) {
        throw new Error(`RunRecord missing traceable evidence artifacts for passing turn ${result.id}`);
      }
      if (Array.isArray(result.checks) && result.checks.some((check) => !check.ok)) {
        throw new Error(`RunRecord passing turn ${result.id} contains a failing check`);
      }

      let liveRun = liveRunsByInstance.get(instance);
      if (!liveRun) {
        liveRun = { platform: cell.platform, commit: instanceCommit.trim().toLowerCase(), vendors: new Set() };
        liveRunsByInstance.set(instance, liveRun);
      }
      liveRun.vendors.add(vendor);

      const recipe = VENDOR_BENCH[vendor][instance];
      const model = recipe.coverage === "turn" && recipe.model ? recipe.model : "vendor default";
      const note = result.reason ? redactText(`Run ${record.runId} (${record.cadence}): ${result.reason}`) : undefined;
      return {
        vendor,
        platform: cell.platform,
        tier: "live_service",
        cliVersion: redactText(readiness.version),
        model: redactText(model),
        evidenceRef: redactText(`tester:${record.runId}:${result.id}#${evidenceItems[0]}`),
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

  const runsById = new Map((matrix.recordedRuns ?? []).map((run) => [run.id, run]));
  for (const [instance, info] of liveRunsByInstance) {
    const id = redactText(`tester:${record.runId}@${instance}`);
    runsById.set(id, {
      id,
      source: "pnpm tester",
      platform: info.platform,
      kind: "live_service",
      commit: info.commit,
      urlOrRef: id,
      completedAt: opts.recordedAt,
      vendors: [...info.vendors].sort(),
    });
  }

  return { ...matrix, recordedAt: opts.recordedAt, recordedRuns: [...runsById.values()], cells: nextCells };
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
  const scanned = scanWorkflows(join(repoRoot, ".github", "workflows"));
  return {
    vendors: AGENT_VENDORS,
    mockSupportByVendor,
    workflowRealCliVendors: scanned.realCliVendors,
    workflowPlatforms: scanned.platforms,
    workflowRealCliPlatforms: scanned.realCliPlatforms,
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
    try {
      const layout = readPackagedFeishuLayout(repoRoot);
      const docProblems = validateFeishuQuickStartDocs({
        readmeEn: readFileSync(readmeEnPath, "utf8"),
        readmeZh: readFileSync(readmeZhPath, "utf8"),
        commands: packagedFeishuCommands(layout),
      });
      for (const msg of docProblems) addProblem(problems, "README", "missing_evidence", msg);
    } catch (error) {
      addProblem(problems, "packaging", "missing_evidence", error instanceof Error ? error.message : String(error));
    }
  }

  const releaseDownloadsPath = join(repoRoot, ".github", "release-downloads.md");
  if (existsSync(releaseDownloadsPath)) {
    const downloads = readFileSync(releaseDownloadsPath, "utf8");
    if (/\/blob\/(?:main|master|HEAD)\/docs\/verification-matrix\.md\b/.test(downloads)) {
      addProblem(
        problems,
        ".github/release-downloads.md",
        "unverified_run_evidence",
        "Release downloads template must pin docs/verification-matrix.md to the release tag instead of a floating branch",
      );
    }
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
  "  | ingest-tester --run <run-record.json> [--date YYYY-MM-DD] [--local-commit-key <name>] [--remote-commit-key <name>] [--write]",
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
      const commitKeyByInstance: Partial<Record<InstanceRole, string>> = {};
      const localKey = flags.get("local-commit-key");
      const remoteKey = flags.get("remote-commit-key");
      if (localKey && localKey !== "true") commitKeyByInstance.local = localKey;
      if (remoteKey && remoteKey !== "true") commitKeyByInstance.remote = remoteKey;
      const updated = ingestTesterRunRecord(matrix, record, {
        platformByInstance: { local: "macos", remote: "linux" },
        recordedAt,
        ...(Object.keys(commitKeyByInstance).length > 0 ? { commitKeyByInstance } : {}),
      });
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
