// The MXC SDK is loaded lazily so non-Windows hosts never touch it; unsupported hosts fall back to restricted tokens instead of refusing.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AvailableBackend,
  ContainerRequest,
  FilesystemPolicy,
  IsolationTier,
  NetworkPolicy,
  ProbeOutput,
  UiPolicy,
} from "@microsoft/mxc-sdk/v1";
import {
  WIN_MXC_INLINE_CONFIG_MAX_CHARS,
  WIN_MXC_NEGATIVE_CACHE_TTL_MS,
  WIN_MXC_POSITIVE_CACHE_TTL_MS,
  WIN_MXC_REQUEST_FILE_MAX_BYTES,
} from "../../../shared/limits.ts";
import { isPathInsideOrEqual, isWindowsAbsolutePathLike, normalizePathForComparison } from "./path-key.ts";
import { resolveSpawn } from "./spawn-resolution.ts";
import { quoteWindowsArgument } from "./windows-command-line.ts";
import { loadManagedWorktreeRoots } from "./worktree-roots.ts";

export interface MxcV1ProbeSurface {
  probe(request?: ContainerRequest): ProbeOutput;
  getAvailableBackends(): AvailableBackend[];
  policy?: {
    filesystem?: {
      getAvailableToolsPolicy(
        env?: Record<string, string | undefined>,
        opts?: { containerType?: "processcontainer" },
      ): { readonlyPaths: string[]; readwritePaths: string[] };
      getUserProfilePolicy(
        env?: Record<string, string | undefined>,
      ): { readonlyPaths: string[]; readwritePaths: string[] };
    };
  };
}

export type Win32MxcUnavailableReason =
  | "ok"
  | "non_win32"
  | "node_version_too_old"
  | "sdk_load_failed"
  | "probe_failed"
  | "dacl_tier_excluded"
  | "denied_paths_unsupported";

export interface Win32MxcSupportStatus {
  available: boolean;
  reason: Win32MxcUnavailableReason;
  detail?: string;
  tier?: IsolationTier;
  warnings: string[];
  nodeVersion: string;
  checkedAt: number;
}

export interface Win32MxcReadonlyInputLike {
  tmpDir: string;
  stateDir?: string;
  protectedRoots?: readonly string[];
  writableDirs: readonly string[];
  writableFilePaths?: readonly string[];
  secretPaths: readonly string[];
  readableFiles?: readonly string[];
}

export interface Win32MxcWrapBuildOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  driveRoots?: readonly string[];
  nodeExecPath?: string;
  runnerScriptPath?: string;
  ownSandboxOffArgs?: readonly string[];
  inlineMaxChars?: number;
}

export interface MxcRunnerConfig {
  program: string;
  args: string[];
  filesystem: FilesystemPolicy;
  network: NetworkPolicy;
  ui: UiPolicy;
}

const DEFAULT_RUNNER_SCRIPT_PATH = fileURLToPath(new URL("./mxc-runner.ts", import.meta.url));

const esmRequire = createRequire(import.meta.url);

function defaultLoadMxcSdk(): MxcV1ProbeSurface {
  return esmRequire("@microsoft/mxc-sdk/v1") as MxcV1ProbeSurface;
}

let sdkLoader: () => MxcV1ProbeSurface = defaultLoadMxcSdk;
let cachedSupport: { status: Win32MxcSupportStatus; expiresAt: number } | null = null;
let lastObservedSupportStatus: Win32MxcSupportStatus | null = null;

/** The MXC SDK needs native handle streams from Node >=24.21.0 <25 or >=26.8.0. */
export function supportsWin32MxcNodeVersion(rawVersion: string = process.versions.node): boolean {
  const clean = rawVersion.trim().replace(/^v/i, "").split("-")[0] ?? "";
  const parts = clean.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) return false;
  const major = parts[0]!;
  const minor = parts[1]!;
  if (major === 24) return minor >= 21;
  if (major === 25) return false;
  if (major === 26) return minor >= 8;
  return major >= 27;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function discoverWindowsFixedDriveRoots(exists: (p: string) => boolean = existsSync): string[] {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (exists(root)) roots.push(root);
    } catch {
      // Skip drives that are not ready, such as empty optical drives.
    }
  }
  return roots.length > 0 ? roots : ["C:\\"];
}

function deduplicateWinPaths(paths: readonly string[], real: (p: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = real(trimmed);
    const key = normalizePathForComparison(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

export function buildWin32MxcCommandLine(
  program: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): { command: string; extraEnv?: NodeJS.ProcessEnv } {
  for (const item of [program, ...args]) {
    if (item.includes("\0")) {
      throw new Error("MXC container command arguments must not contain NUL bytes");
    }
  }
  const resolved = resolveSpawn(
    {
      program,
      args,
      cwd: options?.cwd,
      env: options?.env ?? process.env,
    },
    "win32",
  );
  const command = resolved.rawCmdTail
    ? `${quoteWindowsArgument(resolved.file)} ${resolved.rawCmdTail}`
    : [resolved.file, ...resolved.args].map(quoteWindowsArgument).join(" ");
  return {
    command,
    ...(resolved.options.env ? { extraEnv: resolved.options.env } : {}),
  };
}

/** Failed probes are cached only for WIN_MXC_NEGATIVE_CACHE_TTL_MS, never permanently. */
export function probeWin32MxcSupport(options?: {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  now?: () => number;
  forceRefresh?: boolean;
  loadSdk?: () => MxcV1ProbeSurface;
}): Win32MxcSupportStatus {
  const platform = options?.platform ?? process.platform;
  const nodeVersion = options?.nodeVersion ?? process.versions.node;
  const nowFn = options?.now ?? Date.now;
  const now = nowFn();
  const customLoader = options?.loadSdk;

  if (platform !== "win32") {
    const st: Win32MxcSupportStatus = {
      available: false,
      reason: "non_win32",
      detail: `MXC ProcessContainer is Windows-only (current: ${platform})`,
      warnings: [],
      nodeVersion,
      checkedAt: now,
    };
    lastObservedSupportStatus = st;
    return st;
  }

  const useSharedCache = customLoader === undefined && options?.platform === undefined && options?.nodeVersion === undefined;
  if (useSharedCache && !options?.forceRefresh && cachedSupport !== null && now < cachedSupport.expiresAt) {
    return cachedSupport.status;
  }

  const recordAndReturn = (status: Win32MxcSupportStatus): Win32MxcSupportStatus => {
    lastObservedSupportStatus = status;
    if (useSharedCache) {
      const ttl = status.available ? WIN_MXC_POSITIVE_CACHE_TTL_MS : WIN_MXC_NEGATIVE_CACHE_TTL_MS;
      cachedSupport = { status, expiresAt: now + ttl };
    }
    return status;
  };

  if (!supportsWin32MxcNodeVersion(nodeVersion)) {
    return recordAndReturn({
      available: false,
      reason: "node_version_too_old",
      detail: `@microsoft/mxc-sdk native stdio on Windows requires Node >= 24.21.0 (current: ${nodeVersion})`,
      warnings: [],
      nodeVersion,
      checkedAt: now,
    });
  }

  let sdk: MxcV1ProbeSurface;
  try {
    sdk = (customLoader ?? sdkLoader)();
  } catch (err) {
    return recordAndReturn({
      available: false,
      reason: "sdk_load_failed",
      detail: err instanceof Error ? err.message : String(err),
      warnings: [],
      nodeVersion,
      checkedAt: now,
    });
  }

  const sysDrive = (process.env.SystemDrive?.trim() || "C:").replace(/[\\/]+$/, "") + "\\";
  const hostTmp = tmpdir();
  const sampleDenied = win32.join(hostTmp, ".fusa-mxc-probe-denied-sentinel");
  const sampleRequest: ContainerRequest = {
    command: "cmd.exe /d /c exit 0",
    containment: { type: "processcontainer" },
    filesystem: {
      readonlyPaths: [sysDrive],
      readwritePaths: [hostTmp],
      deniedPaths: [sampleDenied],
      clearPolicyOnExit: true,
    },
    network: {
      egress: { default: "allow" },
      ingress: { default: "deny", hostLoopback: "allow" },
    },
    ui: {
      disable: true,
      clipboard: "none",
      allowInputInjection: false,
    },
  };

  let probeOut: ProbeOutput;
  try {
    probeOut = sdk.probe(sampleRequest);
  } catch (err) {
    return recordAndReturn({
      available: false,
      reason: "probe_failed",
      detail: err instanceof Error ? err.message : String(err),
      warnings: [],
      nodeVersion,
      checkedAt: now,
    });
  }

  const warnings = Array.isArray(probeOut.warnings) ? [...probeOut.warnings] : [];
  if (probeOut.error !== undefined || probeOut.tier === undefined) {
    return recordAndReturn({
      available: false,
      reason: "probe_failed",
      detail: probeOut.error ?? "ProcessContainer tier unavailable on this Windows build",
      warnings,
      nodeVersion,
      checkedAt: now,
    });
  }

  if (probeOut.needsDaclAugmentation === true || probeOut.tier === "appcontainer-dacl") {
    return recordAndReturn({
      available: false,
      reason: "dacl_tier_excluded",
      tier: probeOut.tier,
      detail: `ProcessContainer selected ${probeOut.tier} (requires host DACL mutation); falling back to restricted-token sandbox`,
      warnings,
      nodeVersion,
      checkedAt: now,
    });
  }

  let supportsDeniedPaths = probeOut.probes?.baseContainerSupportsDenyPaths === true;
  if (!supportsDeniedPaths) {
    try {
      const backends = sdk.getAvailableBackends();
      const pc = backends.find((b) => b.backend === "processcontainer");
      supportsDeniedPaths = pc?.capabilities.includes("filesystemDeniedPaths") === true;
    } catch {
      supportsDeniedPaths = false;
    }
  }

  if (!supportsDeniedPaths) {
    return recordAndReturn({
      available: false,
      reason: "denied_paths_unsupported",
      tier: probeOut.tier,
      detail: `ProcessContainer tier ${probeOut.tier} does not support filesystemDeniedPaths`,
      warnings,
      nodeVersion,
      checkedAt: now,
    });
  }

  return recordAndReturn({
    available: true,
    reason: "ok",
    tier: probeOut.tier,
    warnings,
    nodeVersion,
    checkedAt: now,
  });
}

export function getLastWin32MxcSupportStatus(): Win32MxcSupportStatus | null {
  return lastObservedSupportStatus;
}

export function resetWin32MxcCacheForTest(customLoader?: (() => MxcV1ProbeSurface) | null): void {
  cachedSupport = null;
  lastObservedSupportStatus = null;
  sdkLoader = customLoader ?? defaultLoadMxcSdk;
}

export function buildWin32MxcFilesystemPolicy(
  input: Win32MxcReadonlyInputLike,
  options?: Win32MxcWrapBuildOptions,
): FilesystemPolicy {
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;
  const real = options?.realpath ?? realpathOrSelf;

  const inferredStateDir = input.stateDir;
  const inferredDataDir = inferredStateDir
    ? (isWindowsAbsolutePathLike(inferredStateDir) ? win32.dirname(inferredStateDir) : dirname(inferredStateDir))
    : undefined;
  const managedRoots =
    inferredStateDir && inferredDataDir && process.platform === "win32" && !options?.exists
      ? loadManagedWorktreeRoots(inferredStateDir, win32.join(inferredDataDir, "worktrees"))
      : [];

  const protectedRoots = deduplicateWinPaths(
    [
      ...(inferredDataDir ? [inferredDataDir] : []),
      ...(input.protectedRoots ?? []),
      ...managedRoots,
    ],
    real,
  );

  const readableExceptionKeys = new Set(
    (input.readableFiles ?? []).map((f) => normalizePathForComparison(real(f))),
  );
  const deniedPaths: string[] = [];
  const seenDenied = new Set<string>();
  for (const rawSecret of input.secretPaths) {
    const resolved = real(rawSecret);
    const key = normalizePathForComparison(resolved);
    if (readableExceptionKeys.has(key) || seenDenied.has(key) || !exists(resolved)) continue;
    seenDenied.add(key);
    deniedPaths.push(resolved);
  }

  const driveRoots = options?.driveRoots
    ? [...options.driveRoots]
    : discoverWindowsFixedDriveRoots(exists);

  let sdkDiscoveredReadonly: string[] = [];
  if (process.platform === "win32" && !options?.driveRoots && !options?.exists) {
    try {
      const fsHelper = sdkLoader().policy?.filesystem;
      if (fsHelper) {
        sdkDiscoveredReadonly = [
          ...fsHelper.getAvailableToolsPolicy(env, { containerType: "processcontainer" }).readonlyPaths,
          ...fsHelper.getUserProfilePolicy(env).readonlyPaths,
        ];
      }
    } catch {
    }
  }

  const readonlyPaths = deduplicateWinPaths(
    [
      ...driveRoots,
      ...protectedRoots.filter((p) => exists(p)),
      ...(input.readableFiles ?? []).filter((p) => exists(real(p))),
      ...sdkDiscoveredReadonly,
    ],
    real,
  );

  const writableCandidates = deduplicateWinPaths(
    [
      input.tmpDir,
      ...input.writableDirs.filter((d) => exists(real(d))),
      ...(input.writableFilePaths ?? []).filter((f) => exists(real(f))),
    ],
    real,
  );

  // Paths under a protected root or denied path, and parents of protected roots, must never become read-write.
  const readwritePaths = writableCandidates.filter((candidate) => {
    if (protectedRoots.some((root) => isPathInsideOrEqual(root, candidate) || isPathInsideOrEqual(candidate, root))) {
      return false;
    }
    if (deniedPaths.some((secret) => isPathInsideOrEqual(secret, candidate))) return false;
    return true;
  });

  return {
    readonlyPaths,
    readwritePaths,
    deniedPaths,
    clearPolicyOnExit: true,
  };
}

export function buildWin32MxcRunnerConfig(
  base: { command: string; args: readonly string[] },
  input: Win32MxcReadonlyInputLike,
  options?: Win32MxcWrapBuildOptions,
): MxcRunnerConfig {
  const ownOff = options?.ownSandboxOffArgs ?? [];
  return {
    program: base.command,
    args: [...ownOff, ...base.args],
    filesystem: buildWin32MxcFilesystemPolicy(input, options),
    network: {
      egress: { default: "allow" },
      ingress: { default: "deny", hostLoopback: "allow" },
    },
    ui: {
      disable: true,
      clipboard: "none",
      allowInputInjection: false,
    },
  };
}

export function wrapReadonlyWithWin32Mxc(
  base: { command: string; args: readonly string[] },
  input: Win32MxcReadonlyInputLike,
  options?: Win32MxcWrapBuildOptions,
): { command: string; args: string[] } {
  const config = buildWin32MxcRunnerConfig(base, input, options);
  const json = JSON.stringify(config);
  const byteLen = Buffer.byteLength(json, "utf8");
  if (byteLen > WIN_MXC_REQUEST_FILE_MAX_BYTES) {
    throw new Error(`MXC readonly request config exceeds ${WIN_MXC_REQUEST_FILE_MAX_BYTES} bytes (${byteLen})`);
  }
  const nodeExec = options?.nodeExecPath ?? process.execPath;
  const runnerScript = options?.runnerScriptPath ?? DEFAULT_RUNNER_SCRIPT_PATH;
  const inlineMax = options?.inlineMaxChars ?? WIN_MXC_INLINE_CONFIG_MAX_CHARS;
  const b64 = Buffer.from(json, "utf8").toString("base64");

  if (b64.length <= inlineMax) {
    return {
      command: nodeExec,
      args: [runnerScript, "--config-base64", b64],
    };
  }

  mkdirSync(input.tmpDir, { recursive: true });
  const configFile = join(input.tmpDir, `fusa-mxc-request-${randomUUID()}.json`);
  writeFileSync(configFile, json, { encoding: "utf8", mode: 0o600 });
  return {
    command: nodeExec,
    args: [runnerScript, "--config-file", configFile],
  };
}
