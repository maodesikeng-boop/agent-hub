// Outer OS sandbox parameters for read-only Antigravity Workers.
import { realpathSync } from "node:fs";
import type { ReadonlyPolicy } from "../../shared/index.ts";
import { agyHomePaths } from "./paths.ts";
import type { ReadonlySandboxInput } from "../../daemon/driver/write-scope.ts";

export const AGY_RUNTIME_DIRS: readonly string[] = [
  "conversations",
  "brain",
  "cache",
  "log",
  "presence",
  "updater",
  "crashes",
  "annotations",
  "implicit",
];
// run_command rewrites bin/agentapi* on every call; mcp/* caches tool definitions two levels deep.
export const AGY_RUNTIME_FILES: readonly string[] = [
  "cli.log",
  "conversation_summaries.db*",
  "jetbox_summaries_proto.pb",
  "last_check.timestamp",
  "bin/agentapi*",
  "mcp/*",
  "mcp/*/*",
];
export const AGY_RUNTIME_FILES_LEGACY: readonly string[] = [
  "conversation_summaries.db*",
  "agyhub_summaries_proto.pb",
];
export const READONLY_CACHE_DIRS: readonly string[] = [".cache", "Library/Caches", ".npm"];

// agy keeps its Google login in the macOS keychain; denying read fails every turn with 'Authentication required'.
export const AGY_READABLE_SECRET_HOME_PATHS: readonly string[] = ["Library/Keychains"];

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

// agy matches rules against real paths (/tmp -> /private/tmp).
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

function fileRegex(path: string): string {
  return `^${path.split("*").map(escapeRegex).join("[^/]*")}$`;
}

export function agyReadonlySandboxInput(input: {
  homeDir: string;
  tmpDir: string;
  policy: ReadonlyPolicy;
  realpath?: (p: string) => string;
}): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  const { cliDir: cli, legacyDir: legacy } = agyHomePaths(home);
  const cmpKey = (p: string) => trimSlash(p).replace(/\\/g, "/").toLowerCase();
  const needed = new Set(AGY_READABLE_SECRET_HOME_PATHS.map((d) => cmpKey(`${home}/${d}`)));
  const writableFileGlobs = [
    ...AGY_RUNTIME_FILES.map((f) => `${cli}/${f}`),
    ...AGY_RUNTIME_FILES_LEGACY.map((f) => `${legacy}/${f}`),
  ];
  return {
    tmpDir: real(input.tmpDir),
    ...(input.policy.stateDir ? { stateDir: input.policy.stateDir } : {}),
    ...(input.policy.protectedRoots ? { protectedRoots: input.policy.protectedRoots } : {}),
    writableDirs: [
      ...AGY_RUNTIME_DIRS.map((d) => `${cli}/${d}`),
      ...READONLY_CACHE_DIRS.map((d) => `${home}/${d}`),
    ],
    writableFileGlobs,
    writableFileRegexes: writableFileGlobs.map(fileRegex),
    secretPaths: input.policy.secretPaths.map(real).filter((p) => !needed.has(cmpKey(p))),
    secretGlobs: [...input.policy.secretGlobs],
    ...(input.policy.dataDirScope ? { dataDirScope: input.policy.dataDirScope } : {}),
  };
}
