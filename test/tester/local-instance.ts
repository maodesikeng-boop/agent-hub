// The local test computer: a daemon started from the code under test with its own data directory, HOME, ports, and
// vendor CLIs. Every vendor CLI is pinned through its env var to a path inside the bench, so the daemon never picks up a
// CLI or a login from the developer's own tool directories, including the directory of the node binary running the tester.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, closeSync, readSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { API_PATHS, ENV_HOME, ENV_MESH_PORT, ENV_PORT, VENDOR_LIST, type AgentVendor } from "../../src/shared/index.ts";
import { DESKTOP_PRODUCT } from "../../src/daemon/ui-server/types.ts";
import { VENDOR_FALLBACK_PATHS, resolveHubPaths } from "../../src/shared/paths.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV } from "../../src/vendors/agy/paths.ts";
import { wrapScriptAsPlatformCli } from "../fake-cli-shim.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { isInsideBench } from "./bench-paths.ts";
import type { BenchConfig, LocalBenchInstance, LocalInstanceConfig } from "./bench.ts";
import { benchFakeScript } from "./fake-script.ts";
import { createApiClient, createInstanceClient, loginCookie, type ApiClient } from "./instance-client.ts";
import { TESTER_DAEMON_START_MS, TESTER_DAEMON_STOP_MS, TESTER_RESIDENT_PROBE_MS } from "./limits.ts";

const LOGIN_URL = /http:\/\/127\.0\.0\.1:(\d+)\/auth\?token=([A-Za-z0-9_-]+)/;
const SECRET_PREFIX = "@secrets/";
const POSIX_SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface BenchLayout {
  secretsDir: string;
  runsDir: string;
  localDir: string;
  daemonLog: string;
  nodeBinDir: string;
  fakeDir: string;
}

export function benchLayout(root: string): BenchLayout {
  const localDir = join(root, "local");
  return {
    secretsDir: join(root, "secrets"),
    runsDir: join(root, "runs"),
    localDir,
    daemonLog: join(localDir, "daemon.log"),
    nodeBinDir: join(localDir, "node-bin"),
    fakeDir: join(localDir, "fake"),
  };
}

/** Directories a bench-installed CLI may live in: the bench HOME's own bins and the daemon's managed npm prefix. */
export function benchBinDirs(instance: Pick<LocalInstanceConfig, "userHome" | "dataDir">, platform: NodeJS.Platform): string[] {
  const tools = resolveHubPaths({ [ENV_HOME]: instance.dataDir }, instance.userHome, { platform });
  return [join(instance.userHome, ".local", "bin"), join(instance.userHome, "bin"), tools.toolsNpmBinDir, join(instance.userHome, ".npm-global", "bin")];
}

function isUnder(path: string, roots: readonly string[]): boolean {
  const full = resolve(path);
  return roots.some((root) => full === resolve(root) || full.startsWith(`${resolve(root)}/`) || full.startsWith(`${resolve(root)}\\`));
}

/** Postcondition: the vendor's CLI inside the bench HOME or data directory, or null. Never a path outside them. */
export function benchCliPath(vendor: AgentVendor, instance: Pick<LocalInstanceConfig, "userHome" | "dataDir">, platform: NodeJS.Platform): string | null {
  const command = VENDOR_LIST.find((v) => v.id === vendor)!.cli.command;
  const roots = [instance.userHome, instance.dataDir];
  const tools = resolveHubPaths({ [ENV_HOME]: instance.dataDir }, instance.userHome, { platform });
  const names = platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  const candidates = [
    ...benchBinDirs(instance, platform).flatMap((dir) => names.map((n) => join(dir, n))),
    ...VENDOR_FALLBACK_PATHS[vendor](instance.userHome, platform, tools.toolsNpmBinDir),
  ];
  return candidates.find((p) => isUnder(p, roots) && existsSync(p) && roots.some((root) => isInsideBench(p, root)) && statSync(p).isFile()) ?? null;
}

/**
 * A directory holding only node, npm, and npx, so installers and shebangs find node without the developer's global CLIs.
 * npm and npx are plain wrappers around this node's own npm, because version-manager wrappers resolve node relative to
 * their own directory and may rewrite the developer's shims after a global install.
 */
export function ensureNodeBin(layout: BenchLayout, platform: NodeJS.Platform): string {
  if (platform === "win32") return dirname(process.execPath);
  mkdirSync(layout.nodeBinDir, { recursive: true });
  const node = join(layout.nodeBinDir, "node");
  if (!existsSync(node)) symlinkSync(process.execPath, node);
  const npmBin = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin");
  for (const [tool, script] of [["npm", "npm-cli.js"], ["npx", "npx-cli.js"]] as const) {
    if (!existsSync(join(npmBin, script))) continue;
    writeFileSync(join(layout.nodeBinDir, tool), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(npmBin, script))} "$@"\n`, { mode: 0o755 });
  }
  return layout.nodeBinDir;
}

/** PATH for the bench daemon and installers: bench bins, the node-only dir, and system dirs; nothing from the developer's HOME. */
export function benchPath(instance: Pick<LocalInstanceConfig, "userHome" | "dataDir">, nodeBin: string, platform: NodeJS.Platform, basePath: string | undefined): string {
  const system = platform === "win32" ? (basePath ?? "").split(delimiter).filter((d) => /\\windows\\/i.test(`${d}\\`)) : POSIX_SYSTEM_DIRS;
  return [...benchBinDirs(instance, platform), nodeBin, ...system].join(platform === "win32" ? ";" : ":");
}

/** Postcondition: `value`, or the trimmed content of <root>/secrets/<name> for a `@secrets/<name>` value. */
export function resolveEnvValue(root: string, value: string): string {
  if (!value.startsWith(SECRET_PREFIX)) return value;
  const name = value.slice(SECRET_PREFIX.length);
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new Error(`bench env secret name is not a plain file name: ${name}`);
  const file = join(root, "secrets", name);
  if (!isInsideBench(file, join(root, "secrets"))) throw new Error(`bench env secret ${name} is outside the bench root`);
  return readFileSync(file, "utf8").trim();
}

export const VENDOR_HOME_ENV = ["CLAUDE_CONFIG_DIR", ...VENDOR_LIST.flatMap(({ home }) => home.configHome ? [home.configHome.env] : [])];

const VENDOR_ENV_NAMES = new Set([
  ...VENDOR_HOME_ENV,
  ...VENDOR_LIST.flatMap(({ id }) => VENDOR_PATHS[id].credentialEnv?.names ?? []),
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function benchVendorEnv(config: BenchConfig, instance: LocalInstanceConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(instance.env)
    .filter(([key]) => VENDOR_ENV_NAMES.has(key))
    .map(([key, value]) => [key, resolveEnvValue(config.root, value)]));
}

export interface DaemonEnvInput {
  config: BenchConfig;
  instance: LocalInstanceConfig;
  codeDir: string;
  mode: "real" | "fake";
  platform: NodeJS.Platform;
  baseEnv: Readonly<Record<string, string | undefined>>;
}

/** Postcondition: the full env of the local test daemon; no entry is inherited from the tester's env except system basics. */
export function localDaemonEnv(input: DaemonEnvInput): Record<string, string> {
  const { config, instance, platform, baseEnv } = input;
  const layout = benchLayout(config.root);
  const nodeBin = ensureNodeBin(layout, platform);
  const passthrough = ["SystemRoot", "PATHEXT", "ComSpec", "TMPDIR", "TEMP", "TMP", "LANG"].flatMap((k) => (baseEnv[k] === undefined ? [] : [[k, baseEnv[k]!] as const]));
  const pins = Object.fromEntries(VENDOR_LIST.map(({ id, cli }) => [cli.envVar, benchCliPath(id, instance, platform) ?? join(layout.localDir, "not-installed", cli.command)]));
  const fake: Record<string, string> = {};
  if (input.mode === "fake") {
    mkdirSync(layout.fakeDir, { recursive: true });
    const scriptFile = join(layout.fakeDir, "script.json");
    writeFileSync(scriptFile, `${JSON.stringify(benchFakeScript(), null, 2)}\n`);
    const claude = VENDOR_LIST.find((v) => v.id === "claude")!;
    fake[claude.cli.envVar] = wrapScriptAsPlatformCli(join(input.codeDir, "test", "fake-claude", "fake-claude.ts"), layout.fakeDir, "fake-claude", platform);
    Object.assign(fake, { FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_LOG: join(layout.fakeDir, "fake-claude.log"), FAKE_CLAUDE_STATE: layout.fakeDir });
  }
  return {
    ...benchVendorEnv(config, instance),
    ...Object.fromEntries(passthrough),
    LANG: baseEnv.LANG ?? "en_US.UTF-8",
    PATH: benchPath(instance, nodeBin, platform, baseEnv.PATH ?? baseEnv.Path),
    HOME: instance.userHome,
    USERPROFILE: instance.userHome,
    ...(platform === "darwin" ? { [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" } : {}),
    [ENV_HOME]: instance.dataDir,
    [ENV_PORT]: String(instance.uiPort),
    [ENV_MESH_PORT]: String(instance.meshPort),
    ...pins,
    ...fake,
  };
}

export function tailFile(file: string, lines: number, maxBytes = 512 * 1024): string {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8").split("\n").slice(-lines - 1).join("\n");
  } finally {
    closeSync(fd);
  }
}

/** An ApiClient that resolves the running daemon on every call, so clients handed out survive a restart. */
function lazyApi(get: () => ApiClient, prefix: string): ApiClient {
  return {
    get origin() {
      return get().origin;
    },
    prefix,
    get cookie() {
      return get().cookie;
    },
    request: (method, path, body, signal) => get().request(method, path, body, signal),
    json: <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) => get().json<T>(method, path, body, signal),
    forDevice: (deviceId, before) => lazyApi(() => get().forDevice(deviceId, before), `/d/${encodeURIComponent(deviceId)}`),
  };
}

function waitForLogin(child: ChildProcess, exited: Promise<void>, logFile: string): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no login link within ${TESTER_DAEMON_START_MS / 1000} s; see ${logFile}`)), TESTER_DAEMON_START_MS);
    const onData = (chunk: string) => {
      appendFileSync(logFile, chunk);
      out += chunk;
      const m = LOGIN_URL.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), token: m[2]! });
      }
    };
    child.stdout!.setEncoding("utf8").on("data", onData);
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => appendFileSync(logFile, chunk));
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`daemon exited during start; see ${logFile}:\n${tailFile(logFile, 20)}`));
    });
  });
}

export interface SpawnedDaemon {
  child: ChildProcess;
  exited: Promise<void>;
  api: ApiClient;
}

/** Postcondition: a daemon from `codeDir` running with exactly `env`, logged in; its output is appended to `logFile`. */
export async function spawnDaemon(codeDir: string, env: Record<string, string>, logFile: string): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [join(codeDir, "src", "daemon", "main.ts")], { cwd: codeDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    const login = await waitForLogin(child, exited, logFile);
    const origin = `http://127.0.0.1:${login.port}`;
    return { child, exited, api: createApiClient({ origin, cookie: await loginCookie(origin, login.token) }) };
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
}

/** SIGTERM, then SIGKILL after TESTER_DAEMON_STOP_MS; resolves once the process exited. */
export async function stopDaemon(daemon: Pick<SpawnedDaemon, "child" | "exited">): Promise<void> {
  daemon.child.kill("SIGTERM");
  const timer = setTimeout(() => daemon.child.kill("SIGKILL"), TESTER_DAEMON_STOP_MS);
  await daemon.exited;
  clearTimeout(timer);
}

export async function connectResident(instance: LocalInstanceConfig): Promise<ApiClient | null> {
  const origin = `http://127.0.0.1:${instance.uiPort}`;
  const signal = AbortSignal.timeout(TESTER_RESIDENT_PROBE_MS);
  let response: Response;
  try {
    response = await fetch(`${origin}${API_PATHS.authStatus}`, { signal, redirect: "manual" });
  } catch (error) {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED") return null;
    throw error;
  }
  const status: unknown = response.ok ? await response.json() : null;
  if (typeof status !== "object" || status === null || !("product" in status) || status.product !== DESKTOP_PRODUCT) {
    throw new Error(`port ${instance.uiPort} already has a listener that did not identify itself as Bellwood`);
  }
  const token = readFileSync(resolveHubPaths({ [ENV_HOME]: instance.dataDir }, instance.userHome).uiTokenFile, "utf8").trim();
  const api = createApiClient({ origin, cookie: await loginCookie(origin, token, signal) });
  const health = await api.json<{ ok: boolean }>("GET", API_PATHS.health, undefined, signal);
  if (health.ok !== true) throw new Error(`the Bellwood daemon on port ${instance.uiPort} is unhealthy`);
  return api;
}

export function createLocalInstance(config: BenchConfig, codeDir: string, attachedApi?: ApiClient): LocalBenchInstance {
  const platform = process.platform;
  const instance = config.instances.find((i): i is LocalInstanceConfig => i.role === "local")!;
  const layout = benchLayout(config.root);
  let running: SpawnedDaemon | null = null;
  let mode: "real" | "fake" | null = null;
  const current = (): ApiClient => {
    if (attachedApi !== undefined) return attachedApi;
    if (running === null) throw new Error(`${instance.name} is not running`);
    return running.api;
  };
  const api = lazyApi(current, "");
  const client = createInstanceClient(instance.name, api);

  const start = async (next: "real" | "fake") => {
    if (attachedApi !== undefined) throw new Error(`${instance.name} is managed by another process`);
    if (running !== null) throw new Error(`${instance.name} is already running`);
    if (!sandboxAllowsNestedSandbox()) {
      throw new Error("macOS denied sandbox-exec for the local test daemon. Run the tester from a host terminal outside any agent sandbox.");
    }
    for (const dir of [instance.dataDir, instance.userHome, layout.localDir]) mkdirSync(dir, { recursive: true });
    appendFileSync(layout.daemonLog, `\n--- start ${next} ${new Date().toISOString()} ${commit()}\n`);
    const daemon = await spawnDaemon(codeDir, localDaemonEnv({ config, instance, codeDir, mode: next, platform, baseEnv: process.env }), layout.daemonLog);
    running = { child: daemon.child, exited: daemon.exited, api: daemon.api };
    mode = next;
  };

  const stop = async () => {
    const r = running;
    if (r === null) return;
    running = null;
    mode = null;
    await stopDaemon(r);
  };

  function commit(): string {
    const head = spawnSync("git", ["-C", codeDir, "rev-parse", "HEAD"], { encoding: "utf8" });
    return head.status === 0 ? head.stdout.trim() : "unknown";
  }

  return {
    ...client,
    config: instance,
    codeDir,
    get mode() {
      return mode;
    },
    commit,
    start,
    stop,
    async restart(next) {
      await stop();
      await start(next);
    },
    async deploy(target) {
      if (commit() !== target) throw new Error(`the local test computer runs ${codeDir} at ${commit()}; check out ${target} there first`);
    },
    logs: async (lines) => tailFile(layout.daemonLog, lines),
  };
}
