import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_CLEANUP_INTERVAL_MS, FILE_RETENTION_DAYS } from "../shared/index.ts";
import { cleanupExpiredFiles, startFileCleanup } from "./file-cleanup.ts";

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
