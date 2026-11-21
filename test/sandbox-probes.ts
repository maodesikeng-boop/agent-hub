// A macOS Worker sandbox refuses to exec the setuid /bin/ps and to apply a nested sandbox-exec profile, so tests that need
// either skip there. Only a permission refusal counts: on CI any other failure keeps the test running so it fails loudly.
import { execFileSync } from "node:child_process";
import { SANDBOX_EXEC } from "../src/daemon/driver/write-scope.ts";

const PERMISSION_DENIED_CODES = new Set(["EPERM", "EACCES"]);
const PERMISSION_DENIED_TEXT = /operation not permitted|permission denied/i;

export function isPermissionRefusal(error: unknown): boolean {
  const failure = error as { code?: unknown; stderr?: unknown };
  return (typeof failure.code === "string" && PERMISSION_DENIED_CODES.has(failure.code)) || PERMISSION_DENIED_TEXT.test(String(failure.stderr ?? ""));
}

export function sandboxAllows(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    return !isPermissionRefusal(error) && Boolean(env.CI);
  }
}

let psAllowed: boolean | undefined;
let nestedSandboxAllowed: boolean | undefined;

/** Windows has no ps, and its code paths do not use it. */
export function sandboxAllowsPs(): boolean {
  if (process.platform === "win32") return true;
  psAllowed ??= sandboxAllows("ps", ["-o", "pid=", "-p", String(process.pid)]);
  return psAllowed;
}

/** Whether the daemon can wrap a Worker in sandbox-exec here; only macOS nests its sandbox this way. */
export function sandboxAllowsNestedSandbox(): boolean {
  if (process.platform !== "darwin") return true;
  nestedSandboxAllowed ??= sandboxAllows(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]);
  return nestedSandboxAllowed;
}
