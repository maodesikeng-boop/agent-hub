import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_SESSION_OWNER_TAG, STDIO_DRAIN_MS, WATCH_OUTPUT_TAIL_BYTES, WATCH_OUTPUT_TAIL_LINES } from "../../shared/limits.ts";
import { buildReadonlyPolicy, WATCH_SECRET_HOME_PATHS } from "../../shared/readonly-policy.ts";
import { dataDirReadScope } from "../../shared/write-scope.ts";
import { forceKillTree, streamClosed, termGroupAfterExit } from "../driver/process.ts";
import { kernelReadonlySandboxAvailable } from "../driver/kernel-readonly.ts";
import { prepareOsSandboxForLaunch, scanSecretGlobs, wrapInReadonlyOsSandbox, type OsSandboxWrapOptions, type ReadonlySandboxInput } from "../driver/write-scope.ts";
import { makeWatchOwnerTag, spawnOwnedProcess } from "../platform/index.ts";
import { trackChild } from "../process-ledger.ts";
import { credentialFreeEnv, outputTail, resolveSetupShell } from "../setup/setup.ts";
import type { WatchRunJob, WatchRunResult } from "./runner.ts";

export interface WatchLaunchOptions {
  dataDir: string;
  stateDir: string;
  protectedRoots?: () => readonly string[];
  /** Stable per data directory, so the owner tag of a watch process survives a daemon restart. */
  tagNonce: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  sandboxAvailable?: () => boolean;
  wrap?: Pick<OsSandboxWrapOptions, "disableWin32Mxc">;
  baseEnv?: Record<string, string | undefined>;
}

const NO_SANDBOX = "这台电脑建不起只读沙箱，命令没跑";

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The command may read the project and reach the network, but writes only to its own temporary folder and cannot read the
 * data directory or the read-only Worker's home credential list, except code host logins: a watch exists to ask outside
 * services with the user's own tools. Hub tokens and model credentials are removed from its environment.
 */
async function sandboxInput(options: WatchLaunchOptions, cwd: string, tmpDir: string): Promise<ReadonlySandboxInput> {
  const dataDir = realOrSelf(options.dataDir);
  const policy = buildReadonlyPolicy({
    homeDir: realOrSelf(options.homeDir ?? homedir()), homeSecrets: WATCH_SECRET_HOME_PATHS, stateDir: options.stateDir, env: options.baseEnv ?? process.env,
  });
  return {
    tmpDir,
    stateDir: options.stateDir,
    protectedRoots: [dataDir, ...(options.protectedRoots?.() ?? [])],
    writableDirs: [],
    writableFileRegexes: [],
    secretPaths: [...new Set([...policy.secretPaths, ...(await scanSecretGlobs([cwd], policy.secretGlobs))])],
    secretGlobs: policy.secretGlobs,
    dataDirScope: dataDirReadScope({ dataDir }),
  };
}

const wrapOptionsOf = (options: WatchLaunchOptions): OsSandboxWrapOptions => ({
  ...options.wrap, env: options.baseEnv ?? process.env,
});

/** Prepares the OS sandbox and returns the wrapped shell command; null when this computer cannot build the sandbox. */
export async function watchSandboxLaunch(
  options: WatchLaunchOptions, job: Pick<WatchRunJob, "command" | "cwd">, tmpDir: string,
): Promise<{ command: string; args: string[] } | null> {
  const platform = options.platform ?? process.platform;
  const env = options.baseEnv ?? process.env;
  const wrapOptions = { ...wrapOptionsOf(options), available: true };
  if (!kernelReadonlySandboxAvailable(platform, wrapOptions)) return null;
  const input = await sandboxInput(options, job.cwd, tmpDir);
  const readonly = {
    secretPaths: input.secretPaths, secretGlobs: input.secretGlobs, connectors: { extraAllow: [], deny: [] },
    stateDir: options.stateDir, protectedRoots: [...(input.protectedRoots ?? [])], ...(input.dataDirScope === undefined ? {} : { dataDirScope: input.dataDirScope }),
  };
  await prepareOsSandboxForLaunch({ dataDir: options.dataDir, stateDir: options.stateDir, writeScope: null, readonly }, platform, { env });
  const shell = resolveSetupShell(job.command, env, undefined, platform);
  const launch = wrapInReadonlyOsSandbox({ command: shell.program, args: shell.args }, input, platform, wrapOptions);
  return launch.osSandboxed ? { command: launch.command, args: launch.args } : null;
}

export function createWatchCommandRunner(options: WatchLaunchOptions): (job: WatchRunJob) => Promise<WatchRunResult> {
  const baseEnv = options.baseEnv ?? process.env;
  return async (job) => {
    const available = options.sandboxAvailable?.() ?? kernelReadonlySandboxAvailable(options.platform ?? process.platform, wrapOptionsOf(options));
    if (!available) return { kind: "error", reason: NO_SANDBOX, outputTail: "" };
    const tmpDir = realOrSelf(mkdtempSync(join(tmpdir(), `bellwood-watch-${job.watchId}-`)));
    try {
      const launch = await watchSandboxLaunch(options, job, tmpDir);
      if (launch === null) return { kind: "error", reason: NO_SANDBOX, outputTail: "" };
      const env = {
        ...credentialFreeEnv(baseEnv),
        TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir,
        [ENV_SESSION_OWNER_TAG]: makeWatchOwnerTag(job.watchId, options.tagNonce, baseEnv[ENV_SESSION_OWNER_TAG]),
      };
      return await runChild(launch.command, launch.args, job, env);
    } catch (error) {
      return { kind: "error", reason: `命令起不来：${errorText(error)}`, outputTail: "" };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

async function runChild(program: string, args: string[], job: WatchRunJob, env: Record<string, string>): Promise<WatchRunResult> {
  const keepBytes = WATCH_OUTPUT_TAIL_BYTES * 2;
  let kept = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk]);
    if (kept.length > keepBytes) kept = kept.subarray(kept.length - keepBytes);
  };
  const tail = () => outputTail(kept, WATCH_OUTPUT_TAIL_LINES, WATCH_OUTPUT_TAIL_BYTES);

  const spawned = spawnOwnedProcess(program, args, { cwd: job.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const child = spawned.child as ChildProcessWithoutNullStreams;
  trackChild(child, `watch:${job.watchId}`, { detached: spawned.detached });
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const killed: { why: "timed_out" | "stopped" | null; done: Promise<void> } = { why: null, done: Promise.resolve() };
  const kill = (why: "timed_out" | "stopped") => {
    if (killed.why !== null || child.pid === undefined) return;
    killed.why = why;
    killed.done = forceKillTree(child.pid, true);
  };
  const timer = setTimeout(() => kill("timed_out"), Math.max(0, job.timeoutMs));
  const onAbort = () => kill("stopped");
  if (job.signal.aborted) onAbort();
  job.signal.addEventListener("abort", onAbort, { once: true });

  const exited = await new Promise<{ code: number | null } | { error: Error }>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code) => {
      termGroupAfterExit(child);
      resolve({ code });
    });
  });
  clearTimeout(timer);
  job.signal.removeEventListener("abort", onAbort);
  if ("error" in exited) return { kind: "error", reason: `命令起不来：${exited.error.message}`, outputTail: "" };
  await killed.done;
  const drain = setTimeout(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  }, STDIO_DRAIN_MS);
  await Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
  clearTimeout(drain);

  if (killed.why !== null) return { kind: killed.why, outputTail: tail() };
  return { kind: "exited", exitCode: exited.code, outputTail: tail() };
}
