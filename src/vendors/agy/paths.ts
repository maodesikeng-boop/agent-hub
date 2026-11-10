// agy 的数据目录和主目录下的专属路径（docs/vendor-plugin-design.md 的 A7：原来 shared/vendors.ts、shared/paths.ts 各写一份，现在只有这一份）。
// 引了 node:path，只给守护进程用；网页要的相对路径常量在 spec.ts。
import { homedir } from "node:os";
import { join } from "node:path";
import { AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL } from "./spec.ts";

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
