import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, win32 } from "node:path";
import { canOpenWithDefault, type FileAction, type FileActionResponse } from "../shared/index.ts";

export type RunOpen = (args: string[]) => Promise<void>;

export function buildWindowsExplorerInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const sysRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const explorer = win32.join(sysRoot, "explorer.exe");
  const isReveal = args[0] === "-R";
  const target = args[args.length - 1] ?? "";
  return {
    file: explorer,
    args: isReveal ? [`/select,${target}`] : [target],
  };
}

export const runOpenCommand: RunOpen = (args) =>
  new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const inv = buildWindowsExplorerInvocation(args);
      execFile(inv.file, inv.args, { windowsHide: false }, (error) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          return reject(error);
        }
        resolve();
      });
      return;
    }
    execFile("open", args, (error) => (error === null ? resolve() : reject(error)));
  });

export class OpenTargetMissing extends Error {}
export class FileActionsUnavailable extends Error {}
export const FILE_ACTIONS_UNAVAILABLE_MESSAGE = "这台服务器不能在桌面上显示或打开文件，请用“下载”";
export class OpenNotAllowed extends Error {}

export const OPEN_NOT_ALLOWED_MESSAGE = "这个类型打开可能会直接运行，只能在 Finder 中显示";

function realFileOrNull(path: string): { real: string; mode: number } | null {
  try {
    const real = realpathSync.native(path);
    const stat = statSync(real);
    return stat.isFile() ? { real, mode: stat.mode } : null;
  } catch {
    return null;
  }
}

export async function performFileAction(
  action: FileAction,
  target: { original: string | null; isAllowed: (realPath: string) => boolean; copy: string | null; name: string },
  runOpen: RunOpen,
): Promise<FileActionResponse> {
  const original = target.original === null ? null : realFileOrNull(target.original);
  const useOriginal = original !== null && target.isAllowed(original.real);
  const copy = target.copy === null ? null : realFileOrNull(target.copy);
  const path = useOriginal ? original.real : copy?.real;
  if (path === undefined) throw new OpenTargetMissing();
  if (action === "open") {
    const executable = ((original?.mode ?? 0) | (copy?.mode ?? 0)) & 0o111;
    if (executable !== 0 || !canOpenWithDefault(target.name) || !canOpenWithDefault(basename(path))) throw new OpenNotAllowed();
  }
  await runOpen(action === "reveal" ? ["-R", "--", path] : ["--", path]);
  return { target: useOriginal ? "original" : "copy" };
}
