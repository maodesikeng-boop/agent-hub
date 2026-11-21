import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_CLEANUP_INTERVAL_MS,
  FILE_RETENTION_DAYS,
  FILE_BYTE_CAP_MIN_AGE_DAYS,
  SENT_FILES_RETENTION_DAYS,
  SETUP_LOGS_RETENTION_DAYS,
} from "../shared/index.ts";
import { cleanupExpiredFiles, cleanupManagedFiles, cleanupSetupLogs, startFileCleanup } from "./file-cleanup.ts";

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let uploads: string;
let sent: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-cleanup-")));
  uploads = join(root, "uploads");
  sent = join(root, "sent-files");
  mkdirSync(uploads);
  mkdirSync(sent);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function entry(dir: string, name: string, ageDays: number) {
  const path = join(dir, name);
  mkdirSync(path);
  writeFileSync(join(path, "a.txt"), "x");
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(path, t, t);
  return path;
}

describe("cleanupExpiredFiles", () => {
  it("过期的删，没过期的留，uploads 和 sent-files 都清", () => {
    const old1 = entry(uploads, "0123456789abcdef", FILE_RETENTION_DAYS + 1);
    const new1 = entry(uploads, "1123456789abcdef", FILE_RETENTION_DAYS - 1);
    const old2 = entry(sent, "2123456789abcdef", FILE_RETENTION_DAYS + 1);
    const new2 = entry(sent, "3123456789abcdef", 0);
    cleanupExpiredFiles([uploads, sent], () => {});
    expect([old1, old2].map(existsSync)).toEqual([false, false]);
    expect([new1, new2].map(existsSync)).toEqual([true, true]);
  });

  it("名字不是合法编号的（含拷了一半的 .partial-）不碰；符号链接不跟随、不删目标", () => {
    const bad = entry(uploads, "not-an-id", 100);
    const partial = entry(sent, ".partial-abc", 100);
    const target = entry(root, "target", 100);
    const link = join(uploads, "4123456789abcdef");
    symlinkSync(target, link);
    cleanupExpiredFiles([uploads, sent], () => {});
    expect([bad, partial, target].map(existsSync)).toEqual([true, true, true]);
    expect(existsSync(link)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("删不掉的跳过并记一行日志，别的照常删；目录不存在也不报错", () => {
    const locked = entry(uploads, "5123456789abcdef", 100);
    const inner = join(locked, "sub");
    mkdirSync(inner);
    writeFileSync(join(inner, "f"), "x");
    chmodSync(inner, 0o500); // 里面的文件删不掉
    const t = new Date(Date.now() - 100 * DAY);
    utimesSync(locked, t, t);
    const other = entry(uploads, "6123456789abcdef", 100);
    const log = vi.fn();
    expect(() => cleanupExpiredFiles([uploads, join(root, "missing")], log)).not.toThrow();
    chmodSync(inner, 0o700);
    expect(existsSync(other)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("5123456789abcdef");
  });
});

describe("startFileCleanup", () => {
  it("启动时清一次，之后每天清一次，停了就不再清", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = entry(uploads, "7123456789abcdef", 100);
    const stop = startFileCleanup([uploads], () => {});
    expect(existsSync(first)).toBe(false);
    const second = entry(uploads, "8123456789abcdef", 100);
    vi.advanceTimersByTime(FILE_CLEANUP_INTERVAL_MS);
    expect(existsSync(second)).toBe(false);
    stop();
    const third = entry(uploads, "9123456789abcdef", 100);
    vi.advanceTimersByTime(FILE_CLEANUP_INTERVAL_MS * 2);
    expect(existsSync(third)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("清理本身出错（比如目录是个文件）只记日志，不抛", () => {
    const file = join(root, "afile");
    writeFileSync(file, "x");
    const log = vi.fn();
    expect(() => startFileCleanup([file], log)()).not.toThrow();
  });
});

describe("cleanupManagedFiles and cleanupSetupLogs", () => {
  it("enforces SENT_FILES_RETENTION_DAYS and disk byte caps by evicting oldest directories first", () => {
    const nowMs = Date.now();
    const makeSized = (dir: string, id: string, ageDays: number, sizeBytes: number) => {
      const p = join(dir, id);
      mkdirSync(p);
      writeFileSync(join(p, "blob.bin"), Buffer.alloc(sizeBytes, 0x41));
      const t = new Date(nowMs - ageDays * DAY);
      utimesSync(p, t, t);
      return p;
    };
    const expiredSent = makeSized(sent, "0000000000000001", SENT_FILES_RETENTION_DAYS + 1, 100);
    const oldSent = makeSized(sent, "0000000000000002", 5, 600);
    const midSent = makeSized(sent, "0000000000000003", 2, 600);
    const newSent = makeSized(sent, "0000000000000004", 1, 600);
    const oldUpload = makeSized(uploads, "1000000000000001", 10, 700);
    const newUpload = makeSized(uploads, "1000000000000002", 1, 700);

    const stats = cleanupManagedFiles(
      {
        uploadsDir: uploads,
        sentFilesDir: sent,
        uploadsMaxBytes: 1_000,
        sentFilesMaxBytes: 1_200,
        now: () => nowMs,
      },
      () => {},
    );
    expect(stats.removedFiles).toBe(3);
    expect(existsSync(expiredSent)).toBe(false);
    expect(existsSync(oldSent)).toBe(false);
    expect(existsSync(midSent)).toBe(true);
    expect(existsSync(newSent)).toBe(true);
    expect(existsSync(oldUpload)).toBe(false);
    expect(existsSync(newUpload)).toBe(true);
  });

  it("never evicts uploads or deliveries younger than FILE_BYTE_CAP_MIN_AGE_DAYS to meet a byte cap", () => {
    const nowMs = Date.now();
    const fresh = Array.from({ length: 6 }, (_, i) => {
      const p = join(uploads, `200000000000000${i}`);
      mkdirSync(p);
      writeFileSync(join(p, "video.bin"), Buffer.alloc(100, 0x41));
      const t = new Date(nowMs - (FILE_BYTE_CAP_MIN_AGE_DAYS - 1) * DAY - i * 60_000);
      utimesSync(p, t, t);
      return p;
    });
    const stale = join(uploads, "2000000000000009");
    mkdirSync(stale);
    writeFileSync(join(stale, "old.bin"), Buffer.alloc(100, 0x41));
    const old = new Date(nowMs - (FILE_BYTE_CAP_MIN_AGE_DAYS + 1) * DAY);
    utimesSync(stale, old, old);

    const stats = cleanupManagedFiles({ uploadsDir: uploads, uploadsMaxBytes: 300, now: () => nowMs }, () => {});
    expect(stats.removedFiles).toBe(1);
    expect(existsSync(stale)).toBe(false);
    for (const p of fresh) expect(existsSync(p)).toBe(true);
  });

  it("caps setup logs by age and file count while sparing currently open Workers", () => {
    const nowMs = Date.now();
    const setupDir = join(root, "setup");
    mkdirSync(setupDir);
    const writeLog = (workerId: number, ageDays: number) => {
      const p = join(setupDir, `worker-${workerId}.log`);
      writeFileSync(p, `log-${workerId}`);
      const t = new Date(nowMs - ageDays * DAY);
      utimesSync(p, t, t);
      return p;
    };
    const expiredClosed = writeLog(1, SETUP_LOGS_RETENTION_DAYS + 2);
    const expiredOpen = writeLog(2, SETUP_LOGS_RETENTION_DAYS + 2);
    const freshOldest = writeLog(3, 4);
    const freshMid = writeLog(4, 2);
    const freshNewest = writeLog(5, 1);

    const stats = cleanupSetupLogs(
      setupDir,
      { now: () => nowMs, maxFiles: 2, isWorkerOpen: (id) => id === 2 },
      () => {},
    );
    expect(stats.removedFiles).toBe(2);
    expect(existsSync(expiredClosed)).toBe(false);
    expect(existsSync(expiredOpen)).toBe(true);
    expect(existsSync(freshOldest)).toBe(false);
    expect(existsSync(freshMid)).toBe(true);
    expect(existsSync(freshNewest)).toBe(true);
  });
});
