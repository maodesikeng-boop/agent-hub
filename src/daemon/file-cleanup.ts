// 上传的文件（uploads/<编号>/）和发出文件的副本（sent-files/<编号>/）的定期清理：目录修改时间超过 FILE_RETENTION_DAYS 天的整个删掉。
// 只动这两个目录下名字是合法编号的真目录（lstat，符号链接不跟随、不删）；删不掉的跳过，记一行日志。
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FILE_CLEANUP_INTERVAL_MS, FILE_RETENTION_DAYS, LOG_PREFIX } from "../shared/index.ts";
import { UPLOAD_ID } from "./uploads.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 清一遍 dirs 下过期的编号目录。任何出错都只记日志，不抛。 */
export function cleanupExpiredFiles(dirs: readonly string[], log: (line: string) => void): void {
  const cutoff = Date.now() - FILE_RETENTION_DAYS * DAY_MS;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`${LOG_PREFIX} 清理过期文件：读不了 ${dir}：${errorText(error)}`);
      continue;
    }
    for (const name of names) {
      if (!UPLOAD_ID.test(name)) continue;
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
      } catch (error) {
        log(`${LOG_PREFIX} 清理过期文件：删不掉 ${path}，跳过：${errorText(error)}`);
      }
    }
  }
}

/** 马上清一次，之后每天清一次。返回停止函数（关机时调，清掉定时器）。 */
export function startFileCleanup(dirs: readonly string[], log: (line: string) => void): () => void {
  cleanupExpiredFiles(dirs, log);
  const timer = setInterval(() => cleanupExpiredFiles(dirs, log), FILE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
