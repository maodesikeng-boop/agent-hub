// Invariant: outer read-only enforcement on Windows requires MXC ProcessContainer and never degrades to tool-layer checks.
import { vendorSpec, type AgentVendor } from "../../shared/vendors.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  osSandboxAvailable,
  win32MxcReadonlyAvailable,
  type OsSandboxWrapOptions,
} from "./write-scope.ts";

export type ReadonlySandboxEnforcement = "vendor_native" | "outer_os_sandbox";
export type ReadonlySandboxRejectCode = "sandbox_unavailable" | "win32_mxc_unavailable";

export const WIN32_READONLY_NEEDS_MXC_MESSAGE =
  "当前 Windows 环境缺少 MXC ProcessContainer 支持（需要 Windows 11 24H2+、Node >= 24.21.0 且启用容器支持），无法在操作系统层强制全盘只读并阻断外部凭据读取，已拒绝启动只读会话（不降级为规则兜底）。请升级到 Windows 11 24H2+ 并启用容器支持，或改用自带只读沙箱的 codex 运行此只读任务。";

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

export function vendorNeedsOuterReadonlySandbox(
  vendor: AgentVendor,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const mode = vendorSpec(vendor).capabilities.readonly;
  if (mode === "driver") return false;
  if (mode === "settings") return platform === "win32";
  return true;
}

export function checkReadonlyWorkerSandbox(
  input: ReadonlyWorkerSandboxCheckInput,
): ReadonlyWorkerSandboxCheckResult {
  const platform = input.platform ?? process.platform;
  if (!input.osSandboxed) {
    return { ok: false, code: "sandbox_unavailable", message: WORKER_NEEDS_OS_SANDBOX_MESSAGE };
  }
  if (!vendorNeedsOuterReadonlySandbox(input.vendor, platform)) {
    return { ok: true, enforcement: "vendor_native" };
  }
  if (!input.readonlyKernelSandboxed) {
    if (platform === "win32") {
      return { ok: false, code: "win32_mxc_unavailable", message: WIN32_READONLY_NEEDS_MXC_MESSAGE };
    }
    return { ok: false, code: "sandbox_unavailable", message: WORKER_NEEDS_OS_SANDBOX_MESSAGE };
  }
  return { ok: true, enforcement: "outer_os_sandbox" };
}

export function readonlySandboxUnavailableMessage(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? WIN32_READONLY_NEEDS_MXC_MESSAGE : WORKER_NEEDS_OS_SANDBOX_MESSAGE;
}
