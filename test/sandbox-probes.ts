import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_EXEC } from "../src/daemon/driver/write-scope.ts";

/** `pnpm test:related` sets this to a file that collects the test files a sandbox refusal made skip. */
export const SANDBOX_SKIP_LOG_ENV = "BELLWOOD_SANDBOX_SKIP_LOG";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_FRAME = /^\s*at (?:.*? \()?(.+?\.test\.tsx?):\d+:\d+\)?\s*$/;
const WINDOWS_PATH = /^(?:file:\/\/\/)?[A-Za-z]:[\\/]/;

const PERMISSION_DENIED_CODES = new Set(["EPERM", "EACCES"]);
const PERMISSION_DENIED_TEXT = /operation not permitted|permission denied/i;

function isPermissionRefusal(command: string, error: unknown): boolean {
  const failure = error as { code?: unknown; status?: unknown; stderr?: unknown } | null;
  const stderr = String(failure?.stderr ?? "");
  if (command === SANDBOX_EXEC) return failure?.status === 71 && /operation not permitted/i.test(stderr);
  return (typeof failure?.code === "string" && PERMISSION_DENIED_CODES.has(failure.code)) || PERMISSION_DENIED_TEXT.test(stderr);
}

/** The test file that called a probe, read from the stack so callers need no extra argument. */
export function callingTestFile(stack: string | undefined, repoRoot = REPO_ROOT): string | undefined {
  const location = stack?.split("\n").map((line) => TEST_FRAME.exec(line)?.[1]).find((file) => file !== undefined);
  if (location === undefined) return undefined;
  const windows = WINDOWS_PATH.test(location);
  const path = location.startsWith("file://") ? fileURLToPath(location, { windows }) : location;
  return (windows ? win32 : posix).relative(repoRoot, path).split("\\").join("/");
}

function recordRefusal(env: NodeJS.ProcessEnv): void {
  const log = env[SANDBOX_SKIP_LOG_ENV];
  if (!log) return;
  appendFileSync(log, `${callingTestFile(new Error().stack) ?? "<unknown test file>"}\n`);
}

export function sandboxAllows(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    if (isPermissionRefusal(command, error)) {
      recordRefusal(env);
      return false;
    }
    if (env.CI) return true;
    throw error;
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
