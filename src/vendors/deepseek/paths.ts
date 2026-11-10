// deepseek 只给守护进程和脚本用的纯数据（不进网页包，见 daemon-types.ts 的 VendorPathsModule）：
// 不引 node:fs（paths-registry.ts 在测试 setupFiles 阶段就会加载，不能抢在 mock node:fs 前引入 fs）。
import { homedir } from "node:os";
import { join } from "node:path";
import type { VendorPathsModule } from "../daemon-types.ts";
import { DEEPSEEK_HOME_REL } from "./spec.ts";

/**
 * PATH 里找不到 dsh 时按顺序查找的常见全局安装路径：
 * ~/.local/bin、mise shims、nvm current、~/.npm-global/bin，以及 macOS Homebrew / Linux 官方安装目录。
 */
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join: joinPath }) => {
  const userCandidates = [
    joinPath(userHome, ".local", "bin", "dsh"),
    joinPath(userHome, ".local", "share", "mise", "shims", "dsh"),
    joinPath(userHome, ".nvm", "current", "bin", "dsh"),
    joinPath(userHome, ".npm-global", "bin", "dsh"),
  ];
  const systemCandidates =
    platform === "darwin"
      ? ["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh"]
      : linuxInstallDirs.map((dir) => joinPath(dir, "dsh"));
  return [...new Set([...userCandidates, ...systemCandidates])];
};

/** 解析 DeepSeek Harness 的主目录（优先读 DSH_HOME，空白忽略，否则 ~/.dsh）。 */
export function resolveDeepSeekHome(
  userHome: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.DSH_HOME?.trim();
  return configured ? configured : join(userHome, DEEPSEEK_HOME_REL);
}

/**
 * 开发者预览版钉死实测通过的精确版本号（docs/vendors/deepseek.md 第 1 节）。
 */
export const installCommand: VendorPathsModule["installCommand"] = "npm install -g @deepseek-ai/dsh@0.2.2-rc.1";

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] =
  "向 ~/.dsh/.env 写入 DEEPSEEK_API_KEY=<key>，或在终端运行 dsh 完成登录";

/**
 * @deepseek-ai/dsh-shell-env 注入给模型 shell 子进程的父会话变量（保留 DSH_HOME 不剥离）。
 */
export const parentSessionEnv: VendorPathsModule["parentSessionEnv"] = [
  "DSH_SHELL",
  "DSH_SESSION_ID",
  "DSH_PROFILE",
  "DSH_PROFILE_DIR",
];

/** dsh 只从 DEEPSEEK_API_KEY 取密钥（apiKeyEnv 默认值）；DEEPSEEK_BASE_URL 这类非密钥配置照常传给准备命令。 */
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["DEEPSEEK_API_KEY"],
};
