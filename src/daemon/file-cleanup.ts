import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  FILE_BYTE_CAP_MIN_AGE_DAYS,
  FILE_CLEANUP_INTERVAL_MS,
  FILE_RETENTION_DAYS,
  LOG_PREFIX,
  RESOURCES_DIR_SCAN_MAX_ENTRIES,
  SENT_FILES_DISK_MAX_BYTES,
  SENT_FILES_RETENTION_DAYS,
  SETUP_LOGS_MAX_FILES,
  SETUP_LOGS_RETENTION_DAYS,
  UPLOADS_DISK_MAX_BYTES,
} from "../shared/index.ts";
import { UPLOAD_ID } from "./uploads.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SETUP_LOG_NAME = /^worker-([1-9]\d*)\.log$/;

export interface ManagedFileCleanupOptions {
  readonly uploadsDir?: string;
  readonly sentFilesDir?: string;
  readonly setupLogsDir?: string;
  readonly uploadsMaxBytes?: number;
  readonly sentFilesMaxBytes?: number;
  readonly setupLogsMaxFiles?: number;
  readonly isWorkerOpen?: (workerId: number) => boolean;
  readonly now?: () => number;
}

export interface FileCleanupStats {
  readonly removedFiles: number;
  readonly removedBytes: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function measureTreeBytes(root: string): number {
  let bytes = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < RESOURCES_DIR_SCAN_MAX_ENTRIES) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > RESOURCES_DIR_SCAN_MAX_ENTRIES) break;
      const full = join(dir, name);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) bytes += st.size;
      } catch {
      }
    }
  }
  return bytes;
}

function cleanupUploadLikeDir(
  dir: string,
  retentionDays: number,
  maxBytes: number | null,
  nowMs: number,
  log: (line: string) => void,
): FileCleanupStats {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`${LOG_PREFIX} 清理过期文件：读不了 ${dir}：${errorText(error)}`);
    return { removedFiles: 0, removedBytes: 0 };
  }
  const cutoff = nowMs - retentionDays * DAY_MS;
  const evictableBefore = nowMs - FILE_BYTE_CAP_MIN_AGE_DAYS * DAY_MS;
  const kept: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
  let removedFiles = 0;
  let removedBytes = 0;

  for (const name of names) {
    if (!UPLOAD_ID.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        const bytes = maxBytes === null ? 0 : measureTreeBytes(path);
        rmSync(path, { recursive: true, force: true });
        removedFiles += 1;
        removedBytes += bytes;
      } else if (maxBytes !== null) {
        kept.push({ path, mtimeMs: stat.mtimeMs, bytes: measureTreeBytes(path) });
      }
    } catch (error) {
      log(`${LOG_PREFIX} 清理过期文件：删不掉 ${path}，跳过：${errorText(error)}`);
    }
  }

  if (maxBytes !== null) {
    let totalBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    if (totalBytes > maxBytes) {
      kept.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
      for (const entry of kept) {
        if (totalBytes <= maxBytes || entry.mtimeMs >= evictableBefore) break;
        try {
          rmSync(entry.path, { recursive: true, force: true });
          totalBytes -= entry.bytes;
          removedFiles += 1;
          removedBytes += entry.bytes;
        } catch (error) {
          log(`${LOG_PREFIX} 清理超限文件：删不掉 ${entry.path}，跳过：${errorText(error)}`);
        }
      }
    }
  }

  return { removedFiles, removedBytes };
}

export function cleanupSetupLogs(
  setupLogsDir: string,
  options: { now?: () => number; maxFiles?: number; retentionDays?: number; isWorkerOpen?: (workerId: number) => boolean } = {},
  log: (line: string) => void = () => {},
): FileCleanupStats {
  let names: string[];
  try {
    names = readdirSync(setupLogsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`${LOG_PREFIX} 清理准备日志：读不了 ${setupLogsDir}：${errorText(error)}`);
    return { removedFiles: 0, removedBytes: 0 };
  }
  const nowMs = (options.now ?? Date.now)();
  const maxFiles = Math.max(0, options.maxFiles ?? SETUP_LOGS_MAX_FILES);
  const cutoff = nowMs - (options.retentionDays ?? SETUP_LOGS_RETENTION_DAYS) * DAY_MS;
  const isOpen = options.isWorkerOpen ?? (() => false);

  const retained: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
  let removedFiles = 0;
  let removedBytes = 0;

  for (const name of names) {
    const match = SETUP_LOG_NAME.exec(name);
    if (match === null) continue;
    const workerId = Number(match[1]);
    if (isOpen(workerId)) continue;
    const path = join(setupLogsDir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removedFiles += 1;
        removedBytes += st.size;
      } else {
        retained.push({ path, mtimeMs: st.mtimeMs, bytes: st.size });
      }
    } catch (error) {
      log(`${LOG_PREFIX} 清理准备日志：删不掉 ${path}，跳过：${errorText(error)}`);
    }
  }

  if (retained.length > maxFiles) {
    retained.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    const excess = retained.length - maxFiles;
    for (let i = 0; i < excess; i++) {
      const entry = retained[i]!;
      try {
        rmSync(entry.path, { force: true });
        removedFiles += 1;
        removedBytes += entry.bytes;
      } catch (error) {
        log(`${LOG_PREFIX} 清理准备日志：删不掉 ${entry.path}，跳过：${errorText(error)}`);
      }
    }
  }

  return { removedFiles, removedBytes };
}

export function cleanupManagedFiles(options: ManagedFileCleanupOptions, log: (line: string) => void): FileCleanupStats {
  const nowMs = (options.now ?? Date.now)();
  let removedFiles = 0;
  let removedBytes = 0;
  if (options.uploadsDir !== undefined) {
    const r = cleanupUploadLikeDir(options.uploadsDir, FILE_RETENTION_DAYS, options.uploadsMaxBytes ?? UPLOADS_DISK_MAX_BYTES, nowMs, log);
    removedFiles += r.removedFiles;
    removedBytes += r.removedBytes;
  }
  if (options.sentFilesDir !== undefined) {
    const r = cleanupUploadLikeDir(options.sentFilesDir, SENT_FILES_RETENTION_DAYS, options.sentFilesMaxBytes ?? SENT_FILES_DISK_MAX_BYTES, nowMs, log);
    removedFiles += r.removedFiles;
    removedBytes += r.removedBytes;
  }
  if (options.setupLogsDir !== undefined) {
    const r = cleanupSetupLogs(
      options.setupLogsDir,
      { now: () => nowMs, maxFiles: options.setupLogsMaxFiles, isWorkerOpen: options.isWorkerOpen },
      log,
    );
    removedFiles += r.removedFiles;
    removedBytes += r.removedBytes;
  }
  return { removedFiles, removedBytes };
}

export function cleanupExpiredFiles(dirs: readonly string[], log: (line: string) => void): void {
  const nowMs = Date.now();
  for (const dir of dirs) cleanupUploadLikeDir(dir, FILE_RETENTION_DAYS, null, nowMs, log);
}

export function startFileCleanup(
  targets: readonly string[] | ManagedFileCleanupOptions,
  log: (line: string) => void,
): () => void {
  const run = () => {
    if (Array.isArray(targets)) cleanupExpiredFiles(targets, log);
    else cleanupManagedFiles(targets as ManagedFileCleanupOptions, log);
  };
  run();
  const timer = setInterval(run, FILE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
