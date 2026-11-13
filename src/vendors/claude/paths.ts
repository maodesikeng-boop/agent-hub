// claude 只给守护进程和脚本用的纯数据（不进网页包，见 daemon-types.ts 的 VendorPathsModule）：PATH 里找不到时去哪找（B5，P3 从 spec.ts 挪来）、
// 父会话变量（A12）、凭据变量（A13）、Linux 上的安装命令（D6）。
import type { VendorPathsModule } from "../daemon-types.ts";

// macOS 上只认 PATH（沿用原来的行为）；Windows 看官方 install.ps1（~\.local\bin\claude.exe）、npm 全局垫片（%APPDATA%\npm\claude.cmd）与本地安装目录；Linux 看官方安装目录
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "darwin") return [];
  if (platform === "win32") {
    return [
      join(userHome, ".local", "bin", "claude.exe"),
      join(userHome, "AppData", "Roaming", "npm", "claude.cmd"),
      join(userHome, "AppData", "Local", "Programs", "claude", "claude.exe"),
    ];
  }
  return linuxInstallDirs.map((dir) => join(dir, "claude"));
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://claude.ai/install.sh | bash";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "irm https://claude.ai/install.ps1 | iex";
// claude 给它起的子进程设的（照 experiments/m0/claude_clean.sh），保持迁移前名单。
export const parentSessionEnv: VendorPathsModule["parentSessionEnv"] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];
// 对照 https://code.claude.com/docs/en/env-vars（2026-11 核过）：ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_AWS_API_KEY、
// ANTHROPIC_FOUNDRY_API_KEY、ANTHROPIC_FOUNDRY_AUTH_TOKEN、AWS_BEARER_TOKEN_BEDROCK、CLAUDE_CODE_OAUTH_TOKEN、
// CLAUDE_CODE_OAUTH_REFRESH_TOKEN、CLAUDE_CODE_CLIENT_CERT / _KEY / _KEY_PASSPHRASE（mTLS）、MCP_CLIENT_SECRET；
// CLAUDE_CODE_*_TOKEN 是 Claude Code 自己的各种令牌（会话、消息通道……），以后新加的也拦住
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  prefixes: ["ANTHROPIC_", "CLAUDE_CODE_OAUTH_", "AWS_BEARER_TOKEN_"],
  names: ["CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "MCP_CLIENT_SECRET"],
  pattern: /^CLAUDE_CODE_.*_TOKEN$/,
};
