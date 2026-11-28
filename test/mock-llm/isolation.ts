// Invariant: isolated homes never overlap the user's real HOME, never inherit real vendor credentials, and blackhole non-loopback proxies.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32, type PlatformPath } from "node:path";
import { PARENT_SESSION_ENV } from "../../src/daemon/driver/protocol.ts";
import { WORKER_ENV } from "../../src/vendors/claude/settings.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { shortTmp } from "../e2e/harness.ts";
import { MOCK_LLM_PROXY_BLACKHOLE_URL } from "./limits.ts";
import type { IsolatedHomeConfig } from "./types.ts";

const CREDENTIAL_SPECS = Object.values(VENDOR_PATHS).flatMap((paths) => (paths.credentialEnv ? [paths.credentialEnv] : []));
const DENY_NAMES = new Set<string>([
  ...PARENT_SESSION_ENV.map((k) => k.toUpperCase()),
  ...Object.keys(WORKER_ENV).map((k) => k.toUpperCase()),
  ...CREDENTIAL_SPECS.flatMap((c) => (c.names ?? []).map((n) => n.toUpperCase())),
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "DSH_HOME",
  "KIMI_CODE_HOME",
  "OPENCODE_CONFIG_CONTENT",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_API_BASE_URL",
  "GEMINI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "CURSOR_API_ENDPOINT",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);
const DENY_PREFIXES: readonly string[] = [
  "HUB_",
  "AGENT_HUB_",
  "KIMI_MODEL_",
  "XDG_",
  ...CREDENTIAL_SPECS.flatMap((c) => (c.prefixes ?? []).map((p) => p.toUpperCase())),
];
const DENY_PATTERNS: readonly RegExp[] = CREDENTIAL_SPECS.flatMap((c) => (c.pattern ? [c.pattern] : []));

function resolveWithExistingAncestor(absPath: string, pathApi: PlatformPath): string {
  const trailing: string[] = [];
  let cursor = absPath;
  while (!existsSync(cursor)) {
    const parent = pathApi.dirname(cursor);
    if (parent === cursor) return absPath;
    trailing.push(pathApi.basename(cursor));
    cursor = parent;
  }
  let canonicalBase = cursor;
  try {
    canonicalBase = realpathSync(cursor);
  } catch {
    canonicalBase = cursor;
  }
  return trailing.length === 0 ? canonicalBase : pathApi.join(canonicalBase, ...trailing.reverse());
}

// Walk to the nearest existing ancestor for realpath, then NFC + case-fold because APFS and NTFS are case-insensitive by default.
function canonicalizeForOverlapCheck(pathStr: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const abs = pathApi.resolve(pathStr);
  const resolved = platform === process.platform ? resolveWithExistingAncestor(abs, pathApi) : abs;
  const normalized = resolved.normalize("NFC");
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const rel = pathApi.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

function isDeniedBaseEnv(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    DENY_NAMES.has(upper) ||
    DENY_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    DENY_PATTERNS.some((pattern) => pattern.test(upper))
  );
}

function joinForPlatform(platform: NodeJS.Platform, base: string, ...parts: string[]): string {
  return platform === "win32" ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

function setEnvValue(env: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === lower && existing !== key) delete env[existing];
    }
  }
  env[key] = value;
}

export function assertIsolatedHome(
  candidateHome: string,
  realHome = homedir(),
  platform: NodeJS.Platform = process.platform,
): void {
  if (!candidateHome || candidateHome.trim() === "") {
    throw new Error("Isolated home path must be a non-empty path");
  }
  const candidate = canonicalizeForOverlapCheck(candidateHome, platform);
  const real = canonicalizeForOverlapCheck(realHome, platform);
  if (isSameOrInside(real, candidate, platform) || isSameOrInside(candidate, real, platform)) {
    throw new Error(`Isolated home "${candidateHome}" overlaps real home "${realHome}"`);
  }
}

export function buildIsolatedEnv(input: {
  homeDir: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  vendorEnv?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
  realHome?: string;
}): Record<string, string> {
  const platform = input.platform ?? process.platform;
  assertIsolatedHome(input.homeDir, input.realHome, platform);

  const base = input.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (isDeniedBaseEnv(k)) continue;
    setEnvValue(env, k, v, platform);
  }

  const tmpDir = joinForPlatform(platform, input.homeDir, ".tmp");
  const overrides: Record<string, string> = {
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    XDG_CONFIG_HOME: joinForPlatform(platform, input.homeDir, ".config"),
    XDG_DATA_HOME: joinForPlatform(platform, input.homeDir, ".local", "share"),
    XDG_STATE_HOME: joinForPlatform(platform, input.homeDir, ".local", "state"),
    XDG_CACHE_HOME: joinForPlatform(platform, input.homeDir, ".cache"),
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    HTTP_PROXY: MOCK_LLM_PROXY_BLACKHOLE_URL,
    HTTPS_PROXY: MOCK_LLM_PROXY_BLACKHOLE_URL,
    ALL_PROXY: MOCK_LLM_PROXY_BLACKHOLE_URL,
    NO_PROXY: "127.0.0.1,localhost,::1",
    ...(platform !== "win32"
      ? {
          http_proxy: MOCK_LLM_PROXY_BLACKHOLE_URL,
          https_proxy: MOCK_LLM_PROXY_BLACKHOLE_URL,
          all_proxy: MOCK_LLM_PROXY_BLACKHOLE_URL,
          no_proxy: "127.0.0.1,localhost,::1",
        }
      : {}),
  };
  if (platform === "win32") {
    overrides.APPDATA = joinForPlatform(platform, input.homeDir, "AppData", "Roaming");
    overrides.LOCALAPPDATA = joinForPlatform(platform, input.homeDir, "AppData", "Local");
  }
  for (const [k, v] of Object.entries(overrides)) {
    setEnvValue(env, k, v, platform);
  }

  if (input.vendorEnv) {
    for (const [k, v] of Object.entries(input.vendorEnv)) {
      setEnvValue(env, k, v, platform);
    }
  }
  return env;
}

export function createIsolatedHome(options?: {
  prefix?: string;
  root?: string;
  realHome?: string;
}): IsolatedHomeConfig {
  const baseRoot = options?.root ?? shortTmp();
  assertIsolatedHome(baseRoot, options?.realHome);
  const rootDir = mkdtempSync(join(baseRoot, options?.prefix ?? "bw-m-"));
  const homeDir = join(rootDir, "h");
  const dataDir = join(rootDir, "d");
  const workDir = join(rootDir, "w");
  assertIsolatedHome(homeDir, options?.realHome);

  for (const dir of [
    homeDir,
    dataDir,
    workDir,
    join(homeDir, ".tmp"),
    join(homeDir, ".config"),
    join(homeDir, ".local", "share"),
    join(homeDir, ".local", "state"),
    join(homeDir, ".cache"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const env = buildIsolatedEnv({ homeDir, realHome: options?.realHome });
  return {
    rootDir,
    homeDir,
    dataDir,
    workDir,
    env,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
