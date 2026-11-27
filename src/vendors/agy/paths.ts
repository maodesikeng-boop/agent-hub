import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { VendorPathsModule, VendorRuntimeEnvInput } from "../daemon-types.ts";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL } from "./spec.ts";

export const AGY_FORCE_FILE_TOKEN_STORAGE_ENV = "AGY_CLI_FORCE_FILE_TOKEN_STORAGE";
export const AGY_MACOS_LOGIN_KEYCHAIN_REL = "Library/Keychains/login.keychain-db";

/**
 * Computes extra environment variables for running agy safely under an isolated macOS HOME.
 * Postcondition: on darwin, returns { [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" } when the env var is not
 * already explicitly set and <effectiveHome>/Library/Keychains/login.keychain-db does not exist; returns {}
 * on non-darwin platforms, when the login keychain exists, or when the caller explicitly set the variable.
 */
export function agyIsolatedHomeEnv(input: VendorRuntimeEnvInput): Readonly<Record<string, string>> {
  if (input.platform !== "darwin") return {};
  const explicit = input.env[AGY_FORCE_FILE_TOKEN_STORAGE_ENV];
  if (explicit !== undefined && explicit.trim() !== "") return {};
  const effectiveHome = input.env.HOME?.trim() || input.userHome;
  if (effectiveHome === "") return {};
  if (input.exists(joinByStyle(effectiveHome, AGY_MACOS_LOGIN_KEYCHAIN_REL))) return {};
  return { [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" };
}

export const runtimeEnv: VendorPathsModule["runtimeEnv"] = agyIsolatedHomeEnv;

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, "AppData", "Local", "agy", "bin", "agy.exe"),
      join(userHome, ".local", "bin", "agy.exe"),
      join(userHome, "AppData", "Roaming", "npm", "agy.cmd"),
    ];
  }
  const home = join(userHome, ".local", "bin", "agy");
  return platform === "darwin" ? [home] : [home, ...linuxInstallDirs.map((dir) => join(dir, "agy"))];
};

export function agyCliDataDir(userHome: string = homedir()): string {
  return joinByStyle(userHome, AGY_CLI_HOME_REL);
}

export function agyDataPaths(root: string = agyCliDataDir()) {
  return {
    root,
    conversationDb: (id: string) => joinByStyle(root, "conversations", `${id}.db`),
    brainDir: (id: string) => joinByStyle(root, "brain", id),
    mcpCacheDir: joinByStyle(root, "mcp"),
    summaryDb: joinByStyle(root, "conversation_summaries.db"),
    subDir: (sub: string) => joinByStyle(root, sub),
  };
}

export function agyHomePaths(userHome: string = homedir()) {
  return {
    cliDir: agyCliDataDir(userHome),
    legacyDir: joinByStyle(userHome, AGY_LEGACY_HOME_REL),
    mcpConfigFile: joinByStyle(userHome, AGY_MCP_CONFIG_REL),
  };
}

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] =
  "irm https://antigravity.google/cli/install.ps1 | iex";
// agy reads only GEMINI_API_KEY from the environment, not GOOGLE_API_KEY or .env.
export const credentialEnv: VendorPathsModule["credentialEnv"] = { names: ["GEMINI_API_KEY"] };
