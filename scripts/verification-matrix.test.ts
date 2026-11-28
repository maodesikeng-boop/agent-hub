import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { AGENT_VENDORS, type AgentVendor } from "../src/shared/vendors.ts";
import { VENDOR_MOCK_ADAPTERS } from "../test/mock-llm/vendors.ts";
import type { VendorEndpointSupport } from "../test/mock-llm/types.ts";
import type { RunRecord } from "../test/tester/types.ts";
import { VENDOR_BENCH } from "../test/tester/vendors.ts";
import { collectDaemonRuntimeDependencyNames, REPO_ROOT, readDesktopAppVersion } from "./stage-runtime-common.ts";
import { ALWAYS_RUN_TESTS } from "./test-related.ts";
import {
  VERIFICATION_FIELD_MAX_CHARS,
  VERIFICATION_MATRIX_MAX_BYTES,
  VERIFICATION_MAX_FALLBACK_TESTS,
  VERIFICATION_MAX_RECORDED_RUNS,
  VERIFICATION_MAX_SURFACES,
  VERIFICATION_PLATFORMS,
  VERIFICATION_TIERS,
  ingestTesterRunRecord,
  packagedFeishuCommands,
  parseVerificationMatrix,
  readPackagedFeishuLayout,
  readWorkflowPlatforms,
  readWorkflowRealCliPlatforms,
  readWorkflowRealCliVendors,
  renderVerificationMatrixMarkdown,
  runVerificationMatrixCli,
  validateFeishuQuickStartDocs,
  validateVerificationMatrix,
  type PackagedFeishuLayout,
  type RepoVerificationFacts,
  type VerificationCell,
  type VerificationMatrix,
  type VerificationPlatform,
} from "./verification-matrix.ts";

const TEST_COMMIT = "6f6eed41";
const TEST_DATE = "2026-11-28";

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

function mockSupportMap(): Record<AgentVendor, VendorEndpointSupport> {
  return Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, VENDOR_MOCK_ADAPTERS[vendor].support])) as Record<
    AgentVendor,
    VendorEndpointSupport
  >;
}

const TEST_WIN_RUN_URL = "https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355360";
const TEST_NIGHTLY_RUN_URL = "https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132399999";
const TEST_CHECK_RUN_URL = "https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132355340";
const TEST_MAC_RUN_URL = "https://github.com/maodesikeng-boop/agent-hub/actions/runs/46132388888";

function buildValidMatrix(overrides: Partial<VerificationMatrix> = {}): VerificationMatrix {
  const cells: VerificationCell[] = [];
  for (const vendor of AGENT_VENDORS) {
    for (const platform of VERIFICATION_PLATFORMS) {
      if (platform === "windows" && (vendor === "codex" || vendor === "pi")) {
        cells.push({
          vendor,
          platform,
          tier: "real_cli_mock_llm",
          cliVersion: vendor === "codex" ? "0.169.0" : "1.5.2",
          workflow: "windows.yml",
          command: "BELLWOOD_REQUIRE_REAL_CLI=codex,pi pnpm exec vitest run --project=node test/mock-llm/real-cli-e2e.test.ts",
          evidenceRef: TEST_WIN_RUN_URL,
          gapReason: "Mock LLM backend only; no resident Windows live-account bench exists.",
          fallbackTests: ["test/mock-llm/real-cli-e2e.test.ts", "src/vendors/contract.test.ts"],
        });
      } else if (platform === "linux" && (vendor === "claude" || vendor === "codex" || vendor === "pi" || vendor === "deepseek")) {
        cells.push({
          vendor,
          platform,
          tier: "real_cli_mock_llm",
          cliVersion: vendor === "deepseek" ? "0.2.2-rc.1" : "latest",
          workflow: "nightly.yml",
          command: "BELLWOOD_REQUIRE_REAL_CLI=claude,codex,pi,deepseek pnpm exec vitest run --project=node test/mock-llm/real-cli-e2e.test.ts",
          evidenceRef: TEST_NIGHTLY_RUN_URL,
          gapReason: "Nightly Ubuntu CI runs real CLI against loopback mock LLM, not live model APIs.",
          fallbackTests: ["test/mock-llm/real-cli-e2e.test.ts", "src/vendors/contract.test.ts"],
        });
      } else {
        cells.push({
          vendor,
          platform,
          tier: "fake_cli_offline",
          gapReason: "Covered by offline driver protocol tests and contract guards; no CI live-account turn on this platform.",
          fallbackTests: ["src/vendors/contract.test.ts"],
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    releaseVersion: "0.4.0",
    commit: TEST_COMMIT,
    recordedAt: TEST_DATE,
    surfaces: [
      {
        id: "pr-check",
        label: "PR check and verify-smoke",
        platform: "linux",
        cliKind: "fake",
        modelBackend: "fake",
        workflowOrCommand: ".github/workflows/check.yml",
        scope: "Ubuntu unit/e2e suite and pnpm verify with fake claude.",
      },
      {
        id: "windows-ci",
        label: "Windows integration and mock-LLM",
        platform: "windows",
        cliKind: "real",
        modelBackend: "mock_llm",
        workflowOrCommand: ".github/workflows/windows.yml",
        scope: "Real codex and pi CLIs inside Windows fusa-run.exe against loopback mock LLM.",
      },
      {
        id: "nightly-real-cli",
        label: "Nightly Ubuntu real-CLI mock-LLM",
        platform: "linux",
        cliKind: "real",
        modelBackend: "mock_llm",
        workflowOrCommand: ".github/workflows/nightly.yml",
        scope: "Real claude, codex, pi, and deepseek CLIs in Linux bwrap against loopback mock LLM.",
      },
      {
        id: "resident-bench",
        label: "Resident live-service bench",
        platform: "multi",
        cliKind: "real",
        modelBackend: "live_service",
        workflowOrCommand: "pnpm tester",
        scope: "Real Feishu, real relay, and real vendor turns on owner Mac and Tokyo Linux host.",
      },
    ],
    recordedRuns: [
      {
        id: "gh-run:46132355340",
        source: "check.yml",
        platform: "linux",
        kind: "fake_cli_offline",
        commit: TEST_COMMIT,
        urlOrRef: TEST_CHECK_RUN_URL,
        completedAt: TEST_DATE,
      },
      {
        id: "gh-run:46132388888",
        source: "macos.yml",
        platform: "macos",
        kind: "fake_cli_offline",
        commit: TEST_COMMIT,
        urlOrRef: TEST_MAC_RUN_URL,
        completedAt: TEST_DATE,
      },
      {
        id: "gh-run:46132355360:core",
        source: "windows.yml",
        platform: "windows",
        kind: "fake_cli_offline",
        commit: TEST_COMMIT,
        urlOrRef: TEST_WIN_RUN_URL,
        completedAt: TEST_DATE,
      },
      {
        id: "gh-run:46132355360:mock-llm",
        source: "windows.yml",
        platform: "windows",
        kind: "real_cli_mock_llm",
        commit: TEST_COMMIT,
        urlOrRef: TEST_WIN_RUN_URL,
        completedAt: TEST_DATE,
        vendors: ["codex", "pi"],
      },
      {
        id: "gh-run:46132399999:mock-llm",
        source: "nightly.yml",
        platform: "linux",
        kind: "real_cli_mock_llm",
        commit: TEST_COMMIT,
        urlOrRef: TEST_NIGHTLY_RUN_URL,
        completedAt: TEST_DATE,
        vendors: ["claude", "codex", "pi", "deepseek"],
      },
    ],
    cells,
    ...overrides,
  };
}

function buildRepoFacts(overrides: Partial<RepoVerificationFacts> = {}): RepoVerificationFacts {
  return {
    vendors: AGENT_VENDORS,
    mockSupportByVendor: mockSupportMap(),
    workflowRealCliVendors: {
      "windows.yml": ["codex", "pi"],
      "nightly.yml": ["claude", "codex", "pi", "deepseek"],
    },
    workflowPlatforms: {
      "check.yml": ["linux"],
      "macos.yml": ["macos"],
      "windows.yml": ["windows"],
      "nightly.yml": ["linux"],
    },
    workflowRealCliPlatforms: {
      "windows.yml": { windows: ["codex", "pi"] },
      "nightly.yml": { linux: ["claude", "codex", "pi", "deepseek"] },
    },
    appVersion: "0.4.0",
    commitExists: (sha) => sha === TEST_COMMIT,
    ...overrides,
  };
}

function buildSampleTesterRunRecord(commit = `${TEST_COMMIT}${"0".repeat(32)}`): RunRecord {
  const coverage = AGENT_VENDORS.flatMap((vendor) =>
    (["local", "remote"] as const).map((instance) => ({
      vendor,
      instance,
      status:
        (instance === "local" && (vendor === "claude" || vendor === "agy" || vendor === "codex")) ||
        (instance === "remote" && vendor === "claude")
          ? ("ready" as const)
          : ("signed_out" as const),
      version: vendor === "claude" ? "2.1.332" : vendor === "codex" ? "0.169.0" : vendor === "agy" ? "1.5.18" : null,
      detail: "probed cleanly",
      fix: "",
    })),
  );
  return {
    runId: "20261128T100000Z-nightly",
    cadence: "nightly",
    startedAt: "2026-11-28T10:00:00Z",
    finishedAt: "2026-11-28T10:08:00Z",
    commits: { local: commit, remote: commit },
    preflight: { available: ["local_instance", "remote_instance"], problems: [], coverage },
    results: [
      {
        id: "model.turn.claude@local",
        verdict: "pass",
        reason: "ok",
        checks: [{ check: "reply", ok: true, detail: "replied" }],
        externalErrors: [],
        metrics: {},
        evidence: ["reply.json"],
        startedAt: "2026-11-28T10:01:00Z",
        durationMs: 2500,
      },
      {
        id: "model.turn.claude@remote",
        verdict: "pass",
        reason: "ok",
        checks: [{ check: "reply", ok: true, detail: "replied" }],
        externalErrors: [],
        metrics: {},
        evidence: ["reply.json"],
        startedAt: "2026-11-28T10:02:00Z",
        durationMs: 2600,
      },
      {
        id: "model.turn.codex@local",
        verdict: "pass",
        reason: "ok",
        checks: [{ check: "reply", ok: true, detail: "replied" }],
        externalErrors: [],
        metrics: {},
        evidence: ["reply.json"],
        startedAt: "2026-11-28T10:03:00Z",
        durationMs: 2700,
      },
      {
        id: "model.turn.agy@local",
        verdict: "quota",
        reason: "token=ghp_123456789012345678901234567890123456 quota exceeded",
        checks: [],
        externalErrors: [],
        metrics: {},
        evidence: [],
        startedAt: "2026-11-28T10:04:00Z",
        durationMs: 1200,
      },
      {
        id: "model.turn.kimi@local",
        verdict: "not_ready",
        reason: "accepted gap: signed_out",
        checks: [],
        externalErrors: [],
        metrics: {},
        evidence: [],
        startedAt: "2026-11-28T10:05:00Z",
        durationMs: 100,
      },
    ],
  };
}

describe("new behavior: verification matrix and packaged Feishu quick start (expected to fail before implementation)", () => {
  it("A1: parses, validates, and enforces truthfulness, bounds, and secret/reference-name hygiene on 8 x 3 matrices", () => {
    expect(VERIFICATION_PLATFORMS).toEqual(["macos", "windows", "linux"]);
    expect(VERIFICATION_TIERS).toContain("live_service");
    expect(VERIFICATION_TIERS).toContain("real_cli_mock_llm");
    expect(VERIFICATION_TIERS).toContain("fake_cli_offline");
    expect(VERIFICATION_MATRIX_MAX_BYTES).toBeGreaterThan(0);
    expect(VERIFICATION_FIELD_MAX_CHARS).toBeGreaterThan(0);
    expect(VERIFICATION_MAX_FALLBACK_TESTS).toBeGreaterThan(0);
    expect(VERIFICATION_MAX_SURFACES).toBeGreaterThan(0);

    const valid = parseVerificationMatrix(buildValidMatrix());
    expect(validateVerificationMatrix(valid, buildRepoFacts())).toEqual([]);

    const missingCell = buildValidMatrix({ cells: valid.cells.slice(1) });
    expect(validateVerificationMatrix(missingCell, buildRepoFacts()).some((p) => p.code === "missing_cell")).toBe(true);

    const dupCell = buildValidMatrix({ cells: [...valid.cells, valid.cells[0]!] });
    expect(validateVerificationMatrix(dupCell, buildRepoFacts()).some((p) => p.code === "duplicate_cell")).toBe(true);

    const badDate = buildValidMatrix({ recordedAt: "2026-02-30" });
    expect(validateVerificationMatrix(badDate, buildRepoFacts()).some((p) => p.code === "invalid_date")).toBe(true);

    const unknownCommit = buildValidMatrix({ commit: "deadbee" });
    expect(validateVerificationMatrix(unknownCommit, buildRepoFacts()).some((p) => p.code === "unknown_commit")).toBe(true);

    const versionDrift = buildValidMatrix({ releaseVersion: "0.3.0" });
    expect(validateVerificationMatrix(versionDrift, buildRepoFacts()).some((p) => p.code === "version_mismatch")).toBe(true);

    const cursorClaimsMock = buildValidMatrix({
      cells: valid.cells.map((cell) =>
        cell.vendor === "cursor" && cell.platform === "linux"
          ? {
              vendor: "cursor",
              platform: "linux",
              tier: "real_cli_mock_llm",
              cliVersion: "2026.11.10",
              workflow: "nightly.yml",
              command: "fake",
              evidenceRef: ".github/workflows/nightly.yml",
              gapReason: "none",
              fallbackTests: ["src/vendors/cursor/cursor.test.ts"],
            }
          : cell,
      ),
    });
    expect(
      validateVerificationMatrix(cursorClaimsMock, buildRepoFacts()).some((p) => p.code === "unsupported_mock_vendor"),
    ).toBe(true);

    const workflowLie = buildValidMatrix({
      cells: valid.cells.map((cell) =>
        cell.vendor === "claude" && cell.platform === "windows"
          ? {
              vendor: "claude",
              platform: "windows",
              tier: "real_cli_mock_llm",
              cliVersion: "2.1.332",
              workflow: "windows.yml",
              command: "fake",
              evidenceRef: ".github/workflows/windows.yml",
              gapReason: "mock only",
              fallbackTests: ["test/mock-llm/real-cli-e2e.test.ts"],
            }
          : cell,
      ),
    });
    expect(validateVerificationMatrix(workflowLie, buildRepoFacts()).some((p) => p.code === "workflow_mismatch")).toBe(true);

    const leakedSecret = buildValidMatrix({
      cells: valid.cells.map((cell, idx) =>
        idx === 0
          ? {
              vendor: cell.vendor,
              platform: cell.platform,
              tier: "fake_cli_offline",
              gapReason: `leaked sk-ant-${"a".repeat(24)} key`,
              fallbackTests: ["src/vendors/contract.test.ts"],
            }
          : cell,
      ),
    });
    expect(validateVerificationMatrix(leakedSecret, buildRepoFacts()).some((p) => p.code === "secret_detected")).toBe(true);

    const bannedRefName = `${"open"}${"claw"}`;
    const refLeak = buildValidMatrix({
      cells: valid.cells.map((cell, idx) =>
        idx === 0
          ? {
              vendor: cell.vendor,
              platform: cell.platform,
              tier: "fake_cli_offline",
              gapReason: `compared with ${bannedRefName}`,
              fallbackTests: ["src/vendors/contract.test.ts"],
            }
          : cell,
      ),
    });
    expect(validateVerificationMatrix(refLeak, buildRepoFacts()).some((p) => p.code === "forbidden_reference_name")).toBe(true);

    const oversizedPayload = buildValidMatrix({
      cells: valid.cells.map((cell, idx) =>
        idx === 0
          ? {
              vendor: cell.vendor,
              platform: cell.platform,
              tier: "fake_cli_offline",
              gapReason: "x".repeat(VERIFICATION_MATRIX_MAX_BYTES),
              fallbackTests: ["src/vendors/contract.test.ts"],
            }
          : cell,
      ),
    });
    expect(() => parseVerificationMatrix(oversizedPayload)).toThrow();
    expect(() => parseVerificationMatrix({ schemaVersion: 2 })).toThrow();
  });

  it("A2: ingests a real test/tester RunRecord, promotes passing live turns only, redacts secrets, and rejects mismatched commits", () => {
    const base = buildValidMatrix();
    const record = buildSampleTesterRunRecord();
    const updated = ingestTesterRunRecord(base, record, {
      platformByInstance: { local: "macos", remote: "linux" },
      recordedAt: TEST_DATE,
    });

    const macClaude = updated.cells.find((c) => c.vendor === "claude" && c.platform === "macos");
    expect(macClaude).toMatchObject({
      tier: "live_service",
      cliVersion: "2.1.332",
      evidenceRef: expect.stringContaining(record.runId),
      verifiedAt: TEST_DATE,
    });

    const linuxClaude = updated.cells.find((c) => c.vendor === "claude" && c.platform === "linux");
    expect(linuxClaude?.tier).toBe("live_service");

    const macCodex = updated.cells.find((c) => c.vendor === "codex" && c.platform === "macos");
    expect(macCodex?.tier).toBe("live_service");

    const macAgy = updated.cells.find((c) => c.vendor === "agy" && c.platform === "macos");
    expect(macAgy?.tier).not.toBe("live_service");
    expect(JSON.stringify(macAgy)).not.toContain("ghp_123456789012345678901234567890123456");

    const macKimi = updated.cells.find((c) => c.vendor === "kimi" && c.platform === "macos");
    expect(macKimi?.tier).not.toBe("live_service");

    expect(validateVerificationMatrix(updated, buildRepoFacts())).toEqual([]);

    const mismatched = buildSampleTesterRunRecord("ffffffffffffffffffffffffffffffffffffffff");
    expect(() =>
      ingestTesterRunRecord(base, mismatched, {
        platformByInstance: { local: "macos", remote: "linux" },
        recordedAt: TEST_DATE,
      }),
    ).toThrow(/commit/i);
  });

  it("A3: deterministically renders docs/verification-matrix.md with snapshot header, tier legend, surfaces, and all 8 x 3 cells", () => {
    const matrix = buildValidMatrix();
    const md = renderVerificationMatrixMarkdown(matrix);
    expect(md).toContain("# Verification matrix");
    expect(md).toContain(`> Snapshot: ${TEST_DATE} (commit \`${TEST_COMMIT}\`)`);
    expect(md).not.toContain("—");
    for (const vendor of AGENT_VENDORS) {
      expect(md, `rendered matrix must list vendor ${vendor}`).toContain(vendor);
    }
    for (const platform of VERIFICATION_PLATFORMS) {
      expect(md.toLowerCase(), `rendered matrix must cover platform ${platform}`).toContain(platform);
    }
    expect(md).toContain("live_service");
    expect(md).toContain("real_cli_mock_llm");
    expect(md).toContain("fake_cli_offline");
    expect(md).toContain("node scripts/verification-matrix.ts check");
    expect(renderVerificationMatrixMarkdown(matrix)).toBe(md);
  });

  it("A4: derives packaged macOS and Windows Feishu commands and rejects source-only Quick Start instructions", () => {
    const cmds = packagedFeishuCommands(DEFAULT_FEISHU_LAYOUT);
    expect(cmds.macConnect).toBe(
      "/Applications/Bellwood.app/Contents/Resources/runtime/node/bin/node /Applications/Bellwood.app/Contents/Resources/runtime/daemon/src/feishu/main.ts connect",
    );
    expect(cmds.macStatus).toBe(
      "/Applications/Bellwood.app/Contents/Resources/runtime/node/bin/node /Applications/Bellwood.app/Contents/Resources/runtime/daemon/src/feishu/main.ts status",
    );
    expect(cmds.winConnectPowerShell).toBe(
      '& "$env:LOCALAPPDATA\\Bellwood\\node\\node.exe" "$env:LOCALAPPDATA\\Bellwood\\daemon\\src\\feishu\\main.ts" connect',
    );
    expect(cmds.winStatusPowerShell).toBe(
      '& "$env:LOCALAPPDATA\\Bellwood\\node\\node.exe" "$env:LOCALAPPDATA\\Bellwood\\daemon\\src\\feishu\\main.ts" status',
    );
    expect(cmds.sourceConnect).toBe("node src/feishu/main.ts connect");
    expect(cmds.sourceStatus).toBe("node src/feishu/main.ts status");

    const currentEn = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const currentZh = readFileSync(join(REPO_ROOT, "README.zh-CN.md"), "utf8");
    const problems = validateFeishuQuickStartDocs({ readmeEn: currentEn, readmeZh: currentZh, commands: cmds });
    expect(problems).toEqual([]);
  });

  it("A5: repository ships a valid commit-bound verification matrix, synced Markdown, release integration, and ALWAYS_RUN_TESTS guard", () => {
    const jsonPath = join(REPO_ROOT, "docs", "verification-matrix.json");
    const mdPath = join(REPO_ROOT, "docs", "verification-matrix.md");
    expect(existsSync(jsonPath), "docs/verification-matrix.json must exist").toBe(true);
    expect(existsSync(mdPath), "docs/verification-matrix.md must exist").toBe(true);

    const workflowVendors = readWorkflowRealCliVendors(join(REPO_ROOT, ".github", "workflows"));
    expect(workflowVendors["windows.yml"]).toEqual(["codex", "pi"]);
    expect(workflowVendors["nightly.yml"]).toEqual(["claude", "codex", "deepseek", "pi"]);

    const matrix = parseVerificationMatrix(JSON.parse(readFileSync(jsonPath, "utf8")) as unknown);
    const problems = validateVerificationMatrix(matrix, {
      vendors: AGENT_VENDORS,
      mockSupportByVendor: mockSupportMap(),
      workflowRealCliVendors: workflowVendors,
      appVersion: readDesktopAppVersion(REPO_ROOT),
    });
    expect(problems).toEqual([]);
    expect(readFileSync(mdPath, "utf8")).toBe(renderVerificationMatrixMarkdown(matrix));

    expect(runVerificationMatrixCli(["check"], { repoRoot: REPO_ROOT })).toBe(0);
    expect(readFileSync(join(REPO_ROOT, "docs", "README.md"), "utf8")).toContain("verification-matrix.md");
    expect(readFileSync(join(REPO_ROOT, ".github", "release-downloads.md"), "utf8")).toContain("docs/verification-matrix.md");
    expect(readFileSync(join(REPO_ROOT, "scripts", "release-assets.ts"), "utf8")).toContain("verification-matrix");
    expect(ALWAYS_RUN_TESTS).toContain("scripts/verification-matrix.test.ts");
  });
});

describe("regression: unchanged Feishu runtime, Settings UI, and CI workflow facts (expected to pass before and after implementation)", () => {
  it("R1: backend exposes /api/feishu/* routes while desktop SettingsDialog keeps its 6 current categories without an unbuilt Feishu tab", () => {
    const routes = readFileSync(join(REPO_ROOT, "src", "daemon", "ui-server", "routes-integrations.ts"), "utf8");
    expect(routes).toContain("API_PATHS.feishuRegistration");
    expect(routes).toContain("API_PATHS.feishuCredentials");
    expect(routes).toContain("API_PATHS.feishuDisconnect");

    const settings = readFileSync(join(REPO_ROOT, "src", "web", "components", "SettingsDialog.tsx"), "utf8");
    for (const section of ['id: "general"', 'id: "providers"', 'id: "capabilities"', 'id: "resources"', 'id: "computers"', 'id: "security"']) {
      expect(settings).toContain(section);
    }
  });

  it("R2: packaged macOS and Windows runtime staging bundles src/feishu and qrcode-generator inside daemon/", () => {
    const stageCommon = readFileSync(join(REPO_ROOT, "scripts", "stage-runtime-common.ts"), "utf8");
    expect(stageCommon).toContain('"feishu"');
    const deps = collectDaemonRuntimeDependencyNames(REPO_ROOT);
    expect(deps).toContain("qrcode-generator");

    const tauriConf = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "windows", "crates", "fusa-desktop", "tauri.conf.json"), "utf8"),
    ) as { productName?: string; bundle?: { windows?: { nsis?: { installMode?: string } } } };
    expect(tauriConf.productName).toBe("Bellwood");
    expect(tauriConf.bundle?.windows?.nsis?.installMode).toBe("currentUser");

    const bundleConf = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "windows", "crates", "fusa-desktop", "tauri.bundle.conf.json"), "utf8"),
    ) as { bundle?: { resources?: Record<string, string> } };
    expect(bundleConf.bundle?.resources?.["staged-runtime/node"]).toBe("node");
    expect(bundleConf.bundle?.resources?.["staged-runtime/daemon"]).toBe("daemon");
  });

  it("R3: CI workflows and VENDOR_BENCH keep their expected vendor declarations across all 8 registered vendors", () => {
    const windowsWf = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "windows.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ env?: Record<string, string> }> }>;
    };
    const winEnv = (windowsWf.jobs["windows-helper-and-integration"]?.steps ?? [])
      .map((s) => s.env?.["BELLWOOD_REQUIRE_REAL_CLI"])
      .find(Boolean);
    expect(winEnv).toBe("codex,pi");

    const nightlyWf = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "nightly.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ env?: Record<string, string> }> }>;
    };
    const nightlyEnv = (nightlyWf.jobs["real-cli-mock-llm"]?.steps ?? [])
      .map((s) => s.env?.["BELLWOOD_REQUIRE_REAL_CLI"])
      .find(Boolean);
    expect(nightlyEnv).toBe("claude,codex,pi,deepseek");

    const benchVendors = Object.keys(VENDOR_BENCH).sort();
    expect(benchVendors).toEqual([...AGENT_VENDORS].sort());
    for (const platform of VERIFICATION_PLATFORMS) {
      expect(["macos", "windows", "linux"]).toContain(platform satisfies VerificationPlatform);
    }
  });

  it("R4: rejects source-only Quick Start Feishu instructions and detects Markdown drift in CLI check", () => {
    const cmds = packagedFeishuCommands(DEFAULT_FEISHU_LAYOUT);
    const oldEn = [
      "### 4. Connect Feishu, Linux, or other computers (optional)",
      "- **Feishu bot and project groups.** While the daemon is running, run `node src/feishu/main.ts connect` and scan the QR code in Feishu. Run `node src/feishu/main.ts status` to inspect bindings.",
      "## Feishu on mobile and in team groups",
      "- **One shared bot per account.** Run `node src/feishu/main.ts connect` and scan the QR code to create your bot.",
    ].join("\n");
    const oldZh = [
      "### 4. 接入飞书、Linux 或其他电脑（可选）",
      "- **飞书机器人与项目群**：守护进程运行时执行 `node src/feishu/main.ts connect` 并用飞书扫码；执行 `node src/feishu/main.ts status` 查看绑定状态。",
      "## 飞书入口",
      "- **全账号共用一个机器人**：执行 `node src/feishu/main.ts connect` 扫码即可创建。",
    ].join("\n");

    const problems = validateFeishuQuickStartDocs({ readmeEn: oldEn, readmeZh: oldZh, commands: cmds });
    expect(problems.some((p) => p.includes("README.md") && p.includes("macConnect"))).toBe(true);
    expect(problems.some((p) => p.includes("README.md") && p.includes("winConnectPowerShell"))).toBe(true);
    expect(problems.some((p) => p.includes("README.md") && p.includes("docs/verification-matrix.md"))).toBe(true);
    expect(problems.some((p) => p.includes("README.zh-CN.md") && p.includes("macConnect"))).toBe(true);
    expect(problems.some((p) => p.includes("README.zh-CN.md") && p.includes("unqualified"))).toBe(true);

    const driftRoot = mkdtempSync(join(tmpdir(), "bellwood-matrix-drift-"));
    try {
      mkdirSync(join(driftRoot, "docs"), { recursive: true });
      mkdirSync(join(driftRoot, ".github", "workflows"), { recursive: true });
      mkdirSync(join(driftRoot, "apps", "windows"), { recursive: true });
      writeFileSync(join(driftRoot, "apps", "windows", "Cargo.toml"), readFileSync(join(REPO_ROOT, "apps", "windows", "Cargo.toml")));
      writeFileSync(join(driftRoot, ".github", "workflows", "windows.yml"), readFileSync(join(REPO_ROOT, ".github", "workflows", "windows.yml")));
      writeFileSync(join(driftRoot, ".github", "workflows", "nightly.yml"), readFileSync(join(REPO_ROOT, ".github", "workflows", "nightly.yml")));
      writeFileSync(join(driftRoot, "docs", "verification-matrix.json"), readFileSync(join(REPO_ROOT, "docs", "verification-matrix.json")));
      writeFileSync(join(driftRoot, "docs", "verification-matrix.md"), "# Hand edited drift\n");
      expect(runVerificationMatrixCli(["check"], { repoRoot: driftRoot })).toBe(1);
    } finally {
      rmSync(driftRoot, { recursive: true, force: true });
    }
  });
});

describe("regression: review blocker fixes (commit-bound runs, strict live_service, layout binding)", () => {
  it("R5: distinguishes configured workflows from commit-bound run evidence and rejects cross-platform attribution", () => {
    expect(VERIFICATION_MAX_RECORDED_RUNS).toBeGreaterThan(0);
    const wfPlatforms = readWorkflowPlatforms(join(REPO_ROOT, ".github", "workflows"));
    expect(wfPlatforms["windows.yml"]).toEqual(["windows"]);
    expect(wfPlatforms["check.yml"]).toEqual(["linux"]);
    expect(wfPlatforms["macos.yml"]).toEqual(["macos"]);
    const wfRealCliPlatforms = readWorkflowRealCliPlatforms(join(REPO_ROOT, ".github", "workflows"));
    expect(wfRealCliPlatforms["windows.yml"]).toEqual({ windows: ["codex", "pi"] });
    expect(wfRealCliPlatforms["nightly.yml"]).toEqual({ linux: ["claude", "codex", "deepseek", "pi"] });

    const base = buildValidMatrix();
    const facts = buildRepoFacts();

    const staticEvidence = buildValidMatrix({
      cells: base.cells.map((cell) =>
        cell.vendor === "codex" && cell.platform === "windows" && cell.tier === "real_cli_mock_llm"
          ? { ...cell, evidenceRef: ".github/workflows/windows.yml" }
          : cell,
      ),
    });
    expect(validateVerificationMatrix(staticEvidence, facts).some((p) => p.code === "unverified_run_evidence")).toBe(true);

    const wrongCommitRun = buildValidMatrix({
      recordedRuns: base.recordedRuns.map((run) => (run.source === "nightly.yml" ? { ...run, commit: "1bd1d2a3" } : run)),
    });
    expect(validateVerificationMatrix(wrongCommitRun, facts).some((p) => p.code === "unverified_run_evidence")).toBe(true);

    const missingMacRun = buildValidMatrix({
      recordedRuns: base.recordedRuns.filter((run) => run.platform !== "macos"),
    });
    expect(validateVerificationMatrix(missingMacRun, facts).some((p) => p.code === "unverified_run_evidence")).toBe(true);

    const crossPlatform = buildValidMatrix({
      cells: base.cells.map((cell) =>
        cell.vendor === "claude" && cell.platform === "windows"
          ? {
              vendor: "claude",
              platform: "windows",
              tier: "real_cli_mock_llm",
              cliVersion: "2.1.332",
              workflow: "nightly.yml",
              command: "BELLWOOD_REQUIRE_REAL_CLI=claude,codex,pi,deepseek pnpm exec vitest run --project=node test/mock-llm/real-cli-e2e.test.ts",
              evidenceRef: TEST_WIN_RUN_URL,
              gapReason: "Cross-platform misattribution test",
              fallbackTests: ["test/mock-llm/real-cli-e2e.test.ts"],
            }
          : cell,
      ),
    });
    const crossProblems = validateVerificationMatrix(crossPlatform, facts);
    expect(crossProblems.some((p) => p.code === "platform_mismatch")).toBe(true);
    expect(crossProblems.some((p) => p.code === "unverified_run_evidence")).toBe(true);

    const repoMatrix = parseVerificationMatrix(
      JSON.parse(readFileSync(join(REPO_ROOT, "docs", "verification-matrix.json"), "utf8")) as unknown,
    );
    for (const cell of repoMatrix.cells) {
      if (cell.tier === "real_cli_mock_llm" || cell.tier === "live_service") {
        expect(cell.evidenceRef, `${cell.vendor}@${cell.platform} must not cite static workflow config`).not.toMatch(
          /^\.github\/workflows\//,
        );
      }
      if (cell.tier === "fake_cli_offline") {
        expect(cell.evidenceRef, `${cell.vendor}@${cell.platform} should record commit-bound run URL`).toBeDefined();
        expect(cell.evidenceRef).not.toMatch(/^\.github\/workflows\//);
      }
    }
    expect(repoMatrix.cells.filter((c) => c.platform === "macos").every((c) => c.tier === "unverified")).toBe(true);
    expect(repoMatrix.cells.filter((c) => c.platform === "linux").every((c) => c.tier === "fake_cli_offline")).toBe(true);
  });

  it("R6: requires per-instance commit match, concrete non-unknown CLI version, and non-empty evidence for live_service", () => {
    const base = buildValidMatrix();
    const opts = { platformByInstance: { local: "macos", remote: "linux" }, recordedAt: TEST_DATE } as const;

    const missingRemoteCommit = buildSampleTesterRunRecord();
    delete missingRemoteCommit.commits.remote;
    expect(() => ingestTesterRunRecord(base, missingRemoteCommit, opts)).toThrow(/commit/i);

    const customKeyRecord = buildSampleTesterRunRecord();
    customKeyRecord.commits = { mac: customKeyRecord.commits.local!, tokyo: customKeyRecord.commits.remote! };
    expect(() => ingestTesterRunRecord(base, customKeyRecord, opts)).toThrow(/commit/i);
    const customIngested = ingestTesterRunRecord(base, customKeyRecord, {
      ...opts,
      commitKeyByInstance: { local: "mac", remote: "tokyo" },
    });
    expect(validateVerificationMatrix(customIngested, buildRepoFacts())).toEqual([]);

    const unknownVersion = buildSampleTesterRunRecord();
    unknownVersion.preflight.coverage = unknownVersion.preflight.coverage.map((entry) =>
      entry.vendor === "claude" && entry.instance === "local" ? { ...entry, version: null } : entry,
    );
    expect(() => ingestTesterRunRecord(base, unknownVersion, opts)).toThrow(/version/i);

    const literalUnknownVersion = buildSampleTesterRunRecord();
    literalUnknownVersion.preflight.coverage = literalUnknownVersion.preflight.coverage.map((entry) =>
      entry.vendor === "codex" && entry.instance === "local" ? { ...entry, version: "unknown" } : entry,
    );
    expect(() => ingestTesterRunRecord(base, literalUnknownVersion, opts)).toThrow(/version/i);

    const emptyEvidence = buildSampleTesterRunRecord();
    emptyEvidence.results = emptyEvidence.results.map((r) => (r.id === "model.turn.claude@local" ? { ...r, evidence: [] } : r));
    expect(() => ingestTesterRunRecord(base, emptyEvidence, opts)).toThrow(/evidence/i);

    const invalidLiveCell = buildValidMatrix({
      cells: base.cells.map((cell) =>
        cell.vendor === "claude" && cell.platform === "macos"
          ? {
              vendor: "claude",
              platform: "macos",
              tier: "live_service",
              cliVersion: "unknown",
              model: "claude-sonnet-4-6",
              evidenceRef: "tester:20261128T100000Z-nightly:model.turn.claude@local",
              verifiedAt: TEST_DATE,
            }
          : cell,
      ),
    });
    const liveProblems = validateVerificationMatrix(invalidLiveCell, buildRepoFacts());
    expect(liveProblems.some((p) => p.code === "invalid_cli_version")).toBe(true);
    expect(liveProblems.some((p) => p.code === "unverified_run_evidence")).toBe(true);
  });

  it("R7: binds packaged Feishu quick-start guard directly to real packaging configs and scripts", () => {
    expect(readPackagedFeishuLayout(REPO_ROOT)).toEqual(DEFAULT_FEISHU_LAYOUT);
    const copyFiles = [
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
    ];
    const tmpRoot = mkdtempSync(join(tmpdir(), "bellwood-feishu-layout-"));
    try {
      for (const rel of copyFiles) {
        const dst = join(tmpRoot, rel);
        mkdirSync(join(dst, ".."), { recursive: true });
        writeFileSync(dst, readFileSync(join(REPO_ROOT, rel)));
      }
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(0);

      const macBuildPath = join(tmpRoot, "scripts", "build-mac-app.sh");
      const origMacBuild = readFileSync(macBuildPath, "utf8");
      writeFileSync(macBuildPath, origMacBuild.replace('APP_NAME="Bellwood.app"', 'APP_NAME="BellwoodAlt.app"'));
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(1);
      writeFileSync(macBuildPath, origMacBuild);

      const tauriConfPath = join(tmpRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.conf.json");
      const origTauriConf = readFileSync(tauriConfPath, "utf8");
      writeFileSync(tauriConfPath, origTauriConf.replace('"productName": "Bellwood"', '"productName": "BellwoodAlt"'));
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(1);
      writeFileSync(tauriConfPath, origTauriConf);

      const bundlePath = join(tmpRoot, "apps", "windows", "crates", "fusa-desktop", "tauri.bundle.conf.json");
      const origBundle = readFileSync(bundlePath, "utf8");
      writeFileSync(bundlePath, origBundle.replace('"staged-runtime/daemon": "daemon"', '"staged-runtime/daemon": "alt-daemon"'));
      expect(runVerificationMatrixCli(["check"], { repoRoot: tmpRoot })).toBe(1);
      writeFileSync(bundlePath, origBundle);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
