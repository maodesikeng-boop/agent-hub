import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { UPDATE_RELEASE_REPO } from "../src/shared/limits.ts";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import {
  parseGitHubRunUrl,
  parseVerificationMatrix,
  renderVerificationMatrixMarkdown,
  runVerificationMatrixCli,
  runVerificationMatrixCliAsync,
  verifyRecordedRunsOnline,
  type GitHubRunFetcher,
  type GitHubWorkflowRunMetadata,
  type VerificationMatrix,
} from "./verification-matrix.ts";
import { FIXTURE_JOB_ID, FIXTURE_METADATA, WINDOWS_MOCK_STEP, metadataFixture } from "./verification-matrix-runs.fixture.ts";

const cargoPath = "apps/windows/Cargo.toml";
const matrixPath = "docs/verification-matrix.json";
const markdownPath = "docs/verification-matrix.md";
const workflowsPath = ".github/workflows";

function copyWorkflows(repoRoot: string): void {
  cpSync(join(REPO_ROOT, workflowsPath), join(repoRoot, workflowsPath), { recursive: true });
}

function writeMatrixRepo(repoRoot: string, matrix: VerificationMatrix): void {
  mkdirSync(join(repoRoot, dirname(matrixPath)), { recursive: true });
  mkdirSync(join(repoRoot, dirname(cargoPath)), { recursive: true });
  cpSync(join(REPO_ROOT, cargoPath), join(repoRoot, cargoPath));
  copyWorkflows(repoRoot);
  writeFileSync(join(repoRoot, matrixPath), JSON.stringify(matrix));
  writeFileSync(join(repoRoot, markdownPath), renderVerificationMatrixMarkdown(matrix));
}

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  strategy?: { matrix?: { shard?: string[] } };
  steps?: Array<{ name?: string; run?: string }>;
}

function snapshotFetcher(matrix: VerificationMatrix): GitHubRunFetcher {
  return async ({ runId }) => {
    const run = matrix.recordedRuns.find((item) => parseGitHubRunUrl(item.urlOrRef)?.runId === runId);
    if (!run) throw new Error(`No recorded run ${runId} in the test matrix`);
    const path = `${workflowsPath}/${run.source}`;
    const { jobs } = parseYaml(readFileSync(join(REPO_ROOT, path), "utf8")) as { jobs: Record<string, WorkflowJob> };
    const success = { status: "completed", conclusion: "success" };
    const jobMetadata = Object.entries(jobs).filter(([, job]) => job["runs-on"]).flatMap(([key, job]) =>
      (job.strategy?.matrix?.shard ?? [""]).map((shard) => ({
        name: (job.name ?? key).replaceAll("${{ matrix.shard }}", shard),
        labels: [job["runs-on"]!],
        steps: (job.steps ?? []).flatMap(({ name, run }) => {
          const stepName = name ?? (run && `Run ${run.split("\n")[0]}`);
          return stepName ? [{ ...success, name: stepName.replaceAll("${{ matrix.shard }}", shard) }] : [];
        }),
        ...success,
      })),
    );
    const jobId = parseGitHubRunUrl(run.urlOrRef)?.jobId;
    return { id: Number(runId), head_sha: run.commit, path, ...success, jobs: jobMetadata.map((job, index) => ({
      ...job, id: index === 0 && jobId ? Number(jobId) : index + 1,
    })) };
  };
}

function withFixtureJob(job: Partial<GitHubWorkflowRunMetadata["jobs"][number]>): GitHubWorkflowRunMetadata {
  return { ...FIXTURE_METADATA, jobs: [{ ...FIXTURE_METADATA.jobs[0]!, ...job }] };
}

describe("verification-matrix online run verification (--verify-runs)", () => {
  it.each([undefined, FIXTURE_JOB_ID])("checks the required Windows mock test step (job %s)", async (jobId) => {
    const matrix = metadataFixture();
    const run = matrix.recordedRuns[0]!;
    const scoped = { ...matrix, recordedRuns: [{ ...run, urlOrRef: jobId ? `${run.urlOrRef}/job/${jobId}` : run.urlOrRef }] };
    expect(await verifyRecordedRunsOnline(scoped, { fetcher: async () => FIXTURE_METADATA })).toEqual([]);

    const steps = FIXTURE_METADATA.jobs[0]!.steps;
    for (const conclusion of ["skipped", "failure", "cancelled", null]) {
      const problems = await verifyRecordedRunsOnline(scoped, {
        fetcher: async () => withFixtureJob({
          steps: steps.map((step) => step.name === WINDOWS_MOCK_STEP ? { ...step, conclusion } : step),
        }),
      });
      expect(problems).toEqual([expect.objectContaining({
        code: "unverified_run_evidence", message: expect.stringContaining(`conclusion=${String(conclusion)}`),
      })]);
    }
    const missingStep = await verifyRecordedRunsOnline(scoped, {
      fetcher: async () => withFixtureJob({ steps: steps.filter((step) => step.name !== WINDOWS_MOCK_STEP) }),
    });
    expect(missingStep).toEqual([expect.objectContaining({
      code: "unverified_run_evidence", message: expect.stringContaining(WINDOWS_MOCK_STEP),
    })]);
  });

  it.each([
    ["wrong SHA", { ...FIXTURE_METADATA, head_sha: "a".repeat(40) }, "unverified_run_evidence", ".commit"],
    ["wrong workflow", { ...FIXTURE_METADATA, path: ".github/workflows/check.yml" }, "workflow_mismatch", ".source"],
    ["wrong platform", withFixtureJob({ labels: ["ubuntu-latest"] }), "platform_mismatch", ".platform"],
    ["failed run", { ...FIXTURE_METADATA, conclusion: "failure" }, "unverified_run_evidence", ".urlOrRef"],
    ["skipped job", withFixtureJob({ conclusion: "skipped" }), "platform_mismatch", ".platform"],
  ] as const)("rejects mismatched metadata: %s", async (_label, metadata, code, field) => {
    const problems = await verifyRecordedRunsOnline(metadataFixture(), { fetcher: async () => metadata });
    expect(problems).toEqual([expect.objectContaining({ code, path: `recordedRuns[0]${field}` })]);
  });

  it("rejects a job URL for a job absent from the run", async () => {
    const matrix = metadataFixture();
    const run = matrix.recordedRuns[0]!;
    const badJob = { ...matrix, recordedRuns: [{ ...run, urlOrRef: `${run.urlOrRef}/job/999999` }] };
    expect(await verifyRecordedRunsOnline(badJob, { fetcher: async () => FIXTURE_METADATA })).toEqual([
      expect.objectContaining({ code: "unverified_run_evidence", message: expect.stringContaining("does not contain job") }),
    ]);
  });

  it("makes the CLI fail closed on missing labels, verification errors, and HTTP errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "bellwood-matrix-metadata-"));
    try {
      const { releaseVersion } = parseVerificationMatrix(JSON.parse(readFileSync(join(REPO_ROOT, matrixPath), "utf8")) as unknown);
      writeMatrixRepo(root, metadataFixture(releaseVersion));
      const check = (runFetcher: GitHubRunFetcher) =>
        runVerificationMatrixCliAsync(["check", "--verify-runs"], { repoRoot: root, runFetcher });
      expect(await check(async () => FIXTURE_METADATA)).toBe(0);
      expect(await check(async () => withFixtureJob({ labels: undefined! }))).toBe(1);
      expect(await check(async () => ({
        ...FIXTURE_METADATA,
        get head_sha(): string { throw new Error("metadata error"); },
      }))).toBe(1);
      expect(await check(async () => { throw new Error("HTTP 404 Not Found"); })).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the repository snapshot without a fixed set of Actions run IDs", async () => {
    const matrix = parseVerificationMatrix(JSON.parse(readFileSync(join(REPO_ROOT, matrixPath), "utf8")) as unknown);
    expect(runVerificationMatrixCli(["check"], { repoRoot: REPO_ROOT })).toBe(0);
    expect(await runVerificationMatrixCliAsync(["check", "--verify-runs"], {
      repoRoot: REPO_ROOT, runFetcher: snapshotFetcher(matrix),
    })).toBe(0);

    const macRun = {
      id: "gh-run:46132355370",
      source: "mac-desktop.yml",
      platform: "macos",
      kind: "fake_cli_offline",
      commit: matrix.commit,
      urlOrRef: `https://github.com/${UPDATE_RELEASE_REPO}/actions/runs/46132355370`,
      completedAt: matrix.recordedAt,
    } as const;
    const extended = { ...matrix, recordedRuns: [...matrix.recordedRuns.filter((run) => run.id !== macRun.id), macRun] };
    const root = mkdtempSync(join(tmpdir(), "bellwood-matrix-extended-"));
    try {
      writeMatrixRepo(root, extended);
      expect(await runVerificationMatrixCliAsync(["check", "--verify-runs"], {
        repoRoot: root, runFetcher: snapshotFetcher(extended),
      })).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects bad release links and validates tester evidence in a copied repository", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "bellwood-release-downloads-guard-"));
    try {
      const files = [
        "README.md",
        "README.zh-CN.md",
        "docs/verification-matrix.json",
        "docs/verification-matrix.md",
        "apps/windows/Cargo.toml",
        "apps/windows/crates/fusa-desktop/tauri.conf.json",
        "apps/windows/crates/fusa-desktop/tauri.bundle.conf.json",
        "scripts/build-mac-app.sh",
        "scripts/stage-mac-runtime.ts",
        "scripts/stage-win-runtime.ts",
        "scripts/stage-runtime-common.ts",
        "src/feishu/main.ts",
        ".github/release-downloads.md",
      ];
      for (const rel of files) {
        const dst = join(tmpRoot, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        writeFileSync(dst, readFileSync(join(REPO_ROOT, rel)));
      }
      copyWorkflows(tmpRoot);
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(0);

      const dlPath = join(tmpRoot, ".github", "release-downloads.md");
      const origDl = readFileSync(dlPath, "utf8");
      writeFileSync(dlPath, origDl.replace("{{RELEASE_REF}}", "develop"));
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(1);
      writeFileSync(dlPath, origDl.replace("{{RELEASE_REF}}", "v0.4.0"));
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(1);
      writeFileSync(dlPath, origDl);

      const runDir = join(tmpRoot, "tester runs with space");
      const flowDir = join(runDir, "model.turn.claude@local");
      mkdirSync(flowDir, { recursive: true });
      writeFileSync(join(flowDir, "state reply.json"), '{"ok":true}\n');
      const runFile = join(runDir, "run-record.json");
      const validRun = {
        runId: "20261128T110000Z-nightly",
        cadence: "nightly",
        startedAt: "2026-11-28T11:00:00Z",
        finishedAt: "2026-11-28T11:05:00Z",
        commits: { local: "6f6eed4107d8a7cc77a0a615c72fba59b1cc77c7" },
        preflight: {
          available: ["local_instance"],
          problems: [],
          coverage: [{ vendor: "claude", instance: "local", status: "ready", version: "2.1.332", detail: "ok", fix: "" }],
        },
        results: [
          {
            id: "model.turn.claude@local",
            verdict: "pass",
            reason: "ok",
            checks: [{ check: "reply-arrives", ok: true, detail: "replied" }],
            externalErrors: [],
            metrics: {},
            evidence: ["state reply.json"],
            startedAt: "2026-11-28T11:01:00Z",
            durationMs: 1200,
          },
        ],
      };
      writeFileSync(runFile, JSON.stringify(validRun));
      expect(runVerificationMatrixCli(["ingest-tester", "--run", runFile, "--write"], { repoRoot: tmpRoot })).toBe(0);
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(0);

      writeFileSync(
        runFile,
        JSON.stringify({ ...validRun, results: [{ ...validRun.results[0]!, evidence: ["missing-artifact.json"] }] }),
      );
      expect(runVerificationMatrixCli(["ingest-tester", "--run", runFile], { repoRoot: tmpRoot })).toBe(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
