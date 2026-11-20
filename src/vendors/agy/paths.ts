import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { VendorPathsModule } from "../daemon-types.ts";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL } from "./spec.ts";

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
