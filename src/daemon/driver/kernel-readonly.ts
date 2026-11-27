import { osSandboxAvailable, win32MxcReadonlyAvailable, type OsSandboxWrapOptions } from "./write-scope.ts";

/**
 * Whether a read-only sandbox that the OS enforces in full can be built here, for a launch with no vendor tool layer behind
 * it. On Windows that needs MXC: the fallback leaves writes outside the protected roots and home credential reads to that layer.
 */
export function kernelReadonlySandboxAvailable(platform: NodeJS.Platform = process.platform, options?: OsSandboxWrapOptions): boolean {
  if (!(options?.available ?? osSandboxAvailable(platform))) return false;
  return platform !== "win32" || win32MxcReadonlyAvailable(options);
}
