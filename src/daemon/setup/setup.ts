import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { basename, dirname, win32 } from "node:path";
import type { SessionId, SetupOutcome, WorkerId } from "../../shared/index.ts";
import {
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  KILL_WAIT_MS,
  LOG_PREFIX,
  SETUP_LOG_MAX_BYTES,
  SETUP_OUTPUT_TAIL_BYTES,
  SETUP_OUTPUT_TAIL_LINES,
  SETUP_TIMEOUT_MS,
  STDIO_DRAIN_MS,
} from "../../shared/index.ts";
import { findExecutable } from "../../shared/paths.ts";
import { forceKillTree, streamClosed, termGroupAfterExit } from "../driver/process.ts";
import { buildChildEnv } from "../driver/protocol.ts";
import { firstEnvKey, spawnOwnedProcess } from "../platform/index.ts";
import { trackChild } from "../process-ledger.ts";
import { VENDOR_PATHS } from "../../vendors/paths-registry.ts";

// Setup commands must not inherit hub or model credentials from the parent session.
const CREDENTIAL_ENV = Object.values(VENDOR_PATHS).flatMap((paths) => paths.credentialEnv ?? []);
const SETUP_ENV_DENY_PREFIXES = ["HUB_", "AGENT_HUB_", ...CREDENTIAL_ENV.flatMap((c) => c.prefixes ?? [])];
const SETUP_ENV_DENY_NAMES = CREDENTIAL_ENV.flatMap((c) => c.names ?? []);
const SETUP_ENV_DENY_PATTERNS = CREDENTIAL_ENV.flatMap((c) => c.pattern ?? []);

function deniedSetupEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    SETUP_ENV_DENY_NAMES.includes(upper) || SETUP_ENV_DENY_PREFIXES.some((p) => upper.startsWith(p)) || SETUP_ENV_DENY_PATTERNS.some((p) => p.test(upper))
  );
}

export interface ResolvedSetupShell {
  program: string;
  args: string[];
  label: string;
}

function isWslSystemBash(candidatePath: string): boolean {
  return /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(candidatePath);
}

function buildShellArgsForBinary(shellBin: string, command: string): ResolvedSetupShell {
  const lower = basename(shellBin.replace(/\\/g, "/")).toLowerCase();
  if (lower === "cmd" || lower === "cmd.exe") {
    return { program: shellBin, args: ["/d", "/s", "/c", command], label: shellBin };
  }
  if (lower === "pwsh" || lower === "pwsh.exe" || lower === "powershell" || lower === "powershell.exe") {
    return {
      program: shellBin,
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      label: shellBin,
    };
  }
  return { program: shellBin, args: ["-c", command], label: shellBin };
}

/** Windows prefers Git Bash and skips the WSL bash under %SystemRoot% because it runs in a different filesystem. */
export function resolveSetupShell(
  command: string,
  env: Record<string, string | undefined>,
  explicitShell?: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): ResolvedSetupShell {
  if (explicitShell && explicitShell.trim() !== "") {
    return buildShellArgsForBinary(explicitShell.trim(), command);
  }
  if (platform !== "win32") {
    const sh = env.SHELL || "/bin/sh";
    return { program: sh, args: ["-c", command], label: sh };
  }

  const pathKey = firstEnvKey(env as NodeJS.ProcessEnv, "PATH");
  const envPath = pathKey ? env[pathKey] : undefined;
  const pathExtKey = firstEnvKey(env as NodeJS.ProcessEnv, "PATHEXT");
  const pathExt = pathExtKey ? env[pathExtKey] : undefined;

  const progFiles = env.ProgramFiles || "C:\\Program Files";
  const progFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localApp = env.LOCALAPPDATA;
  const gitBashCandidates = [
    win32.join(progFiles, "Git", "bin", "bash.exe"),
    win32.join(progFiles, "Git", "usr", "bin", "bash.exe"),
    ...(localApp ? [win32.join(localApp, "Programs", "Git", "bin", "bash.exe")] : []),
    win32.join(progFilesX86, "Git", "bin", "bash.exe"),
  ];
  for (const candidate of gitBashCandidates) {
    if (exists(candidate)) {
      return { program: candidate, args: ["-c", command], label: `Git Bash (${candidate})` };
    }
  }
  if (exists === existsSync) {
    const pathBash = findExecutable("bash.exe", envPath, [], { platform: "win32", pathExt });
    if (pathBash && !isWslSystemBash(pathBash)) {
      return { program: pathBash, args: ["-c", command], label: `Git Bash (${pathBash})` };
    }
  }

  const pwshCandidates = [win32.join(progFiles, "PowerShell", "7", "pwsh.exe")];
  for (const candidate of pwshCandidates) {
    if (exists(candidate)) {
      return {
        program: candidate,
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        label: `PowerShell 7 (${candidate})`,
      };
    }
  }
  if (exists === existsSync) {
    const pathPwsh = findExecutable("pwsh.exe", envPath, [], { platform: "win32", pathExt });
    if (pathPwsh) {
      return {
        program: pathPwsh,
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        label: `PowerShell 7 (${pathPwsh})`,
      };
    }
  }

  const comSpecKey = firstEnvKey(env as NodeJS.ProcessEnv, "ComSpec");
  const comSpec = (comSpecKey ? env[comSpecKey] : undefined) || win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  return { program: comSpec, args: ["/d", "/s", "/c", command], label: `cmd (${comSpec})` };
}

export function buildSetupEnv(
  base: Record<string, string | undefined>,
  paths: { rootPath: string; worktreePath: string },
): Record<string, string> {
  const env = buildChildEnv(base, undefined);
  for (const key of Object.keys(env)) {
    if (deniedSetupEnv(key)) delete env[key];
  }
  return { ...env, [ENV_SETUP_ROOT_PATH]: paths.rootPath, [ENV_SETUP_WORKTREE_PATH]: paths.worktreePath };
}

const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/gu;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** Sanitize output and command text before agents see them so they cannot forge report formatting. */
export function cleanTerminalText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replace(ESCAPE_SEQUENCE, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(CONTROL_CHARS, "");
}

export function outputTail(output: Buffer, maxLines: number, maxBytes: number): string {
  let bytes = output.length > maxBytes ? output.subarray(output.length - maxBytes) : output;
  // Skip leading UTF-8 continuation bytes when the cut lands inside a character.
  if (bytes !== output) {
    let i = 0;
    while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
    bytes = bytes.subarray(i);
  }
  const lines = cleanTerminalText(bytes.toString("utf8")).replace(/\s+$/u, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

export interface RunSetupOptions {
  command: string;
  cwd: string;
  rootPath: string;
  logPath: string;
  timeoutMs?: number;
  shell?: string;
  baseEnv?: Record<string, string | undefined>;
  signal?: AbortSignal;
  logMaxBytes?: number;
  now?: () => number;
}

function openLog(logPath: string): { fd: number | null; error: string | null } {
  try {
    // Logs contain the command and its output, so they are owner-only like launch files.
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    return { fd: openSync(logPath, "a", 0o600), error: null };
  } catch (error) {
    return { fd: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function runSetupCommand(options: RunSetupOptions): Promise<SetupOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const logMaxBytes = options.logMaxBytes ?? SETUP_LOG_MAX_BYTES;
  const baseEnv = options.baseEnv ?? process.env;
  const resolvedShell = resolveSetupShell(options.command, baseEnv, options.shell);
  const started = now();
  const log = openLog(options.logPath);
  let logError = log.error;
  let logged = 0;
  let logCut = false;
  const writeLog = (text: string | Buffer) => {
    if (log.fd === null) return;
    try {
      writeSync(log.fd, typeof text === "string" ? Buffer.from(text) : text);
    } catch (error) {
      logError ??= errorMessage(error);
    }
  };
  const shellHeader = process.platform === "win32" ? `[shell: ${resolvedShell.label}]\n` : "";
  writeLog(`\n=== ${new Date(started).toISOString()} 在 ${options.cwd} 跑准备命令 ===\n${shellHeader}${options.command}\n---\n`);

  const keepBytes = SETUP_OUTPUT_TAIL_BYTES * 2;
  let kept = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk]);
    if (kept.length > keepBytes) kept = kept.subarray(kept.length - keepBytes);
    if (logCut) return;
    const room = logMaxBytes - logged;
    if (chunk.length <= room) {
      writeLog(chunk);
      logged += chunk.length;
    } else {
      writeLog(chunk.subarray(0, room));
      writeLog(`\n……（日志超过 ${logMaxBytes} 字节，后面省略）\n`);
      logged = logMaxBytes;
      logCut = true;
    }
  };

  const finish = (fields: Pick<SetupOutcome, "kind" | "exitCode" | "signal" | "error">): SetupOutcome => {
    const durationMs = now() - started;
    const how = fields.error ?? (fields.signal !== null ? `信号 ${fields.signal}` : `退出码 ${fields.exitCode}`);
    writeLog(`\n--- 结束（${fields.kind}，${how}），用时 ${Math.round(durationMs / 1000)} 秒 ---\n`);
    if (log.fd !== null) {
      try {
        closeSync(log.fd);
      } catch {
      }
      log.fd = null;
    }
    return {
      ...fields,
      command: options.command,
      timeoutMs,
      durationMs,
      tail: outputTail(kept, SETUP_OUTPUT_TAIL_LINES, SETUP_OUTPUT_TAIL_BYTES),
      logPath: options.logPath,
      logError,
    };
  };

  if (options.signal?.aborted) return finish({ kind: "stopped", exitCode: null, signal: null, error: null });
  // Check the directory first; otherwise spawn only reports an unclear "spawn /bin/zsh ENOENT".
  if (!isDirectory(options.cwd)) return finish({ kind: "failed", exitCode: null, signal: null, error: `worktree 目录不在：${options.cwd}` });
  try {
    return await runChild();
  } catch (error) {
    return finish({ kind: "failed", exitCode: null, signal: null, error: `准备命令出错：${errorMessage(error)}` });
  }

  async function runChild(): Promise<SetupOutcome> {
    const spawned = spawnOwnedProcess(resolvedShell.program, resolvedShell.args, {
      cwd: options.cwd,
      env: buildSetupEnv(baseEnv, { rootPath: options.rootPath, worktreePath: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = spawned.child as ChildProcessWithoutNullStreams;
    trackChild(child, "setup:worktree-command", { detached: spawned.detached });
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let killedFor: "timeout" | "stopped" | null = null;
    let killing: Promise<void> | null = null;
    const kill = (why: "timeout" | "stopped") => {
      if (killedFor !== null || child.pid === undefined) return;
      killedFor = why;
      killing = forceKillTree(child.pid, true);
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("stopped");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, signal) => {
        termGroupAfterExit(child);
        resolve({ code, signal });
      });
    });
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);

    if ("error" in exited) {
      return finish({ kind: "failed", exitCode: null, signal: null, error: `准备命令起不来：${exited.error.message}` });
    }
    if (killing !== null) await killing;
    const drain = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, STDIO_DRAIN_MS);
    await Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]);
    clearTimeout(drain);

    if (killedFor !== null) return finish({ kind: killedFor, exitCode: null, signal: exited.signal, error: null });
    const ok = exited.code === 0;
    return finish({ kind: ok ? "ok" : "failed", exitCode: exited.code, signal: exited.signal, error: null });
  }
}

export interface SetupJob {
  workerId: WorkerId;
  sessionId: SessionId;
  command: string;
  cwd: string;
  rootPath: string;
  logPath: string;
  onDone: (outcome: SetupOutcome) => void;
}

export interface SetupRunner {
  start(job: SetupJob): boolean;
  cancel(sessionId: SessionId): void;
  /** Shutdown kills setups without calling onDone so they rerun after restart. */
  shutdown(): Promise<void>;
}

export interface SetupRunnerOptions {
  timeoutMs?: number;
  shell?: string;
  baseEnv?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export function createSetupRunner(options: SetupRunnerOptions = {}): SetupRunner {
  const log = options.log ?? ((line) => console.error(line));
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const running = new Map<WorkerId, { sessionId: SessionId; controller: AbortController; done: Promise<void> }>();
  let closed = false;

  const deliver = (job: SetupJob, outcome: SetupOutcome): { error: unknown } | undefined => {
    try {
      job.onDone(outcome);
      return undefined;
    } catch (error) {
      log(`${LOG_PREFIX} 准备命令跑完了，交给账本时出错（Worker #${job.workerId}）：${errorMessage(error)}`);
      return { error };
    }
  };
  const errorOutcome = (job: SetupJob, error: unknown): SetupOutcome => ({
    kind: "failed",
    command: job.command,
    exitCode: null,
    signal: null,
    error: `准备命令出错：${errorMessage(error)}`,
    timeoutMs,
    durationMs: 0,
    tail: "",
    logPath: job.logPath,
    logError: null,
  });

  return {
    start(job) {
      if (closed || running.has(job.workerId)) return false;
      const controller = new AbortController();
      const done = runSetupCommand({
        command: job.command,
        cwd: job.cwd,
        rootPath: job.rootPath,
        logPath: job.logPath,
        signal: controller.signal,
        timeoutMs,
        ...(options.shell !== undefined ? { shell: options.shell } : {}),
        ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
      })
        .then((outcome) => {
          running.delete(job.workerId);
          if (closed) return;
          // If the first delivery fails (for example a database error), retry once as a setup error.
          const failed = deliver(job, outcome);
          if (failed !== undefined) deliver(job, errorOutcome(job, failed.error));
        })
        .catch((error: unknown) => {
          running.delete(job.workerId);
          log(`${LOG_PREFIX} 准备命令出错（Worker #${job.workerId}）：${errorMessage(error)}`);
          if (!closed) deliver(job, errorOutcome(job, error));
        });
      running.set(job.workerId, { sessionId: job.sessionId, controller, done });
      return true;
    },
    cancel(sessionId) {
      for (const entry of running.values()) if (entry.sessionId === sessionId) entry.controller.abort();
    },
    async shutdown() {
      closed = true;
      const entries = [...running.values()];
      for (const entry of entries) entry.controller.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(entries.map((e) => e.done)),
        new Promise((resolve) => (timer = setTimeout(resolve, KILL_WAIT_MS))),
      ]);
      clearTimeout(timer);
    },
  };
}
