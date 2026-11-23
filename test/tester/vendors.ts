// Vendor coverage on the bench: every vendor in VENDOR_LIST, on every bench computer, installed from the bench's own HOME.
// Install commands and login commands come from the product (VENDOR_PATHS and each spec's cli), so the bench installs
// exactly what a user installs. This file holds only the owner's coverage decision per vendor.
// Invariant: coverage always has one entry per vendor per computer; a vendor that cannot be installed or signed in
// appears with its status, reason, and fix, and is never left out. An accepted gap stops only the alert, never the listing.
import type { AgentVendor } from "../../src/shared/vendors.ts";
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

const NO_TEST_ACCOUNTS = "The owner has no account for this vendor and does not open accounts for testing.";
const fallbackTests = (vendor: AgentVendor): readonly string[] => [`src/vendors/${vendor}/${vendor}.test.ts`, "src/vendors/contract.test.ts"];

/** A Record over AgentVendor, so adding a vendor to VENDOR_LIST fails typecheck until the owner's coverage decision for it exists. */
export const VENDOR_BENCH: Readonly<Record<AgentVendor, VendorBenchRecipe>> = {
  claude: { coverage: "turn", model: "haiku", signIn: "`claude setup-token` once; both computers get CLAUDE_CODE_OAUTH_TOKEN from <root>/secrets." },
  agy: { coverage: "turn", model: "gemini-3.8-flash", signIn: "Run `agy` and paste the code with the owner's Google account." },
  codex: { coverage: "turn", model: null, signIn: "`codex login --device-auth` with the owner's ChatGPT plan, CODEX_HOME inside the bench HOME." },
  pi: { coverage: "turn", model: null, signIn: "Run `pi`, then /login with one of the owner's existing subscriptions." },
  cursor: { coverage: "accepted_gap", status: "signed_out", reason: "The owner cannot use Cursor.", decided: "2026-11-23", fallbackTests: fallbackTests("cursor") },
  deepseek: { coverage: "accepted_gap", status: "signed_out", reason: NO_TEST_ACCOUNTS, decided: "2026-11-23", fallbackTests: fallbackTests("deepseek") },
  opencode: { coverage: "accepted_gap", status: "signed_out", reason: NO_TEST_ACCOUNTS, decided: "2026-11-23", fallbackTests: fallbackTests("opencode") },
  kimi: { coverage: "accepted_gap", status: "signed_out", reason: NO_TEST_ACCOUNTS, decided: "2026-11-23", fallbackTests: fallbackTests("kimi") },
};

/** Postcondition: the product's install command for `vendor` on `platform`: windowsInstallCommand on win32, else installCommand. Throws when the vendor ships none. */
export function installCommandFor(vendor: AgentVendor, platform: NodeJS.Platform): string {
  throw new Error("Not implemented");
}

/** Postcondition: the product's headless login command for `vendor`, falling back to its spec's cli.loginCommand. */
export function loginCommandFor(vendor: AgentVendor): string {
  throw new Error("Not implemented");
}

/**
 * Runs the product's install command with HOME set to the bench HOME (and npm's global prefix inside it), so nothing
 * lands in the developer's own tool directories.
 * Postcondition: `ready`, `signed_out`, or `install_failed` with the command's exit code and the last 20 stderr lines in detail.
 */
export async function installVendor(vendor: AgentVendor, bench: { instance: InstanceRole; userHome: string; platform: NodeJS.Platform }): Promise<VendorReadiness> {
  throw new Error("Not implemented");
}

/**
 * Postcondition: one VendorReadiness for `vendor` on the computer, from three facts: the CLI resolves and prints a version,
 * the daemon's catalog reports its availability, and the vendor's own status command reports a signed-in account.
 * It starts no model turn and spends no tokens. `fix` names installCommandFor or loginCommandFor for that status.
 */
export async function probeVendor(vendor: AgentVendor, target: { instance: InstanceRole; catalogAvailability: string | null; userHome: string; platform: NodeJS.Platform }): Promise<VendorReadiness> {
  throw new Error("Not implemented");
}

/**
 * Postcondition: the non-ready entries that raise a coverage alert on every run: every non-ready entry of a `turn` vendor,
 * and every entry of an `accepted_gap` vendor whose status differs from its accepted status (for example install_failed).
 */
export function openGaps(coverage: readonly VendorReadiness[]): VendorReadiness[] {
  throw new Error("Not implemented");
}
