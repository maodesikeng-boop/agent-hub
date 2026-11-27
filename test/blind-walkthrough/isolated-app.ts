// Invariant: isolated Bellwood instances never share ~/.agent-hub, developer CLI configs, or default ports, and leave zero live children after stop.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_DIALOG_TOKEN_ENV, DESKTOP_DIALOG_URL_ENV } from "../../src/daemon/pick-folder.ts";
import { readLedgerFile } from "../../src/daemon/process-ledger.ts";
import { API_PATHS, DEFAULT_AGENT_VENDOR, ENV_HOME, ENV_PORT, ENV_SESSION_OWNER_TAG, VENDOR_LIST } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { agyIsolatedHomeEnv } from "../../src/vendors/agy/paths.ts";
import { wrapScriptAsPlatformCli } from "../fake-cli-shim.ts";
import { assertIsolatedWorkspace } from "./context-barrier.ts";
import { BLIND_DAEMON_START_TIMEOUT_MS, BLIND_DAEMON_STOP_TIMEOUT_MS } from "./limits.ts";
import type { AppVendorMode } from "./types.ts";

export type FolderPickerMode = "bridge_sample_project" | "disabled";

export interface IsolatedAppOptions {
  readonly tempRoot: string;
  readonly appVendorMode: AppVendorMode;
  readonly folderPickerMode?: FolderPickerMode;
  readonly repoRoot?: string;
  readonly buildWeb?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
}

export interface IsolatedBellwoodHandle {
  readonly homeDir: string;
  readonly userHomeDir: string;
  readonly sampleProjectDir: string;
  readonly origin: string;
  readonly loginUrl: string;
  readonly uiToken: string;
  readonly folderBridgeActive: boolean;
  readonly pid: number;
  isRunning(): boolean;
  readStderrTail(): string;
}

type ProcessExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

interface DaemonInternalState {
  readonly child: ChildProcess;
  readonly exited: Promise<ProcessExit>;
  readonly bridgeServer: Server | null;
  readonly cleanupPaths: readonly string[];
  readonly platform: NodeJS.Platform;
  running: boolean;
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("../fake-claude/fake-claude.ts", import.meta.url));
const LOGIN_URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;
const DAEMON_PASSTHROUGH_KEYS = ["PATH", "Path", "SystemRoot", "PATHEXT", "ComSpec", "TMPDIR", "TEMP", "TMP", ENV_SESSION_OWNER_TAG] as const;

const HANDLE_INTERNALS = new WeakMap<IsolatedBellwoodHandle, DaemonInternalState>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startFolderBridge(sampleProjectDir: string): Promise<{ readonly server: Server; readonly url: string; readonly token: string }> {
  const token = randomBytes(24).toString("hex");
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
      req.resume();
      req.once("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ path: sampleProjectDir }));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Loopback folder bridge failed to bind an ephemeral TCP port"));
        return;
      }
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}/pick-folder`, token });
    });
  });
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

function buildDaemonEnv(input: {
  readonly homeDir: string;
  readonly userHomeDir: string;
  readonly scratchDir: string;
  readonly appVendorMode: AppVendorMode;
  readonly platform: NodeJS.Platform;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly bridge: { readonly url: string; readonly token: string } | null;
}): Record<string, string> {
  const effectiveUserHome = input.appVendorMode.kind === "real" ? input.appVendorMode.isolatedHomeDir : input.userHomeDir;
  mkdirSync(effectiveUserHome, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of DAEMON_PASSTHROUGH_KEYS) {
    const value = input.baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.LANG = "en_US.UTF-8";
  env.HOME = effectiveUserHome;
  env.USERPROFILE = effectiveUserHome;
  if (input.appVendorMode.kind === "real" && input.appVendorMode.vendor === "agy") {
    Object.assign(env, agyIsolatedHomeEnv({ platform: input.platform, env, userHome: effectiveUserHome, exists: existsSync }));
  }
  env[ENV_HOME] = input.homeDir;
  env[ENV_PORT] = "0";

  if (input.bridge) {
    env[DESKTOP_DIALOG_URL_ENV] = input.bridge.url;
    env[DESKTOP_DIALOG_TOKEN_ENV] = input.bridge.token;
  }

  for (const { id, cli } of VENDOR_LIST) {
    if (input.appVendorMode.kind === "fake") {
      env[cli.envVar] =
        id === DEFAULT_AGENT_VENDOR
          ? wrapScriptAsPlatformCli(FAKE_CLAUDE, input.scratchDir, "fake-claude", input.platform)
          : join(input.scratchDir, `no-${id}`);
    } else if (id !== input.appVendorMode.vendor) {
      env[cli.envVar] = join(input.scratchDir, `no-${id}`);
    }
  }
  if (input.appVendorMode.kind === "fake") {
    env.FAKE_CLAUDE_LOG = join(input.scratchDir, "fake-claude.log");
    env.FAKE_CLAUDE_STATE = input.scratchDir;
  }
  return env;
}

function sendGracefulShutdown(child: ChildProcess, homeDir: string, uiToken: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  const adminPipe = resolveHubPaths({ [ENV_HOME]: homeDir }, homeDir, { platform: "win32" }).adminSock;
  const req = request(
    {
      socketPath: adminPipe,
      method: "POST",
      path: "/admin/shutdown",
      headers: {
        authorization: `Bearer ${uiToken}`,
        "content-type": "application/json",
        "content-length": 2,
      },
    },
    (res) => res.resume(),
  );
  req.on("error", () => child.kill());
  req.end("{}");
}

/**
 * Precondition: parentDir is inside an isolated temporary directory verified by assertIsolatedWorkspace.
 * Postcondition: creates a small realistic git repository containing a starter README and task file for a new user to import.
 */
export function createSampleUserProject(parentDir: string): string {
  assertIsolatedWorkspace(parentDir);
  const projectDir = join(parentDir, "demo-notes");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "README.md"),
    [
      "# Demo Notes",
      "",
      "A small personal notes workspace for trying out the app.",
      "",
      "## Goals",
      "- Summarize the open tasks in TASKS.md.",
      "- Draft a short weekly checklist.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(projectDir, "TASKS.md"),
    [
      "# Tasks",
      "",
      "- [ ] Review welcome checklist",
      "- [ ] Organize meeting notes",
      "- [ ] Share status update on Friday",
      "",
    ].join("\n"),
    "utf8",
  );

  const runGit = (args: readonly string[]) => {
    const result = spawnSync("git", [...args], { cwd: projectDir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${projectDir}: ${result.stderr}`);
    }
  };
  runGit(["init", "-q"]);
  runGit(["config", "user.name", "Demo User"]);
  runGit(["config", "user.email", "demo-user@example.com"]);
  runGit(["add", "README.md", "TASKS.md"]);
  runGit(["commit", "-q", "-m", "Initial starter notes"]);
  return projectDir;
}

/**
 * Precondition: options.tempRoot passes assertIsolatedWorkspace.
 * Postcondition: starts a real Bellwood daemon on ephemeral ports with isolated AGENT_HUB_HOME and HOME, returning its handle once healthy.
 */
export async function launchIsolatedBellwood(options: IsolatedAppOptions): Promise<IsolatedBellwoodHandle> {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  assertIsolatedWorkspace(options.tempRoot, { env: baseEnv, userHome: options.userHome, platform });
  if (options.appVendorMode.kind === "real") {
    assertIsolatedWorkspace(options.appVendorMode.isolatedHomeDir, { env: baseEnv, userHome: options.userHome, platform });
  }

  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const distIndex = join(repoRoot, "dist", "web", "index.html");
  if (options.buildWeb === true || (options.buildWeb === undefined && !existsSync(distIndex))) {
    const viteBin = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
    const build = spawnSync(process.execPath, [viteBin, "build", "--logLevel", "error"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`Web build failed (exit ${String(build.status)}): ${build.stderr}`);
    }
  }

  const homeDir = join(options.tempRoot, "h");
  const userHomeDir = join(options.tempRoot, "u");
  const scratchDir = join(options.tempRoot, "s");
  const sampleParent = join(options.tempRoot, "p");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(userHomeDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  const sampleProjectDir = createSampleUserProject(sampleParent);

  const folderPickerMode = options.folderPickerMode ?? "bridge_sample_project";
  const bridge = folderPickerMode === "bridge_sample_project" ? await startFolderBridge(sampleProjectDir) : null;

  const daemonMain = join(repoRoot, "src", "daemon", "main.ts");
  const daemonEnv = buildDaemonEnv({
    homeDir,
    userHomeDir,
    scratchDir,
    appVendorMode: options.appVendorMode,
    platform,
    baseEnv,
    bridge,
  });

  const child = spawn(process.execPath, [daemonMain], {
    cwd: repoRoot,
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let running = true;
  const exited = new Promise<ProcessExit>((resolvePromise) => {
    child.once("exit", (code, signal) => {
      running = false;
      resolvePromise({ code, signal });
    });
  });

  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_000);
  });

  let loginMatch: RegExpExecArray;
  try {
    loginMatch = await withTimeout(
      "Wait for isolated daemon login URL",
      new Promise<RegExpExecArray>((resolvePromise, reject) => {
        const check = () => {
          const match = LOGIN_URL_PATTERN.exec(stdout);
          if (match) resolvePromise(match);
        };
        child.stdout?.on("data", check);
        void exited.then(({ code }) => reject(new Error(`Isolated daemon exited early (code ${String(code)}): ${stderr}`)));
        check();
      }),
      BLIND_DAEMON_START_TIMEOUT_MS,
    );
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    await closeServer(bridge?.server ?? null);
    throw error;
  }

  const origin = `http://127.0.0.1:${loginMatch[1]!}`;
  const uiToken = loginMatch[2]!;
  const loginUrl = `${origin}${API_PATHS.auth}?token=${uiToken}`;

  const handle: IsolatedBellwoodHandle = {
    homeDir,
    userHomeDir,
    sampleProjectDir,
    origin,
    loginUrl,
    uiToken,
    folderBridgeActive: bridge !== null,
    pid: child.pid ?? -1,
    isRunning: () => running,
    readStderrTail: () => stderr,
  };

  HANDLE_INTERNALS.set(handle, {
    child,
    exited,
    bridgeServer: bridge?.server ?? null,
    cleanupPaths: [homeDir, userHomeDir, scratchDir, sampleParent],
    platform,
    running: true,
  });

  return handle;
}

function readRecordedChildEntries(ledgerPath: string): readonly { readonly pid: number; readonly purpose: string }[] {
  const canonical = readLedgerFile(ledgerPath);
  if (canonical.length > 0) return canonical;
  if (!existsSync(ledgerPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
    const rawList = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
        ? ((parsed as { entries: unknown[] }).entries)
        : [];
    const results: { pid: number; purpose: string }[] = [];
    for (const item of rawList) {
      if (typeof item !== "object" || item === null) continue;
      const pid = (item as { pid?: unknown }).pid;
      const purpose = (item as { purpose?: unknown }).purpose;
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
        results.push({ pid, purpose: typeof purpose === "string" ? purpose : "unknown" });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Precondition: homeDir is an isolated AGENT_HUB_HOME whose daemon was stopped.
 * Postcondition: returns cleanly when every recorded child process has exited; otherwise throws Error listing surviving PIDs.
 */
export function assertCleanTeardown(homeDir: string): void {
  const ledgerPath = resolveHubPaths({ [ENV_HOME]: homeDir }, homeDir).childProcessesFile;
  const surviving = readRecordedChildEntries(ledgerPath).filter((entry) => isProcessAlive(entry.pid));
  if (surviving.length > 0) {
    const details = surviving.map((entry) => `${entry.pid}(${entry.purpose})`).join(", ");
    throw new Error(`Surviving child process PIDs found after teardown: ${details}`);
  }
}

/**
 * Precondition: handle was returned by launchIsolatedBellwood.
 * Postcondition: sends graceful shutdown, awaits process exit within BLIND_DAEMON_STOP_TIMEOUT_MS, verifies zero live children in the process ledger, and removes temp files when cleanup is true.
 */
export async function stopIsolatedBellwood(handle: IsolatedBellwoodHandle, cleanup = true): Promise<void> {
  const internal = HANDLE_INTERNALS.get(handle);
  if (!internal) {
    throw new Error("Unknown IsolatedBellwoodHandle passed to stopIsolatedBellwood");
  }
  try {
    await closeServer(internal.bridgeServer);
    if (handle.isRunning()) {
      sendGracefulShutdown(internal.child, handle.homeDir, handle.uiToken, internal.platform);
      const exit = await withTimeout("Wait for isolated daemon shutdown", internal.exited, BLIND_DAEMON_STOP_TIMEOUT_MS).catch(async (error: unknown) => {
        internal.child.kill("SIGKILL");
        await internal.exited;
        throw error;
      });
      if (exit.code !== 0) {
        throw new Error(`Isolated daemon exited with non-zero code ${String(exit.code)} (signal ${String(exit.signal)}): ${handle.readStderrTail()}`);
      }
    } else {
      await internal.exited;
    }
    assertCleanTeardown(handle.homeDir);
  } finally {
    if (cleanup) {
      for (const pathToClean of internal.cleanupPaths) {
        rmSync(pathToClean, { recursive: true, force: true });
      }
    }
  }
}
