import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { createConnection } from "node:net";
import { basename, win32 } from "node:path";
import { PS_TIMEOUT_MS, WIN_HELPER_PROBE_TIMEOUT_MS } from "../../../shared/limits.ts";
import { findWinHelperBinary, requireWinHelperBinary } from "./helper-bins.ts";
import { createWin32ControlPipeName } from "./ipc-endpoint.ts";
import { resolveSpawn, type ProcessSpawnSpec } from "./spawn-resolution.ts";

/** Maps a spawned `fusa-run.exe` ChildProcess to its private control pipe (`interrupt` / `kill`). */
const childControlPipes = new WeakMap< object, string >();
/** Tracks active `fusa-run.exe` ChildProcess instances by PID so `forceKillTree(pid)` can close the Job handle directly. */
const liveFusaRunByPid = new Map<number, ChildProcess>();

function isFusaRunBinary(program: string): boolean {
  const base = basename(program.replace(/\\/g, "/")).toLowerCase();
  return base === "fusa-run" || base === "fusa-run.exe";
}

export interface SpawnOwnedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
  platform?: NodeJS.Platform;
  /** Allow fallback when helper binary is absent in synthetic unit tests. */
  allowMissingHelperFallback?: boolean;
}

export interface SpawnedOwnedChild<T extends ChildProcess = ChildProcess> {
  child: T;
  /** True on POSIX (own process group); false on Windows (`fusa-run` stays in libuv's Job so daemon crash kills it). */
  detached: boolean;
  ctrlPipe?: string;
}

/**
 * Unified session / probe / setup process spawner:
 * - POSIX: `spawn(program, args, { detached: true, shell: false })` (existing behavior, zero change);
 * - Windows: resolves `.cmd` shims (`resolveSpawn`), wraps in `fusa-run.exe --ctrl-pipe <pipe> -- <resolved>`,
 *   spawns with `detached: false, windowsHide: true, shell: false` so `fusa-run` stays in Node's libuv Job Object
 *   and puts the target tree in a `KILL_ON_JOB_CLOSE` Job Object!
 *   When `program` is already `fusa-run.exe` (wrapped by `spawnInWriteScope`), resolves the inner target after `--`
 *   and injects `--ctrl-pipe <pipe>` before `--` so there is still only ONE `fusa-run.exe` per session.
 */
export function spawnOwnedProcess(
  program: string,
  args: readonly string[],
  options: SpawnOwnedOptions & { stdio: ["pipe", "pipe", "pipe"] },
): SpawnedOwnedChild<ChildProcessWithoutNullStreams>;
export function spawnOwnedProcess(
  program: string,
  args: readonly string[],
  options?: SpawnOwnedOptions,
): SpawnedOwnedChild<ChildProcess>;
export function spawnOwnedProcess(
  program: string,
  args: readonly string[],
  options: SpawnOwnedOptions = {},
): SpawnedOwnedChild<ChildProcess> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    return { child, detached: true };
  }

  const env = options.env ?? process.env;
  const ctrlPipe = createWin32ControlPipeName();

  if (isFusaRunBinary(program)) {
    const sepIdx = args.indexOf("--");
    let finalArgs: string[];
    let spawnEnv = env;
    if (sepIdx >= 0 && args[sepIdx + 1] !== undefined) {
      const headArgs = args.slice(0, sepIdx);
      const innerProgram = args[sepIdx + 1]!;
      const innerArgs = args.slice(sepIdx + 2);
      const resolvedInner = resolveSpawn(
        { program: innerProgram, args: innerArgs, cwd: options.cwd, env },
        "win32",
      );
      if (resolvedInner.options.env) {
        spawnEnv = resolvedInner.options.env;
      }
      finalArgs = [
        ...headArgs,
        "--ctrl-pipe",
        ctrlPipe,
        ...(resolvedInner.rawCmdTail ? ["--raw-tail", resolvedInner.rawCmdTail] : []),
        "--",
        resolvedInner.file,
        ...(resolvedInner.rawCmdTail ? [] : resolvedInner.args),
      ];
    } else {
      finalArgs = ["--ctrl-pipe", ctrlPipe, ...args];
    }

    const child = spawn(program, finalArgs, {
      cwd: options.cwd,
      env: spawnEnv,
      stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      shell: false,
    });
    registerWin32OwnedChild(child, ctrlPipe);
    return { child, detached: false, ctrlPipe };
  }

  const spec: ProcessSpawnSpec = {
    program,
    args,
    cwd: options.cwd,
    env,
    stdio: options.stdio,
    detached: false,
  };
  const resolved = resolveSpawn(spec, "win32");
  const helper = options.allowMissingHelperFallback
    ? findWinHelperBinary("fusa-run.exe", { env })
    : requireWinHelperBinary("fusa-run.exe", { env });

  if (helper === null) {
    const fallbackChild = spawn(resolved.file, resolved.args, resolved.options);
    return { child: fallbackChild, detached: false };
  }

  const fusaArgs = [
    "--ctrl-pipe",
    ctrlPipe,
    ...(resolved.rawCmdTail ? ["--raw-tail", resolved.rawCmdTail] : []),
    "--",
    resolved.file,
    ...(resolved.rawCmdTail ? [] : resolved.args),
  ];
  const child = spawn(helper, fusaArgs, {
    cwd: options.cwd,
    env: resolved.options.env ?? env,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
    shell: false,
  });
  registerWin32OwnedChild(child, ctrlPipe);
  return { child, detached: false, ctrlPipe };
}

function registerWin32OwnedChild(child: ChildProcess, ctrlPipe: string): void {
  childControlPipes.set(child, ctrlPipe);
  const pid = child.pid;
  if (pid !== undefined) {
    liveFusaRunByPid.set(pid, child);
    child.once("exit", () => {
      if (liveFusaRunByPid.get(pid) === child) {
        liveFusaRunByPid.delete(pid);
      }
    });
  }
}

/** Sends `"interrupt\n"` (`CTRL_C_EVENT`) to a `fusa-run.exe` child via its control pipe; returns true if Pipe exists. */
export function sendWin32Interrupt(child: Pick<ChildProcess, "pid" | "kill">): boolean {
  const pipeName = childControlPipes.get(child);
  if (!pipeName) return false;
  const sock = createConnection(pipeName);
  sock.on("error", () => {
    sock.destroy();
  });
  sock.once("connect", () => {
    sock.end("interrupt\n");
  });
  sock.unref();
  return true;
}

function systemTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const sysRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return win32.join(sysRoot, "System32", "taskkill.exe");
}

export function runWin32TaskkillTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      execFile(
        systemTaskkillPath(),
        ["/pid", String(pid), "/t", "/f"],
        { timeout: PS_TIMEOUT_MS, windowsHide: true },
        () => resolve(),
      );
    } catch {
      resolve();
    }
  });
}

/** Terminates a Windows process tree: closes `fusa-run` (killing its Job Object) and falls back to `taskkill /t /f`. */
export async function killWin32ProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const owned = liveFusaRunByPid.get(pid);
  if (owned) {
    try {
      owned.kill();
    } catch {
      // Already exited
    }
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // Ignore ESRCH
  }
  await runWin32TaskkillTree(pid);
}

/** Queries process creation timestamp synchronously (`ps -o lstart=` on POSIX, `fusa-run inspect` on Windows). */
export function queryProcessStartTimeSync(
  pid: number,
  options?: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> },
): string | null {
  const platform = options?.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform !== "win32") {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: PS_TIMEOUT_MS,
        env: { ...process.env, ...options?.env, LC_ALL: "C" },
      }).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  }

  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return null;
  try {
    const out = execFileSync(helper, ["inspect", "--pid", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: WIN_HELPER_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = JSON.parse(out) as { alive?: unknown; creationTime?: unknown };
    return parsed.alive === true && typeof parsed.creationTime === "string" && parsed.creationTime !== ""
      ? parsed.creationTime
      : null;
  } catch {
    return null;
  }
}

/** Queries process creation timestamp asynchronously (`ps -o lstart=` on POSIX, `fusa-run inspect` on Windows). */
export function queryProcessStartTime(
  pid: number,
  options?: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> },
): Promise<string | null> {
  const platform = options?.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (platform !== "win32") {
    return new Promise((resolve) => {
      try {
        execFile(
          "ps",
          ["-o", "lstart=", "-p", String(pid)],
          {
            timeout: PS_TIMEOUT_MS,
            killSignal: "SIGKILL",
            env: { ...process.env, ...options?.env, LC_ALL: "C" },
          },
          (err, stdout) => {
            if (err) return resolve(null);
            const text = stdout.trim();
            resolve(text === "" ? null : text);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  const helper = findWinHelperBinary("fusa-run.exe", { env: options?.env });
  if (helper === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        helper,
        ["inspect", "--pid", String(pid)],
        {
          timeout: WIN_HELPER_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (err, stdout) => {
          if (err) return resolve(null);
          try {
            const parsed = JSON.parse(stdout) as { alive?: unknown; creationTime?: unknown };
            resolve(
              parsed.alive === true && typeof parsed.creationTime === "string" && parsed.creationTime !== ""
                ? parsed.creationTime
                : null,
            );
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}
