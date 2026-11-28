import { UPDATE_RELEASE_REPO } from "../src/shared/limits.ts";
import { AGENT_VENDORS } from "../src/shared/vendors.ts";
import { VERIFICATION_PLATFORMS, type VerificationMatrix } from "./verification-matrix-model.ts";
import type { GitHubWorkflowRunMetadata } from "./verification-matrix-runs.ts";

const WINDOWS_CORE_STEP = "Run cross-platform core unit tests on Windows";
export const WINDOWS_MOCK_STEP = "Run mock-LLM unit and real-CLI tests on Windows";
export const FIXTURE_JOB_ID = 202;
const COMMIT = "1234567890abcdef1234567890abcdef12345678";

export function metadataFixture(releaseVersion = "1.2.3"): VerificationMatrix {
  return {
    schemaVersion: 1,
    releaseVersion,
    commit: COMMIT,
    recordedAt: "2026-01-01",
    surfaces: [{
      id: "windows-ci", label: "Windows CI", platform: "windows", cliKind: "real", modelBackend: "mock_llm",
      workflowOrCommand: ".github/workflows/windows.yml", scope: "Windows mock model tests",
    }],
    recordedRuns: [{
      id: "fixture-windows", source: "windows.yml", platform: "windows", kind: "real_cli_mock_llm", commit: COMMIT,
      urlOrRef: `https://github.com/${UPDATE_RELEASE_REPO}/actions/runs/101`, completedAt: "2026-01-01", vendors: ["codex", "pi"],
    }],
    cells: AGENT_VENDORS.flatMap((vendor) => VERIFICATION_PLATFORMS.map((platform) => ({
      vendor, platform, tier: "unverified", gapReason: "No recorded evidence for this cell.", fallbackTests: [],
    }))),
  };
}

export const FIXTURE_METADATA: GitHubWorkflowRunMetadata = {
  id: 101,
  head_sha: COMMIT,
  path: ".github/workflows/windows.yml",
  status: "completed", conclusion: "success",
  jobs: [{
    id: FIXTURE_JOB_ID, name: "windows (fusa-win-helper & integration)", labels: ["windows-latest"],
    status: "completed", conclusion: "success",
    steps: [WINDOWS_CORE_STEP, WINDOWS_MOCK_STEP].map((name) => ({ name, status: "completed", conclusion: "success" })),
  }],
};
