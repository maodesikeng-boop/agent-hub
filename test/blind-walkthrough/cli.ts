#!/usr/bin/env node
// Command-line entry point for the blind new-user walkthrough runner (`pnpm blind-walkthrough <command>`).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentVendor } from "../../src/shared/vendors.ts";
import { assertBlindPromptClean, assertIsolatedWorkspace } from "./context-barrier.ts";
import { ingestCuaRecording, prepareCuaHandoff } from "./cua-track.ts";
import { createSampleUserProject } from "./isolated-app.ts";
import { BLIND_MAX_TOTAL_STEPS_PER_RUN } from "./limits.ts";
import { BLIND_AGENT_SYSTEM_PROMPT, isBlindMissionId, listMissions, selectMissions } from "./missions.ts";
import { appendRunHistory, pruneOldRuns } from "./recorder.ts";
import { extractPainPoints, mergePainPointReports, renderPainPointReportMarkdown } from "./report.ts";
import { resumeBlindWalkthrough, runBlindWalkthrough } from "./runner.ts";
import type { AppVendorMode, BlindMissionId, PainPointReport, ViewportSpec, WalkthroughTrace } from "./types.ts";
import { listBlindVendorSupport, resolveBlindVendorAdapter } from "./vendors.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const VIEWPORT_PRESETS: Readonly<Record<string, ViewportSpec>> = {
  desktop: { kind: "desktop", width: 1280, height: 800 },
  narrow: { kind: "narrow", width: 480, height: 844 },
};

function shortTempParent(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync("/tmp") ? base : "/tmp";
}

function parseViewports(raw: string | undefined): readonly ViewportSpec[] {
  const names = (raw ?? "desktop,narrow")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (names.length === 0) return [VIEWPORT_PRESETS.desktop!];
  return names.map((name) => {
    const preset = VIEWPORT_PRESETS[name];
    if (!preset) throw new RangeError(`Unknown viewport preset: ${name} (expected desktop or narrow)`);
    return preset;
  });
}

function parseMissionIds(raw: string | undefined): readonly BlindMissionId[] {
  if (!raw || raw.trim() === "") return listMissions().map((m) => m.id);
  const requested = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const id of requested) {
    if (!isBlindMissionId(id)) throw new RangeError(`Unknown mission id: ${id}`);
  }
  return selectMissions(requested).map((m) => m.id);
}

function parseVendor(raw: string | undefined): AgentVendor {
  const candidate = (raw ?? "agy").trim() as AgentVendor;
  const matrix = listBlindVendorSupport();
  if (!(candidate in matrix)) {
    throw new RangeError(`Unknown vendor: ${candidate} (expected one of ${Object.keys(matrix).join(", ")})`);
  }
  return candidate;
}

function parseAppVendorMode(raw: string | undefined, isolatedVendorHome: string | undefined): AppVendorMode {
  if (!raw || raw === "fake") return { kind: "fake" };
  const vendor = parseVendor(raw);
  if (!isolatedVendorHome) {
    throw new RangeError("--app-vendor-home is required when using a real --app-vendor");
  }
  return { kind: "real", vendor, isolatedHomeDir: resolve(isolatedVendorHome) };
}

function printUsage(): void {
  console.log(
    [
      "Usage: pnpm blind-walkthrough <command> [options]",
      "",
      "Commands:",
      "  list-missions                      List cold-start new-user missions and vendor support",
      "  run [options]                      Run an unattended Track 1 blind walkthrough",
      "  resume --run-dir <dir> [options]   Resume an interrupted Track 1 walkthrough from checkpoint.json",
      "  prepare-cua --out <dir> [options]  Generate a Track 2 native macOS CUA handoff package",
      "  ingest-cua --transcript <file>     Import a Track 2 CUA recording into WalkthroughTrace + report",
      "  report --trace <file> [--out ...]  Extract or merge pain-point reports from trace JSON files",
    ].join("\n"),
  );
}

/**
 * Postcondition: dispatches run, resume, list-missions, prepare-cua, ingest-cua, or report and returns process exit code (0 ok, 1 failure, 2 usage).
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return command ? 0 : 2;
  }

  try {
    if (command === "list-missions") {
      console.log("Cold-start missions:");
      for (const mission of listMissions()) {
        console.log(`- ${mission.id} (max ${mission.maxSteps} steps): ${mission.title}`);
      }
      console.log("\nVendor blind-agent support:");
      for (const entry of Object.values(listBlindVendorSupport())) {
        console.log(`- ${entry.vendor}: ${entry.mode} (images=${String(entry.supportsImageInput)}) — ${entry.reason}`);
      }
      return 0;
    }

    if (command === "run" || command === "resume") {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          vendor: { type: "string", default: "agy" },
          model: { type: "string" },
          effort: { type: "string" },
          "app-vendor": { type: "string", default: "fake" },
          "app-vendor-home": { type: "string" },
          missions: { type: "string" },
          viewports: { type: "string", default: "desktop,narrow" },
          out: { type: "string" },
          "run-dir": { type: "string" },
          "run-id": { type: "string" },
          "max-steps": { type: "string" },
          "runs-root": { type: "string" },
          "blind-home": { type: "string" },
        },
      });

      const vendor = parseVendor(values.vendor);
      const missionIds = parseMissionIds(values.missions);
      const viewports = parseViewports(values.viewports);
      const appVendorMode = parseAppVendorMode(values["app-vendor"], values["app-vendor-home"]);
      const runId = values["run-id"] ?? `blind-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const maxTotalSteps = values["max-steps"] ? Number.parseInt(values["max-steps"], 10) : BLIND_MAX_TOTAL_STEPS_PER_RUN;
      if (!Number.isInteger(maxTotalSteps) || maxTotalSteps < 1) {
        console.error(`Invalid --max-steps: ${String(values["max-steps"])}`);
        return 2;
      }

      const outDir = resolve(values.out ?? values["run-dir"] ?? join(shortTempParent(), "blind-walkthrough", runId));
      assertIsolatedWorkspace(outDir);
      assertBlindPromptClean(BLIND_AGENT_SYSTEM_PROMPT, { repoRoot: REPO_ROOT });

      const tempRoot = mkdtempSync(join(shortTempParent(), "bw-app-"));
      const blindCwd = mkdtempSync(join(shortTempParent(), "bw-cwd-"));
      const blindHomeDir = values["blind-home"] ? resolve(values["blind-home"]) : mkdtempSync(join(shortTempParent(), "bw-home-"));
      const cleanupBlindHome = !values["blind-home"];

      try {
        const adapter = resolveBlindVendorAdapter({
          vendor,
          systemPrompt: BLIND_AGENT_SYSTEM_PROMPT,
          blindCwd,
          blindHomeDir,
          model: values.model,
          effort: values.effort,
          repoRoot: REPO_ROOT,
        });

        const trace =
          command === "resume"
            ? await resumeBlindWalkthrough(resolve(values["run-dir"] ?? outDir), {
                tempRoot,
                missionIds,
                viewports,
                appVendorMode,
                adapter,
                maxTotalSteps,
                repoRoot: REPO_ROOT,
              })
            : await runBlindWalkthrough({
                runId,
                outDir,
                tempRoot,
                missionIds,
                viewports,
                appVendorMode,
                adapter,
                maxTotalSteps,
                repoRoot: REPO_ROOT,
              });

        if (values["runs-root"]) {
          const runsRoot = resolve(values["runs-root"]);
          assertIsolatedWorkspace(runsRoot);
          appendRunHistory(runsRoot, trace);
          pruneOldRuns(runsRoot);
        }

        console.log(`Run ${trace.runId} finished: ${trace.steps.length} steps, video=${trace.videoPath ?? "none"}, out=${outDir}`);
        return trace.abortedReason ? 1 : 0;
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
        rmSync(blindCwd, { recursive: true, force: true });
        if (cleanupBlindHome) rmSync(blindHomeDir, { recursive: true, force: true });
      }
    }

    if (command === "prepare-cua") {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          out: { type: "string" },
          port: { type: "string", default: "4499" },
          missions: { type: "string" },
          "run-id": { type: "string" },
        },
      });
      const runId = values["run-id"] ?? `cua-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const outputDir = resolve(values.out ?? join(shortTempParent(), "blind-walkthrough", runId));
      const port = Number.parseInt(values.port, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        console.error(`Invalid --port: ${values.port}`);
        return 2;
      }
      const missionIds = parseMissionIds(values.missions);
      const isolatedHomeDir = join(outputDir, "isolated-hub-home");
      const sampleProjectDir = createSampleUserProject(join(outputDir, "sample-workspace"));
      const result = prepareCuaHandoff({
        runId,
        outputDir,
        isolatedHomeDir,
        isolatedPort: port,
        sampleProjectDir,
        missionIds,
        repoRoot: REPO_ROOT,
      });
      if (!result.ok) {
        console.error(`prepare-cua failed (${result.reason}): ${result.detail}`);
        return 1;
      }
      console.log(`Prepared Track 2 CUA handoff in ${result.outputDir}`);
      console.log(`Launch command: ${result.launchCommand}`);
      return 0;
    }

    if (command === "ingest-cua") {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          transcript: { type: "string" },
          video: { type: "string" },
          screenshots: { type: "string" },
          out: { type: "string" },
          "run-id": { type: "string" },
        },
      });
      if (!values.transcript) {
        console.error("ingest-cua requires --transcript <file>");
        return 2;
      }
      const runId = values["run-id"] ?? `cua-ingested-${Date.now()}`;
      const trace = ingestCuaRecording({
        runId,
        transcriptPath: resolve(values.transcript),
        videoPath: values.video ? resolve(values.video) : null,
        screenshotsDir: resolve(values.screenshots ?? "."),
      });
      const report = extractPainPoints(trace);
      const markdown = renderPainPointReportMarkdown(report);
      if (values.out) {
        const outDir = resolve(values.out);
        assertIsolatedWorkspace(outDir);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
        writeFileSync(join(outDir, "pain-points.md"), markdown, "utf8");
      } else {
        console.log(markdown);
      }
      return 0;
    }

    if (command === "report") {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          trace: { type: "string", multiple: true },
          out: { type: "string" },
        },
      });
      const traceFiles = values.trace ?? [];
      if (traceFiles.length === 0) {
        console.error("report requires at least one --trace <file>");
        return 2;
      }
      const reports: PainPointReport[] = traceFiles.map((file) => {
        const trace = JSON.parse(readFileSync(resolve(file), "utf8")) as WalkthroughTrace;
        return extractPainPoints(trace);
      });
      const finalReport = reports.length === 1 ? reports[0]! : mergePainPointReports(reports);
      const markdown = renderPainPointReportMarkdown(finalReport);
      if (values.out) {
        const outPath = resolve(values.out);
        assertIsolatedWorkspace(outPath);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, markdown, "utf8");
      } else {
        console.log(markdown);
      }
      return 0;
    }

    console.error(`Unknown command: ${command}`);
    printUsage();
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
