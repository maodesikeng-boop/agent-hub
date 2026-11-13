// agy 的数据目录和主目录下的专属路径（docs/vendor-plugin-design.md 的 A7：原来 shared/vendors.ts、shared/paths.ts 各写一份，现在只有这一份）。
// 引了 node:path，只给守护进程和脚本用；网页要的相对路径常量在 spec.ts。PATH 里找不到可执行文件时去哪找（fallbackPaths）、凭据变量（A13）、
// Linux 上的安装命令（D6）也在这里（见 daemon-types.ts 的 VendorPathsModule）。
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

/** agy CLI 的数据根目录（~/.gemini/antigravity-cli）。 */
export function agyCliDataDir(userHome: string = homedir()): string {
  return joinByStyle(userHome, AGY_CLI_HOME_REL);
}

/** agy 数据目录下的各子路径。 */
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

/** agy 在用户主目录下的专属路径。 */
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
// agy 只从环境变量读 GEMINI_API_KEY（antigravity.google/docs/cli/install，2026-11 核过；GOOGLE_API_KEY、.env 它不读）
export const credentialEnv: VendorPathsModule["credentialEnv"] = { names: ["GEMINI_API_KEY"] };
