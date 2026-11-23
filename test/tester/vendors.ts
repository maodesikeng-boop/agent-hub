// Vendor coverage on the bench: every vendor in VENDOR_LIST, on every bench computer, installed and signed in from the
// bench's own HOME. Install commands and login commands come from the product (VENDOR_PATHS and each spec's cli),
// so the bench installs exactly what a user installs. Only the model choice and bench-only notes live here.
// Invariant: coverage always has one entry per vendor per computer; a vendor that cannot be installed or signed in
// appears with its status, reason, and fix, and is never left out.
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
  /** Set when the owner recorded in bench.json that this gap is accepted for now; it is still listed in every summary. */
  acceptedGap?: string;
}

export interface VendorBenchRecipe {
  /** Model the turn flow uses: the cheapest one the vendor offers, or null for the account default. */
  model: string | null;
  /** Bench-only notes for the owner, such as which account or API key the vendor needs. */
  account: string;
}

/** A Record over AgentVendor, so adding a vendor to VENDOR_LIST fails typecheck until its bench recipe exists. */
export const VENDOR_BENCH: Readonly<Record<AgentVendor, VendorBenchRecipe>> = {
  claude: { model: "haiku", account: "Claude subscription; sign in with `claude setup-token` and give the daemon CLAUDE_CODE_OAUTH_TOKEN from <root>/secrets." },
  agy: { model: "gemini-3.8-flash", account: "Google account through `agy`, or GEMINI_API_KEY." },
  codex: { model: null, account: "ChatGPT plan through `codex login --device-auth` with CODEX_HOME inside the bench HOME." },
  pi: { model: "deepseek/deepseek-flash", account: "Run `pi`, then /login; a DeepSeek API key keeps it cheap." },
  deepseek: { model: "deepseek-flash", account: "DEEPSEEK_API_KEY written to <bench HOME>/.dsh/.env." },
  cursor: { model: "gemini-3.8-flash", account: "Cursor account through `NO_OPEN_BROWSER=1 cursor-agent login`." },
  opencode: { model: "opencode/big-pickle", account: "`opencode auth login`, or OPENCODE_API_KEY." },
  kimi: { model: "kimi-code/k3", account: "Kimi account through `kimi login` (device code)." },
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

/** Postcondition: the non-ready entries whose gap the owner has not accepted; these raise a coverage alert on every run. */
export function openGaps(coverage: readonly VendorReadiness[]): VendorReadiness[] {
  throw new Error("Not implemented");
}
