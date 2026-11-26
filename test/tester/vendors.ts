// Vendor coverage on the bench: every vendor in VENDOR_LIST, on every bench computer, installed from the bench's own HOME.
// Install commands and login commands come from the product (VENDOR_PATHS and each spec's cli), so the bench installs
// exactly what a user installs. This file holds only the owner's coverage decision per vendor.
// Invariant: coverage always has one entry per vendor per computer; a vendor that cannot be installed or signed in
// appears with its status, reason, and fix, and is never left out. An accepted gap stops only the alert, never the listing.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderStatusItem } from "../../src/shared/providers.ts";
import { vendorSpec, type AgentVendor } from "../../src/shared/vendors.ts";
import { vendorConfigHome } from "../../src/shared/paths.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { AGY_CLI_HOME_REL } from "../../src/vendors/agy/spec.ts";
import { TESTER_INSTALL_TIMEOUT_MS, TESTER_STDERR_TAIL_LINES } from "./limits.ts";
import type { InstanceRole } from "./types.ts";

export type ReadinessStatus =
  /** Installed, signed in, and the daemon reports it available. */
  | "ready"
  /** The CLI does not resolve from the bench HOME and PATH. */
  | "not_installed"
  /** The product's install command ran and failed; detail holds the exit code and the last stderr lines. */
  | "install_failed"
  /** Installed but not signed in, or the daemon reports signed_out. */
  | "signed_out"
  /** Signing in cannot be confined to the bench HOME on this platform, such as a credential kept only in the login keychain. */
  | "login_blocked"
  /** The probe itself failed for a reason outside the vendor, such as the bench computer being unreachable. */
  | "unknown";

export interface VendorReadiness {
  vendor: AgentVendor;
  instance: InstanceRole;
  status: ReadinessStatus;
  version: string | null;
  detail: string;
  /** The exact command or step that fixes a non-ready status, shown to the Project Manager and the owner. */
  fix: string;
  /** The owner's reason when this entry matches the vendor's accepted gap; the entry is still listed in every summary. */
  acceptedGap?: string;
}

/**
 * turn: the owner has an account; the vendor's real CLI answers a turn on both bench computers every night.
 * accepted_gap: the owner decided not to cover it on the bench. The CLI is still installed and probed, so a broken install
 * command or a wrong Settings state still alerts; only `status` itself is accepted. `fallbackTests` keep covering it offline.
 */
export type VendorBenchRecipe =
  | { coverage: "turn"; model: string | null; signIn: string }
  | { coverage: "accepted_gap"; status: Extract<ReadinessStatus, "signed_out">; reason: string; decided: string; fallbackTests: readonly string[] };

const NO_TEST_ACCOUNTS = "The owner has no test account for this vendor.";
const TOKYO_CLAUDE_ONLY = "The owner uses only Claude Code on the Tokyo test computer.";

function acceptedGap(vendor: AgentVendor, reason: string, decided: string): VendorBenchRecipe {
  const file = vendor === "agy" || vendor === "codex" || vendor === "pi" ? "driver.test.ts" : `${vendor}.test.ts`;
  return { coverage: "accepted_gap", status: "signed_out", reason, decided, fallbackTests: [`src/vendors/${vendor}/${file}`, "src/vendors/contract.test.ts"] };
}

function onBoth(recipe: VendorBenchRecipe): Record<InstanceRole, VendorBenchRecipe> {
  return { local: recipe, remote: recipe };
}

export const VENDOR_BENCH: Readonly<Record<AgentVendor, Readonly<Record<InstanceRole, VendorBenchRecipe>>>> = {
  claude: onBoth({ coverage: "turn", model: "haiku", signIn: "Sign in to Claude Code in each bench HOME, or share a bench-only `claude setup-token` token." }),
  agy: {
    local: { coverage: "turn", model: "gemini-3.8-flash", signIn: "Run `agy` and paste the code with the owner's Google account." },
    remote: acceptedGap("agy", TOKYO_CLAUDE_ONLY, "2026-11-26"),
  },
  codex: {
    local: { coverage: "turn", model: null, signIn: "`codex login --device-auth` with the owner's ChatGPT plan, CODEX_HOME inside the bench HOME." },
    remote: acceptedGap("codex", TOKYO_CLAUDE_ONLY, "2026-11-26"),
  },
  pi: {
    local: acceptedGap("pi", "The owner does not sign in to Pi on the Mac test computer.", "2026-11-26"),
    remote: acceptedGap("pi", TOKYO_CLAUDE_ONLY, "2026-11-26"),
  },
  cursor: onBoth(acceptedGap("cursor", "The owner cannot use Cursor.", "2026-11-23")),
  deepseek: onBoth(acceptedGap("deepseek", NO_TEST_ACCOUNTS, "2026-11-23")),
  opencode: onBoth(acceptedGap("opencode", NO_TEST_ACCOUNTS, "2026-11-23")),
  kimi: onBoth(acceptedGap("kimi", NO_TEST_ACCOUNTS, "2026-11-23")),
};

/** Postcondition: the product's install command for `vendor` on `platform`: windowsInstallCommand on win32, else installCommand. Throws when the vendor ships none. */
export function installCommandFor(vendor: AgentVendor, platform: NodeJS.Platform): string {
  const paths = VENDOR_PATHS[vendor];
  const command = platform === "win32" ? paths.windowsInstallCommand : paths.installCommand;
  if (command === undefined) throw new Error(`${vendorSpec(vendor).label} ships no install command for ${platform}`);
  return command;
}

/** Postcondition: the product's headless login command for `vendor`, falling back to its spec's cli.loginCommand. */
export function loginCommandFor(vendor: AgentVendor): string {
  return VENDOR_PATHS[vendor].headlessLoginCommand ?? vendorSpec(vendor).cli.loginCommand;
}

export interface InstallRecord {
  vendor: AgentVendor;
  command: string;
  exitCode: number | null;
  stderrTail: string;
  at: string;
}

export interface CommandResult {
  exitCode: number | null;
  stderr: string;
}

export type CommandRunner = (command: string, env: Record<string, string>, timeoutMs: number) => Promise<CommandResult>;

/** Runs `command` through the platform shell, since the product's install commands are shell pipelines. */
export const runShell: CommandRunner = (command, env, timeoutMs) =>
  new Promise((resolve) => {
    const [shell, args] = process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-Command", command]] : ["/bin/sh", ["-c", command]];
    const child = spawn(shell, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr = (stderr + c).slice(-64 * 1024)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stderr: `${stderr}\n${error.message}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr });
    });
  });

const tail = (text: string, lines: number) => text.trimEnd().split("\n").slice(-lines).join("\n");

export const installRecordFile = (installDir: string, vendor: AgentVendor) => join(installDir, `${vendor}.json`);

export function readInstallRecord(installDir: string, vendor: AgentVendor): InstallRecord | null {
  const file = installRecordFile(installDir, vendor);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as InstallRecord) : null;
}

export interface InstallTarget {
  instance: InstanceRole;
  /** The bench HOME the installer sees. */
  userHome: string;
  /** The test daemon's managed npm prefix, where npm-based CLIs land. */
  npmPrefix: string;
  /** PATH with only bench bins, a node-only directory, and system directories. */
  path: string;
  /** Where the outcome is recorded, so later probes report install_failed with its stderr. */
  installDir: string;
  platform: NodeJS.Platform;
  /** Bench env entries such as CODEX_HOME, so a CLI that installs its own config lands in the bench HOME too. */
  env: Record<string, string>;
  run?: CommandRunner;
  /** Re-resolves the CLI inside the bench after the install; null when it is still missing. */
  resolveCli: () => string | null;
}

/**
 * Runs the product's install command with HOME set to the bench HOME (and npm's global prefix inside it), so nothing
 * lands in the developer's own tool directories.
 * Postcondition: `signed_out` when the CLI now resolves inside the bench (the daemon decides ready later), or `install_failed`
 * with the command's exit code and the last 20 stderr lines in detail. The outcome is recorded under installDir.
 */
export async function installVendor(vendor: AgentVendor, target: InstallTarget): Promise<VendorReadiness> {
  const command = installCommandFor(vendor, target.platform);
  const env = {
    ...target.env,
    HOME: target.userHome,
    USERPROFILE: target.userHome,
    PATH: target.path,
    npm_config_prefix: target.npmPrefix,
    NPM_CONFIG_PREFIX: target.npmPrefix,
    SHELL: "/bin/sh",
  };
  const result = await (target.run ?? runShell)(command, env, TESTER_INSTALL_TIMEOUT_MS);
  const record: InstallRecord = { vendor, command, exitCode: result.exitCode, stderrTail: tail(result.stderr, TESTER_STDERR_TAIL_LINES), at: new Date().toISOString() };
  mkdirSync(target.installDir, { recursive: true });
  const resolved = result.exitCode === 0 ? target.resolveCli() : null;
  writeFileSync(installRecordFile(target.installDir, vendor), `${JSON.stringify({ ...record, exitCode: resolved === null && result.exitCode === 0 ? -1 : result.exitCode }, null, 2)}\n`);
  if (resolved !== null) return withRecipe({ vendor, instance: target.instance, status: "signed_out", version: null, detail: `installed at ${resolved}`, fix: loginFix(vendor, target.instance, target.userHome) });
  const why = result.exitCode === 0 ? "exited 0 but the CLI is not inside the bench HOME" : `exited ${result.exitCode}`;
  return withRecipe({ vendor, instance: target.instance, status: "install_failed", version: null, detail: `${command} ${why}\n${record.stderrTail}`, fix: installFix(vendor, target.platform) });
}

function installFix(vendor: AgentVendor, platform: NodeJS.Platform): string {
  return `node test/tester/cli.ts vendors install (runs: ${installCommandFor(vendor, platform)})`;
}

function loginFix(vendor: AgentVendor, role: InstanceRole, userHome: string | null): string {
  const recipe = VENDOR_BENCH[vendor][role];
  if (recipe.coverage === "accepted_gap") return `No sign-in needed: ${recipe.reason}`;
  const how = recipe.signIn;
  return userHome === null ? `${loginCommandFor(vendor)} as the bench user; ${how}` : `HOME=${userHome} ${loginCommandFor(vendor)}; ${how}`;
}

/** Sets acceptedGap when the vendor's recipe accepts exactly this status. */
export function withRecipe(entry: VendorReadiness): VendorReadiness {
  const recipe = VENDOR_BENCH[entry.vendor][entry.instance];
  if (recipe.coverage !== "accepted_gap" || entry.status !== recipe.status) return entry;
  return { ...entry, acceptedGap: `${recipe.reason} (decided ${recipe.decided}; offline: ${recipe.fallbackTests.join(", ")})` };
}

/** True when a credential for the vendor lives in the bench HOME or the bench env, rather than somewhere shared such as a keychain. */
export function benchHoldsCredential(vendor: AgentVendor, userHome: string, env: Readonly<Record<string, string>>): boolean {
  const spec = vendorSpec(vendor);
  const configHome = spec.home.configHome;
  const base = configHome ? vendorConfigHome(vendor, userHome, env) : null;
  const files = spec.home.readonlySecrets.map((rel) => (configHome && base && rel.startsWith(`${configHome.rel}/`) ? join(base, rel.slice(configHome.rel.length + 1)) : join(userHome, rel)));
  const credentialEnv = VENDOR_PATHS[vendor].credentialEnv;
  const envHit = Object.keys(env).some(
    (k) => credentialEnv?.names?.includes(k) === true || credentialEnv?.prefixes?.some((p) => k.startsWith(p)) === true || credentialEnv?.pattern?.test(k) === true,
  );
  return envHit || files.some((f) => existsSync(f)) || (vendor === "agy" && existsSync(join(userHome, AGY_CLI_HOME_REL, "antigravity-oauth-token")));
}

export interface ProbeTarget {
  instance: InstanceRole;
  /** The daemon's own report for the vendor from GET /api/providers; null when the computer did not answer. */
  provider: Pick<ProviderStatusItem, "installed" | "version" | "availability" | "accountSummary"> | null;
  /** Why the computer did not answer, when provider is null. */
  unreachable?: string;
  /** Local computer only: the CLI resolved inside the bench HOME (null when missing), the bench HOME, and its env. */
  local?: { cliPath: string | null; userHome: string; env: Readonly<Record<string, string>>; installDir: string };
  platform: NodeJS.Platform;
}

/**
 * Postcondition: one VendorReadiness for `vendor` on the computer, from three facts: the CLI resolves inside the bench and
 * the daemon reports it installed with a version, the daemon's catalog reports its availability, and the daemon's status
 * shows an account. It starts no model turn and spends no tokens. `fix` names installCommandFor or loginCommandFor for that status.
 */
export function probeVendor(vendor: AgentVendor, target: ProbeTarget): VendorReadiness {
  const base = { vendor, instance: target.instance, version: target.provider?.version ?? null };
  const home = target.local?.userHome ?? null;
  if (target.provider === null) return withRecipe({ ...base, status: "unknown", detail: target.unreachable ?? `the ${target.instance} computer did not answer`, fix: "Bring the bench computer back, then rerun preflight." });
  const missing = target.local?.cliPath === null || !target.provider.installed || target.provider.availability === "not_installed";
  if (missing) {
    const record = target.local ? readInstallRecord(target.local.installDir, vendor) : null;
    if (record !== null && record.exitCode !== 0) {
      return withRecipe({ ...base, status: "install_failed", detail: `${record.command} exited ${record.exitCode} at ${record.at}\n${record.stderrTail}`, fix: installFix(vendor, target.platform) });
    }
    return withRecipe({ ...base, status: "not_installed", detail: "the CLI does not resolve inside the bench HOME", fix: installFix(vendor, target.platform) });
  }
  const availability = target.provider.availability;
  if (availability === "signed_out") return withRecipe({ ...base, status: "signed_out", detail: "installed, not signed in", fix: loginFix(vendor, target.instance, home) });
  if (availability !== "available") return withRecipe({ ...base, status: "unknown", detail: `the daemon reports ${availability}`, fix: "Open Settings, Providers on that computer and read the vendor's error." });
  if (target.local && target.platform === "darwin" && !benchHoldsCredential(vendor, target.local.userHome, target.local.env)) {
    return withRecipe({ ...base, status: "login_blocked", detail: "signed in, but no credential lives in the bench HOME or bench env; the login comes from somewhere shared such as the keychain", fix: loginFix(vendor, target.instance, home) });
  }
  return withRecipe({ ...base, status: "ready", detail: target.provider.accountSummary ?? "signed in", fix: "" });
}

/**
 * Postcondition: the non-ready entries that raise a coverage alert on every run: every non-ready entry of a `turn` vendor,
 * and every entry of an `accepted_gap` vendor whose status differs from its accepted status (for example install_failed).
 */
export function openGaps(coverage: readonly VendorReadiness[]): VendorReadiness[] {
  return coverage.filter((entry) => {
    if (entry.status === "ready") return false;
    const recipe = VENDOR_BENCH[entry.vendor][entry.instance];
    return recipe.coverage === "turn" || entry.status !== recipe.status;
  });
}
