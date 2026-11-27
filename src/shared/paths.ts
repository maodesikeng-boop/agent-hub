import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { LRUCache } from "lru-cache";
import { ENV_HOME, PM_MEMORY_INDEX_FILE, WIN_EXEC_RESOLVE_CACHE_MAX } from "./limits.ts";
import { DATA_DIR_NAME } from "./names.ts";
import { VENDOR_PATHS } from "../vendors/paths-registry.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import type { VendorSpec } from "../vendors/types.ts";
import { AGENT_VENDORS, vendorSpec, type AgentVendor } from "./vendors.ts";

export interface ResolvePathsInput {
  env?: Record<string, string | undefined>;
  userHome?: string;
  home?: string;
  platform?: string;
  vendorPaths?: Partial<Record<AgentVendor, string>>;
}

export interface HubPaths {
  home: string;
  stateDir: string;
  dbFile: string;
  lockFile: string;
  childProcessesFile: string;
  sessionTmpFile: string;
  uiTokenFile: string;
  providerSecretsFile: string;
  feishuSecretsFile: string;
  feishuInboundFile: string;
  bugHuntStateFile: string;
  deviceFile: string;
  pushVapidFile: string;
  pushSubscriptionsFile: string;
  peersFile: string;
  accountFile: string;
  meshDir: string;
  adminSock: string;
  launchDir: string;
  logsDir: string;
  setupLogsDir: string;
  pmHomeDir: string;
  personasDir: string;
  pmMemoryDir: string;
  runDir: string;
  hubSock: string;
  hubBinDir: string;
  worktreesDir: string;
  uploadsDir: string;
  sentFilesDir: string;
  syncBackupsDir: string;
  toolsNpmDir: string;
  toolsNpmBinDir: string;
  vendorPaths: Record<AgentVendor, string>;
}

function isWindowsStyleBase(base: string): boolean {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\");
}

function joinForBase(base: string, ...parts: string[]): string {
  return isWindowsStyleBase(base) ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

function splitPathList(envPath: string, platform: string): string[] {
  const useSemi = platform === "win32" || envPath.includes(";") || /^[A-Za-z]:[\\/]/.test(envPath);
  return envPath.split(useSemi ? win32.delimiter : posix.delimiter);
}

function expandHome(raw: string, userHome: string): string {
  if (raw === "~") return userHome;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return joinForBase(userHome, raw.slice(2));
  return raw;
}

export function dataDirPipeHash(home: string): string {
  const normalized = home.normalize("NFC").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

export function resolveHubPaths(
  env: Record<string, string | undefined>,
  userHome: string,
  input: ResolvePathsInput = {},
): HubPaths {
  const rawHome = input.home || env[ENV_HOME];
  const home = rawHome ? expandHome(rawHome, userHome) : joinForBase(userHome, DATA_DIR_NAME);
  const platform = input.platform ?? (isWindowsStyleBase(home) ? process.platform : "darwin");
  const stateDir = joinForBase(home, "state");
  const logsDir = joinForBase(stateDir, "logs");
  const toolsNpmDir = joinForBase(home, "tools", "npm");
  const toolsNpmBinDir = platform === "win32" ? toolsNpmDir : joinForBase(toolsNpmDir, "bin");
  const pipeHash = platform === "win32" ? dataDirPipeHash(home) : "";
  const hubPipeNonce = platform === "win32" ? randomBytes(8).toString("hex") : "";
  return {
    home,
    stateDir,
    dbFile: joinForBase(stateDir, "hub.sqlite"),
    lockFile: joinForBase(stateDir, "lock"),
    childProcessesFile: joinForBase(stateDir, "child-processes.json"),
    sessionTmpFile: joinForBase(stateDir, "session-tmp.json"),
    uiTokenFile: joinForBase(stateDir, "ui-token"),
    providerSecretsFile: joinForBase(stateDir, "provider-secrets.json"),
    feishuSecretsFile: joinForBase(stateDir, "feishu-secrets.json"),
    feishuInboundFile: joinForBase(stateDir, "feishu-inbound.json"),
    bugHuntStateFile: joinForBase(stateDir, "bug-hunt-state.json"),
    deviceFile: joinForBase(stateDir, "device.json"),
    pushVapidFile: joinForBase(stateDir, "push-vapid.json"),
    pushSubscriptionsFile: joinForBase(stateDir, "push-subscriptions.json"),
    peersFile: joinForBase(stateDir, "peers.json"),
    accountFile: joinForBase(stateDir, "account.json"),
    meshDir: joinForBase(stateDir, "mesh"),
    adminSock: platform === "win32" ? `\\\\.\\pipe\\fusa-${pipeHash}-admin` : joinForBase(home, "run", "admin.sock"),
    launchDir: joinForBase(stateDir, "launch"),
    logsDir,
    setupLogsDir: joinForBase(logsDir, "setup"),
    pmHomeDir: joinForBase(home, "pm-home"),
    personasDir: joinForBase(stateDir, "personas"),
    pmMemoryDir: joinForBase(stateDir, "pm-memory"),
    runDir: joinForBase(home, "run"),
    hubSock: platform === "win32" ? `\\\\.\\pipe\\fusa-${pipeHash}-${hubPipeNonce}-hub` : joinForBase(home, "run", "hub.sock"),
    hubBinDir: joinForBase(home, "run", "bin"),
    worktreesDir: joinForBase(home, "worktrees"),
    uploadsDir: joinForBase(home, "uploads"),
    sentFilesDir: joinForBase(home, "sent-files"),
    syncBackupsDir: joinForBase(home, "backups", "sync"),
    toolsNpmDir,
    toolsNpmBinDir,
    vendorPaths: Object.fromEntries(
      VENDOR_LIST.map(({ id, cli }) => [id, expandHome(input.vendorPaths?.[id] || env[cli.envVar] || cli.command, userHome)]),
    ) as Record<AgentVendor, string>,
  };
}

export function resolvePaths(
  inputOrEnv: ResolvePathsInput | Record<string, string | undefined> = {},
  maybeUserHome?: string,
): HubPaths {
  if (maybeUserHome !== undefined) {
    return resolveHubPaths(inputOrEnv as Record<string, string | undefined>, maybeUserHome);
  }
  const input = inputOrEnv as ResolvePathsInput;
  const env = input.env ?? (inputOrEnv as Record<string, string | undefined>);
  const userHome = input.userHome ?? env.HOME ?? env.USERPROFILE ?? homedir();
  return resolveHubPaths(env, userHome, input);
}

const DEFAULT_WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isExplicitExecutablePath(cmd: string, platform: string): boolean {
  if (cmd.includes("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(cmd) || cmd.startsWith("\\\\")) return true;
  if (platform === "win32") {
    return cmd.includes("\\") || /^[A-Za-z]:/.test(cmd);
  }
  return false;
}

function parseWinPathExts(pathExt: string | undefined): string[] {
  const raw = pathExt && pathExt.trim() !== "" ? pathExt : DEFAULT_WIN_PATHEXT;
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
}

function existsAsFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findWinCandidateInDir(dir: string, cmd: string, exts: readonly string[]): string | null {
  const joinDir = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(dir) || dir.includes("\\") ? win32.join : join;
  const lower = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lower.endsWith(ext));
  if (hasKnownExt) {
    const direct = joinDir(dir, cmd);
    if (existsAsFile(direct)) return direct;
  }
  for (const ext of exts) {
    const candidate = joinDir(dir, `${cmd}${ext}`);
    if (existsAsFile(candidate)) return candidate;
  }
  const exact = joinDir(dir, cmd);
  return existsAsFile(exact) ? exact : null;
}

export function findExecutable(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  options?: { platform?: string; pathExt?: string },
): string | null {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") {
    const exts = parseWinPathExts(options?.pathExt ?? process.env.PATHEXT);
    if (isExplicitExecutablePath(cmd, "win32")) {
      if (existsAsFile(cmd)) return cmd;
      const lower = cmd.toLowerCase();
      if (!exts.some((ext) => lower.endsWith(ext))) {
        for (const ext of exts) {
          if (existsAsFile(`${cmd}${ext}`)) return `${cmd}${ext}`;
        }
      }
      return null;
    }
    if (envPath) {
      for (const rawDir of envPath.split(win32.delimiter)) {
        const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
        if (!dir) continue;
        const hit = findWinCandidateInDir(dir, cmd, exts);
        if (hit !== null) return hit;
      }
    }
    for (const candidate of fallbackPaths) {
      if (existsAsFile(candidate)) return candidate;
    }
    return null;
  }

  if (isExplicitExecutablePath(cmd, platform)) return existsSync(cmd) ? cmd : null;
  if (envPath) {
    for (const dir of splitPathList(envPath, platform)) {
      if (dir && existsSync(joinForBase(dir, cmd))) return cmd;
    }
  }
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveExecutable(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  options?: { platform?: string; pathExt?: string },
): string {
  return findExecutable(cmd, envPath, fallbackPaths, options) ?? cmd;
}

function locateExecutableFile(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  platform: string = process.platform,
  pathExt?: string,
): string | null {
  if (platform === "win32") {
    return findExecutable(cmd, envPath, fallbackPaths, { platform: "win32", pathExt });
  }
  if (isExplicitExecutablePath(cmd, platform)) return existsSync(cmd) ? cmd : null;
  if (envPath) {
    for (const dir of splitPathList(envPath, platform)) {
      if (!dir) continue;
      const full = joinForBase(dir, cmd);
      if (existsSync(full)) return full;
    }
  }
  for (const candidate of fallbackPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// systemd user services lack ~/.local/bin on PATH, so fall back to each vendor's official install dirs.
export function linuxInstallDirs(userHome: string): string[] {
  return [joinForBase(userHome, ".local", "bin"), joinForBase(userHome, ".npm-global", "bin"), "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
}

export function defaultToolsNpmBinDir(
  userHome: string,
  platform: string = process.platform,
  hubHome?: string,
): string {
  const home = hubHome ?? joinForBase(userHome, DATA_DIR_NAME);
  const joinFn =
    platform === "win32" || isWindowsStyleBase(home)
      ? win32.join
      : platform === "darwin" || platform === "linux"
        ? posix.join
        : join;
  const npmDir = joinFn(home, "tools", "npm");
  return platform === "win32" ? npmDir : joinFn(npmDir, "bin");
}

function managedNpmFallbackCandidates(
  cmd: string,
  toolsNpmBinDir: string,
  platform: string,
  joinFn: (...parts: string[]) => string,
): string[] {
  if (platform === "win32") {
    return [joinFn(toolsNpmBinDir, `${cmd}.cmd`), joinFn(toolsNpmBinDir, `${cmd}.exe`)];
  }
  return [joinFn(toolsNpmBinDir, cmd)];
}

export const VENDOR_FALLBACK_PATHS: Readonly<
  Record<AgentVendor, (userHome: string, platform?: string, toolsNpmBinDir?: string) => string[]>
> = Object.fromEntries(
  AGENT_VENDORS.map((vendor) => [
    vendor,
    (userHome: string, platform: string = process.platform, customToolsNpmBinDir?: string) => {
      const joinFn =
        platform === "win32" || isWindowsStyleBase(userHome)
          ? win32.join
          : platform === "darwin" || platform === "linux"
            ? posix.join
            : join;
      const toolsNpmBinDir = customToolsNpmBinDir ?? defaultToolsNpmBinDir(userHome, platform);
      const declared = VENDOR_PATHS[vendor].fallbackPaths?.({
        userHome,
        platform,
        linuxInstallDirs: linuxInstallDirs(userHome),
        toolsNpmBinDir,
        join: joinFn,
      });
      if (!declared) return [];
      const managed = managedNpmFallbackCandidates(vendorSpec(vendor).cli.command, toolsNpmBinDir, platform, joinFn);
      const seen = new Set(declared);
      const appended = [...declared];
      for (const item of managed) {
        if (!seen.has(item)) {
          seen.add(item);
          appended.push(item);
        }
      }
      return appended;
    },
  ]),
) as Record<AgentVendor, (userHome: string, platform?: string, toolsNpmBinDir?: string) => string[]>;

export interface VendorExecutable {
  cmd: string;
  path: string;
}

export function resolveVendorExecutables(
  paths: Pick<HubPaths, "vendorPaths"> & Partial<Pick<HubPaths, "toolsNpmBinDir">>,
  envPath: string | undefined,
  userHome: string,
  platform: string = process.platform,
  pathExt?: string,
): Record<AgentVendor, VendorExecutable> {
  return Object.fromEntries(
    AGENT_VENDORS.map((vendor) => {
      const cmd = paths.vendorPaths[vendor];
      const path = resolveExecutable(
        cmd,
        envPath,
        VENDOR_FALLBACK_PATHS[vendor](userHome, platform, paths.toolsNpmBinDir),
        { platform, pathExt },
      );
      return [vendor, { cmd, path }];
    }),
  ) as Record<AgentVendor, VendorExecutable>;
}

export function vendorCatalogWatchFiles(vendor: AgentVendor, userHome: string, env: Record<string, string | undefined> = process.env) {
  const home: VendorSpec["home"] = vendorSpec(vendor).home;
  const { configHome: override, catalogWatchPaths, catalogProbeStatePaths = [] } = home;
  const base = vendorConfigHome(vendor, userHome, env);
  const resolveFile = (rel: string) =>
    override && base && rel.startsWith(`${override.rel}/`) ? joinForBase(base, rel.slice(override.rel.length + 1)) : joinForBase(userHome, rel);
  return { inputs: catalogWatchPaths.map(resolveFile), probeState: catalogProbeStatePaths.map(resolveFile) };
}

export function vendorConfigHome(vendor: AgentVendor, userHome: string, env: Record<string, string | undefined> = process.env): string | null {
  const override = vendorSpec(vendor).home.configHome;
  return override === undefined ? null : env[override.env]?.trim() || joinForBase(userHome, override.rel);
}

const locatedExecutables = new LRUCache<string, string>({ max: WIN_EXEC_RESOLVE_CACHE_MAX });

export function resetLocatedExecutablesCacheForTest(): void {
  locatedExecutables.clear();
}

export function invalidateLocatedExecutables(cmd?: string): void {
  if (cmd === undefined) {
    locatedExecutables.clear();
    return;
  }
  for (const key of [...locatedExecutables.keys()]) {
    const parts = key.split("\0");
    if (parts[1] === cmd) locatedExecutables.delete(key);
  }
}

function statSignature(file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `${file}:${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`;
  } catch {
    return null;
  }
}

function envValueCaseInsensitive(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((k) => k.toLowerCase() === lower && env[k] !== undefined);
  return key === undefined ? undefined : env[key];
}

function executableSignature(
  cmd: string,
  envPath: string | undefined,
  fallbackPaths: readonly string[],
  platform: string = process.platform,
  pathExt?: string,
): string {
  const key = [platform, cmd, envPath ?? "", pathExt ?? "", ...fallbackPaths].join("\0");
  const cached = locatedExecutables.get(key);
  if (cached !== undefined) {
    const sig = statSignature(cached);
    if (sig !== null) return sig;
    locatedExecutables.delete(key);
  }
  const exe = locateExecutableFile(cmd, envPath, fallbackPaths, platform, pathExt);
  if (exe === null) return "-";
  const sig = statSignature(exe);
  if (sig === null) return `${exe}:missing`;
  locatedExecutables.set(key, exe);
  return sig;
}

export type CatalogFingerprint = { inputs: string; probeState: string };

export function vendorCatalogFingerprint(
  vendor: AgentVendor,
  cmd: string,
  env: Record<string, string | undefined>,
  userHome: string,
  platform: string = process.platform,
): CatalogFingerprint {
  const envPath = platform === "win32" ? envValueCaseInsensitive(env, "PATH") : env.PATH;
  const pathExt = platform === "win32" ? envValueCaseInsensitive(env, "PATHEXT") : undefined;
  const exe = executableSignature(cmd, envPath, VENDOR_FALLBACK_PATHS[vendor](userHome, platform), platform, pathExt);
  const { inputs, probeState } = vendorCatalogWatchFiles(vendor, userHome, env);
  const stamp = (file: string) => statSignature(file) ?? `${file}:missing`;
  return { inputs: [exe, ...inputs.map(stamp)].join("|"), probeState: probeState.map(stamp).join("|") };
}

export function personaFilePath(personasDir: string, pmId: number): string {
  return joinForBase(personasDir, `pm-${pmId}.md`);
}

export function pmMemoryDirPath(pmMemoryDir: string, pmId: number): string {
  return joinForBase(pmMemoryDir, String(pmId));
}

export function pmMemoryIndexPath(pmMemoryDir: string, pmId: number): string {
  return joinForBase(pmMemoryDirPath(pmMemoryDir, pmId), PM_MEMORY_INDEX_FILE);
}

export function projectWorktreesDir(worktreesDir: string, projectId: number): string {
  return joinForBase(worktreesDir, String(projectId));
}

export function workerWorktreePath(worktreesDir: string, projectId: number, workerId: number): string {
  return joinForBase(projectWorktreesDir(worktreesDir, projectId), String(workerId));
}

export function sessionLaunchDir(launchDir: string, sessionId: number): string {
  return joinForBase(launchDir, String(sessionId));
}

export function removeSessionLaunchDir(launchDir: string, sessionId: number): void {
  rmSync(sessionLaunchDir(launchDir, sessionId), { recursive: true, force: true });
  rmSync(joinForBase(launchDir, `session-${sessionId}`), { recursive: true, force: true });
}

export function workerSetupLogPath(setupLogsDir: string, workerId: number): string {
  return joinForBase(setupLogsDir, `worker-${workerId}.log`);
}

// macOS sun_path is 104 bytes including the trailing NUL; longer paths fail listen() with an opaque EINVAL.
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export function assertSocketPathFits(socketPath: string): void {
  const bytes = new TextEncoder().encode(socketPath).length;
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `agent 接口的 socket 路径有 ${bytes} 字节，超过 macOS 的上限 ${MAX_UNIX_SOCKET_PATH_BYTES} 字节：${socketPath}。` +
        `请把 AGENT_HUB_HOME 设到一个短一点的目录。`,
    );
  }
}
