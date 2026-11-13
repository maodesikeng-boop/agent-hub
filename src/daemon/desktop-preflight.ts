// 供桌面外壳（如 Windows `fusa-desktop`）在启动引导期无副作用检查本机 Git 与已注册厂商 CLI 安装状态。
// 严格从统一厂商注册表（src/vendors/registry.ts + paths-registry.ts）读取，零硬编码厂商名。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR_FALLBACK_PATHS, findExecutable, resolveHubPaths } from "../shared/paths.ts";
import { VENDOR_PATHS } from "../vendors/paths-registry.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { normalizePathForComparison } from "./platform/index.ts";

export interface DesktopVendorPreflightEntry {
  id: string;
  label: string;
  command: string;
  installCommand: string;
  loginCommand: string;
  installed: boolean;
  binaryPath: string | null;
}

export interface DesktopPreflightReport {
  gitInstalled: boolean;
  gitPath: string | null;
  gitInstallCommand: string;
  vendors: DesktopVendorPreflightEntry[];
}

export const GIT_WINDOWS_INSTALL_COMMAND = "winget install --id Git.Git -e --source winget";
export const GIT_POSIX_INSTALL_COMMAND = "git --version";

function gitWindowsFallbackPaths(env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  const pushGitDirs = (base: string | undefined) => {
    const trimmed = base?.trim();
    if (!trimmed) return;
    candidates.push(win32.join(trimmed, "Git", "mingw64", "bin", "git.exe"));
    candidates.push(win32.join(trimmed, "Git", "cmd", "git.exe"));
  };
  pushGitDirs(env.ProgramFiles);
  pushGitDirs(env["ProgramFiles(x86)"]);
  if (env.LOCALAPPDATA) {
    pushGitDirs(win32.join(env.LOCALAPPDATA, "Programs"));
  }
  return candidates;
}

export function collectDesktopPreflight(input?: {
  env?: Record<string, string | undefined>;
  userHome?: string;
  platform?: string;
}): DesktopPreflightReport {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const userHome = input?.userHome ?? env.USERPROFILE ?? env.HOME ?? homedir();
  const envPath = platform === "win32" ? (env.PATH ?? env.Path) : env.PATH;
  const pathExt = env.PATHEXT ?? env.Pathext;

  const gitFallbacks = platform === "win32" ? gitWindowsFallbackPaths(env) : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  const gitPath = findExecutable("git", envPath, gitFallbacks, { platform, pathExt });

  const hubPaths = resolveHubPaths(env, userHome, { platform });
  const vendors: DesktopVendorPreflightEntry[] = VENDOR_LIST.map((spec) => {
    const pathSpec = VENDOR_PATHS[spec.id];
    const configuredCmd = hubPaths.vendorPaths[spec.id];
    const resolved = findExecutable(
      configuredCmd,
      envPath,
      VENDOR_FALLBACK_PATHS[spec.id](userHome, platform),
      { platform, pathExt },
    );
    const installCmd =
      (platform === "win32" ? pathSpec.windowsInstallCommand : undefined) ?? pathSpec.installCommand ?? "";
    return {
      id: spec.id,
      label: spec.label,
      command: spec.cli.command,
      installCommand: installCmd,
      loginCommand: spec.cli.loginCommand,
      installed: resolved !== null,
      binaryPath: resolved,
    };
  });

  return {
    gitInstalled: gitPath !== null,
    gitPath,
    gitInstallCommand: platform === "win32" ? GIT_WINDOWS_INSTALL_COMMAND : GIT_POSIX_INSTALL_COMMAND,
    vendors,
  };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

if (
  process.argv[1] &&
  normalizePathForComparison(realOrSelf(fileURLToPath(import.meta.url))) ===
    normalizePathForComparison(realOrSelf(process.argv[1]))
) {
  process.stdout.write(`${JSON.stringify(collectDesktopPreflight())}\n`);
}
