// Real vendor CLI loopback verification probes for Tier 1 product capability evaluation.
// Invariant: isolates all CLI state in scratch directories and verifies real user configs remain untouched.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "../../../src/shared/vendors.ts";
import { checkPromptPrefixStability, startMockModelServer } from "./mock-model-server.ts";
import type { PrefixStabilityReport } from "./types.ts";
import { getVendorEvalProfile, resolveVendorMockEnv } from "./vendor-profiles.ts";

export interface RealCliProbeOutcome {
  readonly vendor: AgentVendor;
  readonly binaryPath: string | null;
  readonly status: "verified" | "failed" | "not_verified";
  readonly detail: string;
  readonly resumePrefixStable: boolean | null;
  readonly freshSessionDriftCaught: boolean | null;
  readonly userConfigUntouched: boolean;
  readonly recordedTurns: number;
}

interface FileFingerprint {
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs: number | null;
  readonly sha256: string | null;
}

function fingerprintFile(path: string): FileFingerprint {
  if (!existsSync(path)) {
    return { path, exists: false, mtimeMs: null, sha256: null };
  }
  const st = statSync(path);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, exists: true, mtimeMs: st.mtimeMs, sha256: hash };
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
}

function whichBinary(command: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [command], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0]?.trim();
  return first || null;
}

function writeLaunchConfigFiles(
  scratchHome: string,
  configFiles: readonly { readonly relativePath: string; readonly content: string }[],
): void {
  for (const file of configFiles) {
    const full = join(scratchHome, file.relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, "utf8");
  }
}

async function runChildAsync(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      stderr += String(err);
      done(1);
    });
    child.once("close", (code) => done(code));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      done(null);
    }, options.timeoutMs);
  });
}

export async function probeRealCodexCli(workDir: string): Promise<RealCliProbeOutcome> {
  const binaryPath = whichBinary("codex");
  const realConfig = join(homedir(), ".codex", "config.toml");
  const before = fingerprintFile(realConfig);

  if (!binaryPath) {
    return {
      vendor: "codex",
      binaryPath: null,
      status: "not_verified",
      detail: "codex binary not installed on PATH",
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched: true,
      recordedTurns: 0,
    };
  }

  const scratchHome = join(workDir, "real-codex-home");
  const scratchRepo = join(workDir, "real-codex-repo");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchRepo, { recursive: true });

  const server = await startMockModelServer({
    turns: [{ text: "mock reply 1" }, { text: "mock reply 2" }, { text: "mock reply fresh" }],
  });
  try {
    const launch = resolveVendorMockEnv("codex", server.baseUrl, scratchHome);
    writeLaunchConfigFiles(scratchHome, launch.configFiles);
    const env = { ...process.env, ...launch.env };

    const t1 = await runChildAsync(binaryPath, ["exec", "--skip-git-repo-check", "hello one"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const t2 = await runChildAsync(binaryPath, ["exec", "resume", "--last", "--skip-git-repo-check", "hello two"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const resumeReqs = server.requests();
    const resumeReport: PrefixStabilityReport = checkPromptPrefixStability(resumeReqs);

    const t3 = await runChildAsync(binaryPath, ["exec", "--skip-git-repo-check", "fresh turn"], {
      cwd: scratchRepo,
      env,
      timeoutMs: 30_000,
    });
    const allReqs = server.requests();
    const freshCheck =
      resumeReqs.length >= 2 && allReqs.length >= 3
        ? checkPromptPrefixStability([resumeReqs[0]!, allReqs[allReqs.length - 1]!])
        : null;
    const driftCaught =
      freshCheck !== null &&
      !freshCheck.stable &&
      freshCheck.violations.some((v) => v.kind === "cache_key_changed");

    const after = fingerprintFile(realConfig);
    const userConfigUntouched = sameFingerprint(before, after);
    const ok =
      t1.status === 0 &&
      t2.status === 0 &&
      t3.status === 0 &&
      resumeReqs.length >= 2 &&
      resumeReport.stable &&
      driftCaught &&
      userConfigUntouched;

    return {
      vendor: "codex",
      binaryPath,
      status: ok ? "verified" : "failed",
      detail: ok
        ? `Real codex 2-turn resume prefix stable=true (${resumeReqs.length} turns); fresh session cache_key_changed caught; real ~/.codex/config.toml untouched`
        : `codex exits=(${String(t1.status)},${String(t2.status)},${String(t3.status)}) reqs=${allReqs.length} resumeStable=${String(resumeReport.stable)} driftCaught=${String(driftCaught)} untouched=${String(userConfigUntouched)}`,
      resumePrefixStable: resumeReqs.length >= 2 ? resumeReport.stable : false,
      freshSessionDriftCaught: driftCaught,
      userConfigUntouched,
      recordedTurns: allReqs.length,
    };
  } finally {
    await server.close();
  }
}

export async function probeRealClaudeCli(workDir: string): Promise<RealCliProbeOutcome> {
  const binaryPath = whichBinary("claude");
  const realConfig = join(homedir(), ".claude.json");
  const before = fingerprintFile(realConfig);

  if (!binaryPath) {
    return {
      vendor: "claude",
      binaryPath: null,
      status: "not_verified",
      detail: "claude binary not installed on PATH",
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched: true,
      recordedTurns: 0,
    };
  }

  const scratchHome = join(workDir, "real-claude-home");
  const scratchRepo = join(workDir, "real-claude-repo");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchRepo, { recursive: true });

  const server = await startMockModelServer({
    turns: [{ text: "claude mock reply 1" }, { text: "claude mock reply 2" }],
  });
  try {
    const launch = resolveVendorMockEnv("claude", server.baseUrl, scratchHome);
    const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const sessionId = "11111111-2222-4333-8444-555555555555";
    const t1 = await runChildAsync(
      binaryPath,
      ["-p", "--output-format", "json", "--session-id", sessionId, "--model", "claude-sonnet-4-5", "hello one"],
      { cwd: scratchRepo, env, timeoutMs: 30_000 },
    );
    const afterT1 = server.requests();
    if (t1.status === 0 && afterT1.length >= 1) {
      const t2 = await runChildAsync(
        binaryPath,
        ["-p", "--output-format", "json", "--resume", sessionId, "--model", "claude-sonnet-4-5", "hello two"],
        { cwd: scratchRepo, env, timeoutMs: 30_000 },
      );
      const allReqs = server.requests();
      const mainReqs = allReqs.filter((r) => r.model.includes("sonnet"));
      const report = mainReqs.length >= 2 ? checkPromptPrefixStability(mainReqs) : null;
      const after = fingerprintFile(realConfig);
      const userConfigUntouched = sameFingerprint(before, after);
      const ok = t2.status === 0 && mainReqs.length >= 2 && (report?.stable ?? false) && userConfigUntouched;
      return {
        vendor: "claude",
        binaryPath,
        status: ok ? "verified" : "failed",
        detail: `Real claude 2-turn resume requests=${mainReqs.length} (total=${allReqs.length}), exits=(${String(t1.status)},${String(t2.status)}), prefixStable=${String(report?.stable ?? null)}, real ~/.claude.json untouched=${String(userConfigUntouched)}`,
        resumePrefixStable: report?.stable ?? false,
        freshSessionDriftCaught: null,
        userConfigUntouched,
        recordedTurns: mainReqs.length,
      };
    }

    const after = fingerprintFile(realConfig);
    const userConfigUntouched = sameFingerprint(before, after);
    const reason = (t1.stderr || t1.stdout || `exit ${String(t1.status)}`).trim().split(/\r?\n/)[0] ?? "unknown";
    return {
      vendor: "claude",
      binaryPath,
      status: "failed",
      detail: `Isolated HOME loopback probe failed (${afterT1.length} requests, exit ${String(t1.status)}): ${reason.slice(0, 160)}`,
      resumePrefixStable: false,
      freshSessionDriftCaught: null,
      userConfigUntouched,
      recordedTurns: afterT1.length,
    };
  } finally {
    await server.close();
  }
}

export async function probeRealCliMatrix(workDir: string): Promise<RealCliProbeOutcome[]> {
  const outcomes: RealCliProbeOutcome[] = [];
  outcomes.push(await probeRealCodexCli(workDir));
  outcomes.push(await probeRealClaudeCli(workDir));
  for (const vendor of AGENT_VENDORS) {
    if (vendor === "codex" || vendor === "claude") continue;
    const profile = getVendorEvalProfile(vendor);
    const bin = whichBinary(vendorSpec(vendor).cli.command);
    outcomes.push({
      vendor,
      binaryPath: bin,
      status: "not_verified",
      detail:
        profile.tier1Coverage === "fake_driver_contract"
          ? `fake_driver_contract (${profile.gapReason ?? "no loopback override"})`
          : bin
            ? "Installed; covered by loopback launch contract (live probe skipped in baseline smoke)"
            : `${vendorSpec(vendor).cli.command} binary not installed on PATH`,
      resumePrefixStable: null,
      freshSessionDriftCaught: null,
      userConfigUntouched: true,
      recordedTurns: 0,
    });
  }
  return outcomes;
}
