// Invariant: outer read-only enforcement on Windows requires MXC ProcessContainer and never degrades to tool-layer checks.
import type { AgentVendor } from "../../shared/vendors.ts";
import { osSandboxAvailable, win32MxcReadonlyAvailable, type OsSandboxWrapOptions } from "./write-scope.ts";

export type ReadonlySandboxEnforcement = "vendor_native" | "outer_os_sandbox";
export type ReadonlySandboxRejectCode = "sandbox_unavailable" | "win32_mxc_unavailable";

export interface ReadonlyWorkerSandboxCheckInput {
  vendor: AgentVendor;
  platform?: NodeJS.Platform;
  osSandboxed: boolean;
  readonlyKernelSandboxed: boolean;
}

export type ReadonlyWorkerSandboxCheckResult =
  | { ok: true; enforcement: ReadonlySandboxEnforcement }
  | { ok: false; code: ReadonlySandboxRejectCode; message: string };

/**
 * Whether a read-only sandbox that the OS enforces in full can be built here, for a launch with no vendor tool layer behind
 * it. On Windows that needs MXC: without MXC, full-disk read-only and external credential read denial cannot be enforced at the OS layer.
 */
export function kernelReadonlySandboxAvailable(platform: NodeJS.Platform = process.platform, options?: OsSandboxWrapOptions): boolean {
  if (!(options?.available ?? osSandboxAvailable(platform))) return false;
  return platform !== "win32" || win32MxcReadonlyAvailable(options);
}

/**
 * Precondition: vendor is a registered AgentVendor and platform is a NodeJS.Platform.
 * Postcondition: returns true when read-only sessions for vendor on platform require Bellwood's outer read-only OS sandbox,
 * and false when the vendor enforces read-only natively on that platform.
 */
export function vendorNeedsOuterReadonlySandbox(
  _vendor: AgentVendor,
  _platform: NodeJS.Platform = process.platform,
): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: input describes the requested vendor, target platform, and current sandbox probe states.
 * Postcondition: returns ok with the enforcement kind when kernel-level read-only isolation can be guaranteed,
 * or ok: false with a stable reject code and actionable message instead of permitting silent degradation.
 */
export function checkReadonlyWorkerSandbox(
  _input: ReadonlyWorkerSandboxCheckInput,
): ReadonlyWorkerSandboxCheckResult {
  throw new Error("Not implemented");
}

/**
 * Precondition: platform is the host platform where an outer read-only sandbox could not be built.
 * Postcondition: returns an actionable user-facing message explaining why the read-only launch was refused and how to resolve it.
 */
export function readonlySandboxUnavailableMessage(_platform: NodeJS.Platform = process.platform): string {
  throw new Error("Not implemented");
}
