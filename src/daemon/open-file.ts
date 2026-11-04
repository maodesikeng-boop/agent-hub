// 网页的“在 Finder 中显示”“用默认程序打开”：用 macOS 的 open 命令（execFile，不经过 shell，路径放在 -- 之后）。
// 优先用原文件（原路径还在、是普通文件、还在会话允许的文件夹里——先 realpath 再判断），否则用守护进程存的副本。
// .app、.command、.sh、.pkg、.scpt、.jar 和带可执行权限的文件只许显示、不许打开（打开可能直接运行）。
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { canOpenWithDefault, type FileAction, type FileActionResponse } from "../shared/index.ts";

/** 跑 open，参数原样给它。测试里换成记录调用的假函数。 */
export type RunOpen = (args: string[]) => Promise<void>;

export const runOpenCommand: RunOpen = (args) =>
  new Promise((resolve, reject) => {
    execFile("open", args, (error) => (error === null ? resolve() : reject(error)));
  });

/** 没找到能用的文件（原文件、副本都没了）。 */
export class OpenTargetMissing extends Error {}
/** 这个文件只许显示，不许打开。 */
export class OpenNotAllowed extends Error {}

export const OPEN_NOT_ALLOWED_MESSAGE = "这种文件打开可能会直接运行，只能在 Finder 中显示";

function realFileOrNull(path: string): { real: string; mode: number } | null {
  try {
    const real = realpathSync.native(path);
    const stat = statSync(real);
    return stat.isFile() ? { real, mode: stat.mode } : null;
  } catch {
    return null;
  }
}

/**
 * 做一次显示或打开。original：原文件路径（没有是 null）；isAllowed：这个真实路径现在还能不能分享；copy：副本路径（没有是 null）。
 * 原文件有可执行权限、或名字是不许打开的类型，open 就拒绝（不管最后用的是原文件还是副本）。
 */
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
