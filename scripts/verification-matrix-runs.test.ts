import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./stage-runtime-common.ts";
import {
  parseVerificationMatrix,
  runVerificationMatrixCli,
  runVerificationMatrixCliAsync,
  verifyRecordedRunsOnline,
  type GitHubRunFetcher,
  type GitHubWorkflowRunMetadata,
} from "./verification-matrix.ts";

const REPO_MATRIX_PATH = join(REPO_ROOT, "docs", "verification-matrix.json");

function loadRepoMatrix() {
  return parseVerificationMatrix(JSON.parse(readFileSync(REPO_MATRIX_PATH, "utf8")) as unknown);
}

function validFetcherForRepoMatrix(): GitHubRunFetcher {
  const byRunId: Record<string, GitHubWorkflowRunMetadata> = {
    "46132355340": {
      id: 46132355340,
      head_sha: "6f6eed4107d8a7cc77a0a615c72fba59b1cc77c7",
      path: ".github/workflows/check.yml",
      status: "completed",
      conclusion: "success",
      jobs: [{ id: 140940083341, name: "check (ubuntu 1/4)", status: "completed", conclusion: "success", labels: ["ubuntu-latest"] }],
    },
    "46132355360": {
      id: 46132355360,
      head_sha: "6f6eed4107d8a7cc77a0a615c72fba59b1cc77c7",
      path: ".github/workflows/windows.yml",
      status: "completed",
      conclusion: "success",
      jobs: [
        {
          id: 140940083042,
          name: "windows (fusa-win-helper & integration)",
          status: "completed",
          conclusion: "success",
          labels: ["windows-latest"],
        },
      ],
    },
  };
  return async (ref) => {
    const found = byRunId[ref.runId];
    if (!found) throw new Error(`Run ${ref.runId} not found`);
    return found;
  };
}

describe("verification-matrix online run verification (--verify-runs)", () => {
  it("passes when recorded Actions runs match head_sha, workflow path, conclusion, and passing job platform", async () => {
    const matrix = loadRepoMatrix();
    const problems = await verifyRecordedRunsOnline(matrix, { fetcher: validFetcherForRepoMatrix() });
    expect(problems).toEqual([]);
  });

  it("rejects counterexamples where self-reported fields match but linked Actions run metadata disagrees", async () => {
    const matrix = loadRepoMatrix();

    const wrongShaProblems = await verifyRecordedRunsOnline(matrix, {
      fetcher: async (ref) => {
        const meta = await validFetcherForRepoMatrix()(ref);
        return ref.runId === "46132355360" ? { ...meta, head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } : meta;
      },
    });
    expect(wrongShaProblems.some((p) => p.code === "unverified_run_evidence" && p.path.includes("commit"))).toBe(true);

    const wrongWorkflowProblems = await verifyRecordedRunsOnline(matrix, {
      fetcher: async (ref) => {
        const meta = await validFetcherForRepoMatrix()(ref);
        return ref.runId === "46132355360" ? { ...meta, path: ".github/workflows/check.yml" } : meta;
      },
    });
    expect(wrongWorkflowProblems.some((p) => p.code === "workflow_mismatch" && p.path.includes("source"))).toBe(true);

    const wrongPlatformProblems = await verifyRecordedRunsOnline(matrix, {
      fetcher: async (ref) => {
        const meta = await validFetcherForRepoMatrix()(ref);
        return ref.runId === "46132355360"
          ? { ...meta, jobs: [{ id: 1, name: "ubuntu-job", status: "completed", conclusion: "success", labels: ["ubuntu-latest"] }] }
          : meta;
      },
    });
    expect(wrongPlatformProblems.some((p) => p.code === "platform_mismatch" && p.path.includes("platform"))).toBe(true);

    const failedRunProblems = await verifyRecordedRunsOnline(matrix, {
      fetcher: async (ref) => {
        const meta = await validFetcherForRepoMatrix()(ref);
        return ref.runId === "46132355340" ? { ...meta, conclusion: "failure" } : meta;
      },
    });
    expect(failedRunProblems.some((p) => p.code === "unverified_run_evidence")).toBe(true);

    const skippedPlatformJobProblems = await verifyRecordedRunsOnline(matrix, {
      fetcher: async (ref) => {
        const meta = await validFetcherForRepoMatrix()(ref);
        return ref.runId === "46132355360"
          ? { ...meta, jobs: [{ id: 2, name: "win-job", status: "completed", conclusion: "skipped", labels: ["windows-latest"] }] }
          : meta;
      },
    });
    expect(skippedPlatformJobProblems.some((p) => p.code === "platform_mismatch")).toBe(true);

    const jobUrlMatrix = {
      ...matrix,
      recordedRuns: matrix.recordedRuns.map((run) =>
        run.id === "gh-run:46132355360:mock-llm" ? { ...run, urlOrRef: `${run.urlOrRef}/job/999999` } : run,
      ),
    };
    const badJobProblems = await verifyRecordedRunsOnline(jobUrlMatrix, { fetcher: validFetcherForRepoMatrix() });
    expect(badJobProblems.some((p) => p.code === "unverified_run_evidence")).toBe(true);
  });

  it("keeps offline check working without network while check --verify-runs enforces fetched metadata and rejects bad release links", async () => {
    expect(runVerificationMatrixCli(["check"], { repoRoot: REPO_ROOT })).toBe(0);
    expect(await runVerificationMatrixCliAsync(["check", "--verify-runs"], { repoRoot: REPO_ROOT, runFetcher: validFetcherForRepoMatrix() })).toBe(0);
    expect(
      await runVerificationMatrixCliAsync(["check", "--verify-runs"], {
        repoRoot: REPO_ROOT,
        runFetcher: async () => {
          throw new Error("HTTP 404 Not Found");
        },
      }),
    ).toBe(1);

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
        ".github/workflows/check.yml",
        ".github/workflows/macos.yml",
        ".github/workflows/windows.yml",
        ".github/workflows/nightly.yml",
        ".github/release-downloads.md",
      ];
      for (const rel of files) {
        const dst = join(tmpRoot, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        writeFileSync(dst, readFileSync(join(REPO_ROOT, rel)));
      }
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
