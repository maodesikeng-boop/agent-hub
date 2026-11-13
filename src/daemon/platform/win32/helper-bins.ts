import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_WIN_HELPERS } from "../../../shared/limits.ts";

export type WinHelperName = "fusa-run.exe" | "hub.exe";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export function candidateWinHelperPaths(
  name: WinHelperName,
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
): string[] {
  const out: string[] = [];
  const customDir = env[ENV_WIN_HELPERS]?.trim();
  if (customDir) {
    out.push(join(customDir, name));
  }
  const execDir = dirname(execPath);
  out.push(join(execDir, name));
  out.push(join(execDir, "..", "bin", name));
  out.push(join(REPO_ROOT, "apps", "windows", "target", "release", name));
  out.push(join(REPO_ROOT, "apps", "windows", "target", "debug", name));
  return out;
}

export function findWinHelperBinary(
  name: WinHelperName,
  options?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
    exists?: (p: string) => boolean;
  },
): string | null {
  const exists = options?.exists ?? existsSync;
  for (const candidate of candidateWinHelperPaths(name, options?.env, options?.execPath)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function requireWinHelperBinary(
  name: WinHelperName,
  options?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
    exists?: (p: string) => boolean;
  },
): string {
  const found = findWinHelperBinary(name, options);
  if (found !== null) return found;
  throw new Error(
    `未找到 Windows 辅助程序 ${name}。请先运行：cargo build --release --manifest-path apps/windows/Cargo.toml -p fusa-win-helper（或设置环境变量 ${ENV_WIN_HELPERS}）`,
  );
}
