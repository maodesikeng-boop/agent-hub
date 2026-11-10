// agy 的数据目录和主目录下的专属路径（docs/vendor-plugin-design.md 的 A7：原来 shared/vendors.ts、shared/paths.ts 各写一份，现在只有这一份）。
// 引了 node:path，只给守护进程和脚本用；网页要的相对路径常量在 spec.ts。PATH 里找不到可执行文件时去哪找（fallbackPaths）、凭据变量（A13）、
// Linux 上的安装命令（D6）也在这里（见 daemon-types.ts 的 VendorPathsModule）。
import { homedir } from "node:os";
import { join } from "node:path";
import type { VendorPathsModule } from "../daemon-types.ts";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL } from "./spec.ts";

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  const home = join(userHome, ".local", "bin", "agy");
  return platform === "darwin" ? [home] : [home, ...linuxInstallDirs.map((dir) => join(dir, "agy"))];
};

/** agy CLI 的数据根目录（~/.gemini/antigravity-cli）。 */
export function agyCliDataDir(userHome: string = homedir()): string {
  return join(userHome, AGY_CLI_HOME_REL);
}

/** agy 数据目录下的各子路径。 */
export function agyDataPaths(root: string = agyCliDataDir()) {
  return {
    root,
    conversationDb: (id: string) => join(root, "conversations", `${id}.db`),
    brainDir: (id: string) => join(root, "brain", id),
    mcpCacheDir: join(root, "mcp"),
    summaryDb: join(root, "conversation_summaries.db"),
    subDir: (sub: string) => join(root, sub),
  };
}

/** agy 在用户主目录下的专属路径。 */
export function agyHomePaths(userHome: string = homedir()) {
  return {
    cliDir: agyCliDataDir(userHome),
    legacyDir: join(userHome, AGY_LEGACY_HOME_REL),
    mcpConfigFile: join(userHome, AGY_MCP_CONFIG_REL),
  };
}

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
// agy 只从环境变量读 GEMINI_API_KEY（antigravity.google/docs/cli/install，2026-11 核过；GOOGLE_API_KEY、.env 它不读）
export const credentialEnv: VendorPathsModule["credentialEnv"] = { names: ["GEMINI_API_KEY"] };
