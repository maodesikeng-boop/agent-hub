// Entry point for the tester's script layer, used by the nightly job, the Project Manager, and the AI tester:
//   node test/tester/cli.ts list                         print the flow catalog
//   node test/tester/cli.ts preflight                    check every bench boundary and print the vendor coverage matrix
//   node test/tester/cli.ts run --cadence nightly        run the nightly flows
//   node test/tester/cli.ts run --cadence pr --changed <file>...   run flows a PR's changed paths select
//   node test/tester/cli.ts run --flow <id>...           run named flows
//   node test/tester/cli.ts status                       print runs/latest/summary.md
//   node test/tester/cli.ts vendors status               print the coverage matrix: every vendor on every bench computer
//   node test/tester/cli.ts vendors install              install missing vendor CLIs into the local bench HOME with the product's install commands
//   node test/tester/cli.ts bench up [--mode real|fake]  run the local test computer in the foreground until Ctrl-C
//   node test/tester/cli.ts authorize-feishu             one-time owner consent for the Feishu driver app
//   node test/tester/cli.ts fake-script                  print the fake claude script the remote test computer uses in fake mode
// Common options: --config <bench.json> (default <bench root>/bench.json), --code-dir <checkout> (default this checkout).
// Exit codes: 0 clean, 1 product alert, 2 bench alert or usage error.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENV_HOME, VENDOR_LIST } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { BENCH_CONFIG_FILE, benchRoot, openBench, ProductionGuardError, type BenchConfig } from "./bench.ts";
import { authorizeDriver } from "./feishu-driver.ts";
import { benchFakeScript } from "./fake-script.ts";
import { FLOWS } from "./flows.ts";
import { LATEST_DIR } from "./history.ts";
import { benchBinDirs, benchCliPath, benchLayout, benchPath, ensureNodeBin, resolveEnvValue } from "./local-instance.ts";
import { configuredCapabilities, driverSecretsFile, preflight } from "./preflight.ts";
import { safeText } from "./report.ts";
import { defaultDriver, loadBenchConfig, runTester } from "./run.ts";
import type { Cadence } from "./types.ts";
import { installVendor, openGaps, VENDOR_BENCH, type VendorReadiness } from "./vendors.ts";

const CODE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const FEISHU_REDIRECT_PORT = 47123;
const CADENCES: readonly Cadence[] = ["nightly", "rc", "pr"];

type Out = (line: string) => void;

function listFlows(out: Out): number {
  for (const flow of FLOWS) {
    out(`${flow.id}${flow.manual ? " (manual)" : ""}  [${flow.cadences.join(", ")}]${flow.perInstance ? " on each computer" : ""}`);
    out(`  ${flow.title}. ${flow.story}`);
    for (const p of flow.pass) out(`  - ${p.check}: ${p.rule}`);
    if (flow.escapes.length > 0) out(`  guards ${flow.escapes.join(", ")}`);
  }
  return 0;
}

export function coverageLines(coverage: readonly VendorReadiness[]): string[] {
  return coverage.map((c) => {
    const label = VENDOR_LIST.find((v) => v.id === c.vendor)?.label ?? c.vendor;
    const recipe = VENDOR_BENCH[c.vendor][c.instance];
    const readiness = c.status === "ready" ? (c.version ?? "") : `fix: ${c.fix}`;
    const tail = recipe.coverage === "turn" ? readiness : `accepted gap: ${c.acceptedGap ?? `${recipe.reason} (${readiness})`}`;
    return `${label.padEnd(12)} ${c.instance.padEnd(7)} ${c.status.padEnd(14)} ${safeText(tail, false)}`;
  });
}

async function withBench<T>(config: BenchConfig, codeDir: string, mode: "real" | "fake", fn: (bench: Awaited<ReturnType<typeof openBench>>) => Promise<T>): Promise<T> {
  const bench = await openBench(config, { codeDir, mode, reuseResident: true });
  try {
    return await fn(bench);
  } finally {
    await bench.close();
  }
}

async function runPreflight(config: BenchConfig, codeDir: string, out: Out, onlyCoverage: boolean): Promise<number> {
  return withBench(config, codeDir, "real", async (bench) => {
    const problems: string[] = [];
    const driver = await defaultDriver(config, bench).catch((error: unknown) => (problems.push(String(error)), null));
    const result = await preflight(bench, driver, configuredCapabilities(config));
    if (!onlyCoverage) {
      out(`available: ${result.available.join(", ") || "none"}`);
      for (const problem of problems) out(`problem feishu: feishu_driver: ${safeText(problem, false)}`);
      for (const p of result.problems) out(`problem ${p.service}: ${safeText(p.detail, false)}`);
      for (const warning of result.warnings ?? []) out(`warning: ${safeText(warning, false)}`);
    }
    out("vendor coverage:");
    for (const line of coverageLines(result.coverage)) out(`  ${line}`);
    return problems.length === 0 && result.problems.length === 0 && openGaps(result.coverage).length === 0 ? 0 : 2;
  });
}

async function installMissing(config: BenchConfig, out: Out): Promise<number> {
  const local = config.instances.find((i) => i.role === "local")!;
  if (local.role !== "local") return 2;
  const layout = benchLayout(config.root);
  const env = Object.fromEntries(Object.entries(local.env).map(([k, v]) => [k, resolveEnvValue(config.root, v)]));
  const path = benchPath(local, ensureNodeBin(layout, process.platform), process.platform, process.env.PATH);
  const npmPrefix = resolveHubPaths({ [ENV_HOME]: local.dataDir }, local.userHome).toolsNpmDir;
  let failed = 0;
  for (const { id } of VENDOR_LIST) {
    const existing = benchCliPath(id, local, process.platform);
    if (existing !== null) {
      out(`${id}: already at ${existing}`);
      continue;
    }
    const result = await installVendor(id, { instance: "local", userHome: local.userHome, npmPrefix, path, installDir: join(layout.localDir, "install"), platform: process.platform, env, resolveCli: () => benchCliPath(id, local, process.platform) });
    out(`${id}: ${result.status} ${safeText(result.detail, false)}`);
    if (result.status === "install_failed") failed++;
  }
  out(`bench bins: ${benchBinDirs(local, process.platform).join(", ")}. The remote computer's CLIs are installed by scripts/provision-linux.sh.`);
  return failed === 0 ? 0 : 2;
}

async function benchUp(config: BenchConfig, codeDir: string, mode: "real" | "fake", out: Out): Promise<number> {
  const bench = await openBench(config, { codeDir, mode });
  const local = bench.local();
  const token = readFileSync(resolveHubPaths({ [ENV_HOME]: local.config.dataDir }, local.config.userHome).uiTokenFile, "utf8").trim();
  out(`local test computer runs in ${mode} mode: ${local.api.origin}/auth?token=${token}`);
  out("press Ctrl-C to stop it");
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  await bench.close();
  return 0;
}

function openInBrowser(url: string, out: Out): void {
  out(`open this link to authorize the Feishu driver app: ${url}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
  if (opener !== null) spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function command(argv: readonly string[], out: Out): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      cadence: { type: "string" },
      flow: { type: "string", multiple: true },
      changed: { type: "string", multiple: true },
      config: { type: "string" },
      "code-dir": { type: "string" },
      mode: { type: "string" },
    },
  });
  const [verb, sub] = positionals;
  if (verb === "list") return listFlows(out);
  if (verb === "fake-script") return out(JSON.stringify(benchFakeScript(), null, 2)), 0;
  const root = benchRoot(process.env, homedir());
  if (verb === "status") {
    const file = join(benchLayout(root).runsDir, LATEST_DIR, "summary.md");
    if (!existsSync(file)) throw new UsageError(`no run yet: ${file} is missing`);
    out(readFileSync(file, "utf8"));
    return 0;
  }
  const config = loadBenchConfig(values.config ?? join(root, BENCH_CONFIG_FILE));
  const codeDir = values["code-dir"] ?? CODE_DIR;
  if (verb === "preflight") return runPreflight(config, codeDir, out, false);
  if (verb === "vendors" && sub === "status") return runPreflight(config, codeDir, out, true);
  if (verb === "vendors" && sub === "install") return installMissing(config, out);
  if (verb === "bench" && sub === "up") return benchUp(config, codeDir, values.mode === "real" ? "real" : "fake", out);
  if (verb === "authorize-feishu") {
    if (config.feishu === undefined) throw new UsageError("bench.json has no feishu section");
    await authorizeDriver({ driverAppId: config.feishu.driverAppId, driverSecretsFile: driverSecretsFile(root), redirectPort: FEISHU_REDIRECT_PORT, openUrl: (url) => openInBrowser(url, out) });
    out(`authorized; tokens saved in ${driverSecretsFile(root)}`);
    return 0;
  }
  if (verb === "run") {
    const cadence = (values.cadence ?? (values.flow ? "rc" : undefined)) as Cadence | undefined;
    if (cadence === undefined || !CADENCES.includes(cadence)) throw new UsageError(`run needs --cadence ${CADENCES.join("|")} or --flow <id>`);
    const { summary } = await runTester({ cadence, benchConfigPath: values.config ?? join(root, BENCH_CONFIG_FILE), codeDir, ...(values.flow ? { flowIds: values.flow } : {}), ...(values.changed ? { changedPaths: values.changed } : {}) });
    out(readFileSync(join(summary.evidenceDir, "summary.md"), "utf8"));
    return summary.status === "alert" ? 1 : summary.status === "bench" ? 2 : 0;
  }
  throw new UsageError(`unknown command: ${positionals.join(" ") || "(none)"}; see the header of test/tester/cli.ts`);
}

class UsageError extends Error {}

/** Postcondition: the process exit code for `argv`; writes the human-readable result to stdout and errors to stderr. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await command(argv, (line) => console.log(line));
  } catch (error) {
    const kind = error instanceof ProductionGuardError ? "refused (production guard)" : error instanceof UsageError ? "usage" : "error";
    console.error(`tester ${kind}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
