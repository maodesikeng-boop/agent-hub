// codex 只给守护进程和脚本用的纯数据（不进网页包，见 daemon-types.ts 的 VendorPathsModule）：PATH 里找不到时去哪找（B5，P3 从 spec.ts 挪来）、
// 凭据变量（A13）、Linux 上的安装和登录命令（D6）。
// 配置根目录（CODEX_HOME）按 spec 的 home.configHome 通用地算（shared/paths.ts 的 vendorConfigHome）。
import type { VendorPathsModule } from "../daemon-types.ts";

/** ChatGPT.app 里带的 codex（相对 Applications 目录）：装在 /Applications 或用户目录的 ~/Applications 都要找。 */
const CHATGPT_APP_CODEX = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

// macOS 先看 ChatGPT.app 里带的（/Applications、~/Applications），别的系统看官方安装目录；最后都看插件带的
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, ".local", "bin", "codex.exe"),
      join(userHome, "AppData", "Roaming", "npm", "codex.cmd"),
      join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex.exe"),
    ];
  }
  const plugin = join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex");
  if (platform === "darwin") return [join("/Applications", CHATGPT_APP_CODEX), join(userHome, "Applications", CHATGPT_APP_CODEX), plugin];
  return [...linuxInstallDirs.map((dir) => join(dir, "codex")), plugin];
};

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "codex login --device-auth";
export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "npm install -g @openai/codex";
// developers.openai.com/codex/environment-variables（2026-11 核过）：CODEX_API_KEY、CODEX_ACCESS_TOKEN；OPENAI_API_KEY 是默认 openai 提供方的 env_key
export const credentialEnv: VendorPathsModule["credentialEnv"] = { names: ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"] };
