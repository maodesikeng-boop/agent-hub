// Invariant: callers pass secrets only through `env`, never through `args`, so tokens stay out of process listings and error text.
import { execFile } from "node:child_process";
import { GH_MAX_BUFFER_BYTES } from "../../shared/limits.ts";
import { findExecutable } from "../../shared/paths.ts";
import { firstEnvKey, resolveSpawn } from "../platform/index.ts";

export type GhRunResult =
  | { kind: "ok"; stdout: string }
  | { kind: "failed"; code: string | number | null; stderr: string; timedOut: boolean; missing: boolean };

export interface GhRunOptions {
  timeoutMs: number;
  /** Extra variables merged over the daemon's environment, such as GH_TOKEN for a chosen account. */
  env?: Readonly<Record<string, string>>;
}

interface GhSpawn {
  file: string;
  args: readonly string[];
  windowsVerbatimArguments: boolean;
}

function ghSpawnOf(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): GhSpawn {
  if (process.platform !== "win32") return { file: "gh", args, windowsVerbatimArguments: false };
  const pathKey = firstEnvKey(env, "PATH");
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const found = findExecutable("gh", pathKey ? env[pathKey] : undefined, [], {
    platform: "win32",
    pathExt: pathExtKey ? env[pathExtKey] : undefined,
  });
  if (found === null) return { file: "gh", args, windowsVerbatimArguments: false };
  const spawned = resolveSpawn({ program: found, args: [...args], cwd, env }, "win32");
  return { file: spawned.file, args: spawned.args, windowsVerbatimArguments: spawned.options.windowsVerbatimArguments === true };
}

function failedOf(error: { code?: string | number | null; killed?: boolean; signal?: NodeJS.Signals | null }, stderr: string): GhRunResult {
  const timedOut = error.killed === true || error.signal === "SIGTERM" || error.signal === "SIGKILL" || error.code === "ETIMEDOUT";
  return { kind: "failed", code: error.code ?? null, stderr, timedOut, missing: error.code === "ENOENT" };
}

/**
 * Runs `gh` with prompts and update notices off, resolving the executable through PATHEXT and the cmd shim on Windows.
 * Postcondition: never rejects; a missing executable reports `missing: true`, a timeout reports `timedOut: true`,
 * and synchronous spawn errors such as EPERM report `failed`.
 */
export function execGh(cwd: string, args: readonly string[], options: GhRunOptions): Promise<GhRunResult> {
  return new Promise((done) => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", ...options.env };
      const spawn = ghSpawnOf(cwd, args, env);
      execFile(
        spawn.file,
        [...spawn.args],
        {
          cwd,
          timeout: options.timeoutMs,
          maxBuffer: GH_MAX_BUFFER_BYTES,
          env,
          windowsHide: true,
          ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (error, stdout, stderr) => done(error === null ? { kind: "ok", stdout } : failedOf(error, stderr)),
      );
    } catch (error) {
      // execFile throws errors like EPERM synchronously instead of via the callback.
      const code = (error as NodeJS.ErrnoException).code ?? null;
      done({ kind: "failed", code, stderr: "", timedOut: false, missing: code === "ENOENT" });
    }
  });
}
