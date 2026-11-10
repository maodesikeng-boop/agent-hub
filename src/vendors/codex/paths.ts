// codex 只给守护进程用的路径（docs/vendor-plugin-design.md 的 B5：原来在 spec.ts 里，网页也打包；P3 挪到这里）。
// 配置根目录（CODEX_HOME）按 spec 的 home.configHome 通用地算（shared/paths.ts 的 vendorConfigHome）。
import type { VendorPathsModule } from "../daemon-types.ts";

/** ChatGPT.app 里带的 codex（相对 Applications 目录）：装在 /Applications 或用户目录的 ~/Applications 都要找。 */
const CHATGPT_APP_CODEX = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

// macOS 先看 ChatGPT.app 里带的（/Applications、~/Applications），别的系统看官方安装目录；最后都看插件带的
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  const plugin = join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex");
  if (platform === "darwin") return [join("/Applications", CHATGPT_APP_CODEX), join(userHome, "Applications", CHATGPT_APP_CODEX), plugin];
  return [...linuxInstallDirs.map((dir) => join(dir, "codex")), plugin];
};
