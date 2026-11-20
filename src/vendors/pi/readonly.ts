import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ReadonlyPolicy } from "../../shared/index.ts";
import {
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  type ReadonlySandboxInput,
} from "../../daemon/driver/write-scope.ts";

export const READONLY_PI_NEEDS_SANDBOX_MESSAGE = WORKER_NEEDS_OS_SANDBOX_MESSAGE;

export const PI_READONLY_CLI_ARGS: readonly string[] = ["--exclude-tools", "edit,write", "--no-mcp"];

const PI_RUNTIME_DIRS: readonly string[] = ["sessions", "logs"];

const PI_READONLY_CACHE_DIRS: readonly string[] = [".cache", "Library/Caches", ".npm"];

const PI_SELF_READABLE_CONFIG_FILES: readonly string[] = ["auth.json", "models.json"];

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function resolvePiConfigDir(homeDir: string, env?: Readonly<Record<string, string | undefined>>): string {
  const override = env?.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && override.trim() !== "") return trimSlash(override.trim());
  return join(trimSlash(homeDir), ".pi", "agent");
}

export function piReadonlySandboxInput(input: {
  homeDir: string;
  tmpDir: string;
  policy: ReadonlyPolicy;
  env?: Readonly<Record<string, string | undefined>>;
  realpath?: (p: string) => string;
}): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  const configDir = trimSlash(real(resolvePiConfigDir(home, input.env)));
  const sessionDirOverride = input.env?.PI_CODING_AGENT_SESSION_DIR?.trim();

  const writableDirs = [
    ...PI_RUNTIME_DIRS.map((d) => `${configDir}/${d}`),
    ...(sessionDirOverride ? [trimSlash(real(sessionDirOverride))] : []),
    ...PI_READONLY_CACHE_DIRS.map((d) => `${home}/${d}`),
  ];

  const cmpKey = (p: string) => trimSlash(p).replace(/\\/g, "/").toLowerCase();
  const selfReadable = new Set(PI_SELF_READABLE_CONFIG_FILES.map((f) => cmpKey(real(`${configDir}/${f}`))));
  return {
    tmpDir: real(input.tmpDir),
    ...(input.policy.stateDir ? { stateDir: input.policy.stateDir } : {}),
    ...(input.policy.protectedRoots ? { protectedRoots: input.policy.protectedRoots } : {}),
    writableDirs: [...new Set(writableDirs)],
    writableFileGlobs: [],
    writableFileRegexes: [],
    secretPaths: input.policy.secretPaths.map(real).filter((p) => !selfReadable.has(cmpKey(p))),
    secretGlobs: [...input.policy.secretGlobs],
    ...(input.policy.dataDirScope ? { dataDirScope: input.policy.dataDirScope } : {}),
  };
}
