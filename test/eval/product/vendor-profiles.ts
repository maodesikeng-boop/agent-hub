// Exhaustive cross-vendor evaluation profile registry and isolated mock-server launch contracts.
// Invariant: every registered AgentVendor has an explicit profile and coverage row with zero silent skips.
import type { AgentVendor } from "../../../src/shared/vendors.ts";
import type { VendorCoverageRow, VendorEvalProfile, VendorMockLaunchConfig } from "./types.ts";

/**
 * Postcondition: returns an exhaustive map covering every registered AgentVendor in VENDOR_LIST.
 * Each profile declares its Tier 1 mock-server protocol, prompt-cache check capability, and Tier 2 replay support.
 */
export function getVendorEvalProfiles(): Readonly<Record<AgentVendor, VendorEvalProfile>> {
  throw new Error("Not implemented");
}

/**
 * Precondition: vendor is a registered AgentVendor.
 * Postcondition: returns the matching VendorEvalProfile without mutating global state.
 */
export function getVendorEvalProfile(_vendor: AgentVendor): VendorEvalProfile {
  throw new Error("Not implemented");
}

/**
 * Precondition: serverUrl is a loopback http://127.0.0.1:<port> URL and scratchHome is an isolated directory outside user home.
 * Postcondition: returns isolated env vars and relative config files pointing the vendor CLI at serverUrl without touching real user config,
 * or supported: false with a non-empty unsupportedReason when the vendor uses fake_driver_contract for Tier 1.
 * Throws RangeError if serverUrl is not a loopback address.
 */
export function resolveVendorMockEnv(
  _vendor: AgentVendor,
  _serverUrl: string,
  _scratchHome: string,
): VendorMockLaunchConfig {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns one coverage row per registered AgentVendor in VENDOR_LIST order so coverage gaps are always visible.
 */
export function buildVendorCoverageMatrix(
  _profiles?: Readonly<Record<AgentVendor, VendorEvalProfile>>,
): VendorCoverageRow[] {
  throw new Error("Not implemented");
}
