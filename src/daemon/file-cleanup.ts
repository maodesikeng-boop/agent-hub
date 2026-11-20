import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FILE_CLEANUP_INTERVAL_MS, FILE_RETENTION_DAYS, LOG_PREFIX } from "../shared/index.ts";
import { UPLOAD_ID } from "./uploads.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export function startFileCleanup(dirs: readonly string[], log: (line: string) => void): () => void {
  cleanupExpiredFiles(dirs, log);
  const timer = setInterval(() => cleanupExpiredFiles(dirs, log), FILE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
