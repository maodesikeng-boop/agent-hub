// Checks each bench boundary before any flow runs, so an outage outside Bellwood never reads as a product failure.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { API_PATHS, VENDOR_LIST, type ProvidersStatusResponse } from "../../src/shared/index.ts";
import type { Bench, BenchConfig, InstanceClient, LocalInstanceConfig } from "./bench.ts";
import type { FeishuDriver } from "./feishu-driver.ts";
import { TESTER_FEISHU_REAUTHORIZE_WINDOW_MS } from "./limits.ts";
import { benchCliPath, benchLayout, resolveEnvValue } from "./local-instance.ts";
import type { BenchCapability, ExternalError, ExternalService, InstanceRole, PreflightResult } from "./types.ts";
import { probeVendor, VENDOR_BENCH, type VendorReadiness } from "./vendors.ts";

export const driverSecretsFile = (root: string) => join(benchLayout(root).secretsDir, "feishu-driver.json");

/** Postcondition: the capabilities this bench is set up to provide, whether or not they answer right now. */
export function configuredCapabilities(config: BenchConfig): BenchCapability[] {
  const remote = config.instances.find((i) => i.role === "remote");
  const caps: BenchCapability[] = ["local_instance", ...VENDOR_LIST.map(({ id }) => `vendor:${id}` as const)];
  if (remote) caps.push("remote_instance");
  if (remote?.sshAlias) caps.push("remote_control");
  if (config.feishu) caps.push("feishu_bot");
  if (config.feishu && existsSync(driverSecretsFile(config.root))) caps.push("feishu_driver");
  return caps;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function twice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

function localEnv(config: BenchConfig, instance: LocalInstanceConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(instance.env).map(([k, v]) => [k, resolveEnvValue(config.root, v)]));
}

async function coverageOf(bench: Bench, client: InstanceClient, role: InstanceRole, reachable: boolean, unreachable: string): Promise<VendorReadiness[]> {
  let providers: ProvidersStatusResponse | null = null;
  let why = unreachable;
  if (reachable) {
    try {
      providers = await twice(() => client.api.json<ProvidersStatusResponse>("GET", `${API_PATHS.providers}?refresh=1`));
    } catch (error) {
      why = `GET ${API_PATHS.providers} failed: ${describe(error)}`;
    }
  }
  const platform = (providers?.platform ?? process.platform) as NodeJS.Platform;
  const instance = role === "local" ? bench.local().config : null;
  return VENDOR_LIST.map(({ id }) => {
    const provider = providers?.providers.find((p) => p.vendor === id) ?? null;
    return probeVendor(id, {
      instance: role,
      provider,
      ...(provider === null ? { unreachable: providers === null ? why : `the daemon does not list ${id}` } : {}),
      ...(instance ? { local: { cliPath: benchCliPath(id, instance, platform), userHome: instance.userHome, env: localEnv(bench.config, instance), installDir: join(benchLayout(bench.config.root).localDir, "install") } } : {}),
      platform,
    });
  });
}

/** Coverage rows for a bench without a remote computer, so the matrix still lists every vendor on both computers. */
function noRemoteCoverage(): VendorReadiness[] {
  return VENDOR_LIST.map(({ id }) => ({ ...probeVendor(id, { instance: "remote", provider: null, unreachable: "bench.json lists no remote test computer yet", platform: "linux" }), fix: "Set up the remote test computer: .agents/skills/tester/references/bench-setup.md section 2." }));
}

/**
 * Postcondition: `available` lists each capability in `wanted` that answered:
 * local_instance by /api/health and remote_instance by /api/router/digest through the mesh proxy,
 * remote_control by its status command, feishu_bot by a tenant token and the bot's chat list, and feishu_driver by a valid user token.
 * `coverage` holds probeVendor for every vendor in VENDOR_LIST on every bench computer that answered, and an `unknown`
 * entry for each vendor on a computer that did not, so the matrix is always complete.
 * Each capability is retried once; a second failure lands in `problems` with the service that failed.
 * It sends no Feishu message and starts no model turn.
 */
export async function preflight(bench: Bench, driver: FeishuDriver | null, wanted: readonly BenchCapability[], now = Date.now): Promise<PreflightResult> {
  const want = new Set(wanted);
  const available: BenchCapability[] = [];
  const problems: ExternalError[] = [];
  const warnings: string[] = [];
  const check = async (cap: BenchCapability, service: ExternalService, probe: () => Promise<unknown>): Promise<boolean> => {
    try {
      await twice(probe);
      if (want.has(cap)) available.push(cap);
      return true;
    } catch (error) {
      if (want.has(cap)) problems.push({ service, detail: `${cap}: ${describe(error)}` });
      return false;
    }
  };
  const ok = (r: { ok: boolean }) => {
    if (!r.ok) throw new Error("health reports not ok");
  };
  const localUp = await check("local_instance", "bench", async () => ok(await bench.local().health()));
  const status = bench.hasRemote() ? bench.remote().status : undefined;
  if (status) await check("remote_control", "bench", status);
  if (driver) {
    await check("feishu_bot", "feishu", () => driver.testChats());
    await check("feishu_driver", "feishu", async () => {
      const expiresAt = await driver.ensureUserToken();
      if (want.has("feishu_driver") && expiresAt - now() < TESTER_FEISHU_REAUTHORIZE_WINDOW_MS) {
        warnings.push(`Feishu driver refresh token expires at ${new Date(expiresAt).toISOString()}. To renew it, run \`node test/tester/cli.ts authorize-feishu\` and approve access in the browser.`);
      }
    });
  }
  const localCoverage = await coverageOf(bench, bench.local(), "local", localUp, "the local test computer did not answer");
  const remoteUp = bench.hasRemote() && (await check("remote_instance", "relay", async () => ok(await bench.remote().health())));
  const remoteCoverage = bench.hasRemote() ? await coverageOf(bench, bench.remote(), "remote", remoteUp, "the remote test computer did not answer through the relay") : noRemoteCoverage();
  const coverage = [...localCoverage, ...remoteCoverage];
  for (const entry of coverage) {
    const cap = `vendor:${entry.vendor}` as const;
    if (want.has(cap) && entry.status === "ready" && entry.instance === "local" && VENDOR_BENCH[entry.vendor].local.coverage === "turn") available.push(cap);
  }
  return { available, problems, warnings, coverage };
}
