// Must not import node:fs: paths-registry loads before tests mock it.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { VendorPathsModule } from "../daemon-types.ts";
import { DEEPSEEK_HOME_REL } from "./spec.ts";

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join: joinPath }) => {
  if (platform === "win32") {
    return [
      joinPath(userHome, "AppData", "Roaming", "npm", "dsh.cmd"),
      joinPath(userHome, "AppData", "Local", "Programs", "DeepSeek", "resources", "runtime", "cli", "bin", "dsh.cmd"),
      joinPath(userHome, ".local", "bin", "dsh.exe"),
      joinPath(userHome, ".local", "bin", "dsh.cmd"),
    ];
  }
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

export function resolveDeepSeekHome(
  userHome: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.DSH_HOME?.trim();
  return configured ? configured : joinByStyle(userHome, DEEPSEEK_HOME_REL);
}

export const installCommand: VendorPathsModule["installCommand"] = "npm install -g @deepseek-ai/dsh@0.2.2-rc.1";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] =
  "npm install -g @deepseek-ai/dsh@0.2.2-rc.1";

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] =
  "向 ~/.dsh/.env 写入 DEEPSEEK_API_KEY=<key>，或在终端运行 dsh 完成登录";

export const parentSessionEnv: VendorPathsModule["parentSessionEnv"] = [
  "DSH_SHELL",
  "DSH_SESSION_ID",
  "DSH_PROFILE",
  "DSH_PROFILE_DIR",
];

export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["DEEPSEEK_API_KEY"],
};
