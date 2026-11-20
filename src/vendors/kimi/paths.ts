// Must not import node:fs: paths-registry loads before tests mock it.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { VendorPathsModule } from "../daemon-types.ts";
import { KIMI_HOME_ENV, KIMI_HOME_REL } from "./spec.ts";

function joinByStyle(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\") ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

export function resolveKimiHome(
  userHome: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env[KIMI_HOME_ENV]?.trim() || joinByStyle(userHome, KIMI_HOME_REL);
}

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, KIMI_HOME_REL, "bin", "kimi.exe"),
      join(userHome, KIMI_HOME_REL, "bin", "kimi.cmd"),
      join(userHome, "AppData", "Roaming", "npm", "kimi.cmd"),
    ];
  }
  const userBins = [
    join(userHome, KIMI_HOME_REL, "bin", "kimi"),
    join(userHome, ".local", "bin", "kimi"),
    join(userHome, ".local", "share", "mise", "shims", "kimi"),
    join(userHome, ".npm-global", "bin", "kimi"),
  ];
  if (platform === "darwin") return [...userBins, "/opt/homebrew/bin/kimi", "/usr/local/bin/kimi"];
  return [...new Set([...linuxInstallDirs.map((dir) => join(dir, "kimi")), ...userBins])];
};

export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["KIMI_API_KEY", "KIMI_MODEL_API_KEY", "MOONSHOT_API_KEY", "KIMI_CODE_PASSWORD"],
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "irm https://code.kimi.com/kimi-code/install.ps1 | iex";

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "kimi login";
