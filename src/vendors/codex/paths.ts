import type { VendorPathsModule } from "../daemon-types.ts";

const CHATGPT_APP_CODEX = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

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
  if (platform === "win32") {
    return [
      join(npmBin, "codex.cmd"),
      join(npmBin, "codex.exe"),
      join(userHome, ".local", "bin", "codex.exe"),
      join(userHome, "AppData", "Roaming", "npm", "codex.cmd"),
      join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex.exe"),
    ];
  }
  const plugin = join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex");
  if (platform === "darwin") {
    return [
      join(userHome, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(npmBin, "codex"),
      join("/Applications", CHATGPT_APP_CODEX),
      join(userHome, "Applications", CHATGPT_APP_CODEX),
      plugin,
    ];
  }
  return [...linuxInstallDirs.map((dir) => join(dir, "codex")), join(npmBin, "codex"), plugin];
};

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "codex login --device-auth";
export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "npm install -g @openai/codex";
// OPENAI_API_KEY is the env_key of the default openai provider.
export const credentialEnv: VendorPathsModule["credentialEnv"] = { names: ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"] };
