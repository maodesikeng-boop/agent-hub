// cursor 守护进程侧路径与环境声明（不进网页包；按名单由 paths-registry.ts 加载）。
import type { VendorPathsModule } from "../daemon-types.ts";

/**
 * 官方安装脚本 `curl https://cursor.com/install -fsS | bash` 将 `cursor-agent` 安装在 `~/.local/bin/cursor-agent`；
 * Linux 额外覆盖通用安装目录（`~/.local/bin` 排第一，去重保序）。
 */
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  const localBin = join(userHome, ".local", "bin", "cursor-agent");
  if (platform === "darwin") return [localBin];
  return [...new Set([localBin, ...linuxInstallDirs.map((dir) => join(dir, "cursor-agent"))])];
};

/**
 * 仅精准剥离 Cursor 自身的鉴权凭据变量，绝不触碰 GH_TOKEN、GITHUB_TOKEN、AWS_*、OPENAI_BASE_URL 等仓库准备脚本可能依赖的通用变量。
 */
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_ACCESS_TOKEN"],
};

export const installCommand = "curl https://cursor.com/install -fsS | bash";

export const headlessLoginCommand = "NO_OPEN_BROWSER=1 cursor-agent login";
