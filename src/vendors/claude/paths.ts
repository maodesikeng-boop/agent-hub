import type { VendorPathsModule } from "../daemon-types.ts";

// macOS GUI apps lack ~/.local/bin and Homebrew in PATH.
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({
  userHome,
  platform,
  linuxInstallDirs,
  toolsNpmBinDir,
  join,
}) => {
  const npmBin =
    toolsNpmBinDir ??
    (platform === "win32"
      ? join(userHome, ".agent-hub", "tools", "npm")
      : join(userHome, ".agent-hub", "tools", "npm", "bin"));
  if (platform === "darwin") {
    return [
      join(userHome, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(npmBin, "claude"),
    ];
  }
  if (platform === "win32") {
    return [
      join(userHome, ".local", "bin", "claude.exe"),
      join(npmBin, "claude.cmd"),
      join(npmBin, "claude.exe"),
      join(userHome, "AppData", "Roaming", "npm", "claude.cmd"),
      join(userHome, "AppData", "Local", "Programs", "claude", "claude.exe"),
    ];
  }
  return [...linuxInstallDirs.map((dir) => join(dir, "claude")), join(npmBin, "claude")];
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://claude.ai/install.sh | bash";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "irm https://claude.ai/install.ps1 | iex";
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
// Checked against https://code.claude.com/docs/en/env-vars (2026-11).
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  prefixes: ["ANTHROPIC_", "CLAUDE_CODE_OAUTH_", "AWS_BEARER_TOKEN_"],
  names: ["CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "MCP_CLIENT_SECRET"],
  pattern: /^CLAUDE_CODE_.*_TOKEN$/,
};
