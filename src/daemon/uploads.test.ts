import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_NAME_BYTES, utf8Bytes } from "../shared/index.ts";
import { UploadError, resolveUpload, sanitizeFileName, saveUpload } from "./uploads.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-uploads-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("文件名清理", () => {
  it("路径穿越：只留最后一段，../ 和绝对路径都去掉", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\Windows\\win.ini")).toBe("win.ini");
    expect(sanitizeFileName("a/b/c.txt")).toBe("c.txt");
  });

  it("什么都不剩（空、点、点点、只有斜杠）用默认名", () => {
    for (const raw of ["", " ", ".", "..", "/", "a/..", "../", "\u0000"]) expect(sanitizeFileName(raw), JSON.stringify(raw)).toBe("文件");
  });

  it("控制字符（换行、NUL）和方向控制符去掉：文件名会出现在发给 agent 的正文里，不能换行注入", () => {
    expect(sanitizeFileName("a\nb\r.txt")).toBe("ab.txt");
    expect(sanitizeFileName("x\u0000y.png")).toBe("xy.png");
    expect(sanitizeFileName("gpj.‮txt")).toBe("gpj.txt");
  });

  it("行分隔符、段分隔符、不可见的格式字符（U+2028、U+2029、U+200E、U+FEFF）也去掉：它们能让文件名在清单里“换行”或藏字", () => {
    expect(sanitizeFileName("a\u2028b.txt")).toBe("ab.txt");
    expect(sanitizeFileName("a\u2029b.txt")).toBe("ab.txt");
    expect(sanitizeFileName("a\u200eb.txt")).toBe("ab.txt");
    expect(sanitizeFileName("\ufeffa.txt")).toBe("a.txt");
    expect(sanitizeFileName("\u2028\u200e")).toBe("文件");
  });

  it("非 ASCII 文件名原样保留，统一成 NFC", () => {
    expect(sanitizeFileName("屏幕截图 2026-11-04 下午3.15.png")).toBe("屏幕截图 2026-11-04 下午3.15.png");
    expect(sanitizeFileName("é.txt")).toBe("é.txt");
    expect(sanitizeFileName("🙂 笑脸.png")).toBe("🙂 笑脸.png");
  });

  it("太长的名字截断到上限，扩展名留着，不会切坏一个字", () => {
    const long = `${"很长".repeat(100)}.pdf`;
    const name = sanitizeFileName(long);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(MAX_UPLOAD_NAME_BYTES);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name).not.toContain("�");
  });
});

describe("存文件", () => {
  it("正常上传：uploads/<编号>/<文件名>，内容原样，返回完整绝对路径、大小、类型", async () => {
    const result = await saveUpload(dir, "笔记.txt", bytes("你好"));
    expect(result.name).toBe("笔记.txt");
    expect(result.size).toBe(6);
    expect(result.mime).toBe("application/octet-stream");
    expect(result.path).toBe(join(dir, result.id, "笔记.txt"));
    expect(readFileSync(result.path, "utf8")).toBe("你好");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(result.path)).mode & 0o777).toBe(0o700);
  });

  it("图片按扩展名认类型", async () => {
    expect((await saveUpload(dir, "a.PNG", bytes("x"))).mime).toBe("image/png");
  });

  it("同名文件上传两次：各有各的目录，谁也不覆盖谁", async () => {
    const a = await saveUpload(dir, "image.png", bytes("第一张"));
    const b = await saveUpload(dir, "image.png", bytes("第二张"));
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("第一张");
    expect(readFileSync(b.path, "utf8")).toBe("第二张");
    expect(basename(a.path)).toBe("image.png");
  });

  it("文件名里带 ../：文件一定落在 uploads/ 里面，外面没有任何新文件", async () => {
    const outer = join(dir, "uploads");
    const result = await saveUpload(outer, "../../../evil.sh", bytes("x"));
    expect(result.name).toBe("evil.sh");
    expect(relative(outer, result.path).startsWith("..")).toBe(false);
    expect(readdirSync(dir)).toEqual(["uploads"]);
    expect(readdirSync(outer)).toEqual([result.id]);
  });

  it("空文件：拒绝，中文原因，磁盘上不留目录", async () => {
    const error = await saveUpload(dir, "空.txt", Buffer.alloc(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toBe("文件是空的，没有内容可发");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("超过上限：拒绝，中文原因里写明上限；刚好等于上限的收下", async () => {
    const error = await saveUpload(dir, "big.bin", Buffer.alloc(MAX_UPLOAD_BYTES + 1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toBe("文件太大，单个文件最多 20 MB");
    expect(readdirSync(dir)).toEqual([]);
    const ok = await saveUpload(dir, "edge.bin", Buffer.alloc(MAX_UPLOAD_BYTES));
    expect(ok.size).toBe(MAX_UPLOAD_BYTES);
  });
});

describe("按编号找回文件（发消息、显示缩略图用）", () => {
  it("找得到：从磁盘重新算名字、路径、大小、类型", async () => {
    const saved = await saveUpload(dir, "图.jpg", bytes("abc"));
    expect(resolveUpload(dir, saved.id)).toEqual(saved);
  });

  it("编号不合法（带斜杠、点点、空）或没有这个目录：null，不会走出 uploads/", async () => {
    await saveUpload(dir, "a.txt", bytes("x"));
    for (const id of ["", "..", "../x", "a/b", "/etc", "x".repeat(200), "没有"]) expect(resolveUpload(dir, id), id).toBeNull();
    expect(resolveUpload(dir, "0123456789abcdef")).toBeNull();
  });

  it("uploads/<编号> 是符号链接（指向别处的目录）：当作没有，不跟着走", async () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "secret.txt"), "不该被读到");
    const uploads = join(dir, "uploads");
    mkdirSync(uploads);
    symlinkSync(elsewhere, join(uploads, "0123456789abcdef"));
    expect(resolveUpload(uploads, "0123456789abcdef")).toBeNull();
  });

  it("目录里的文件是符号链接（指向 uploads/ 外的文件）：当作没有", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "不该被读到");
    const uploads = join(dir, "uploads");
    mkdirSync(join(uploads, "0123456789abcdef"), { recursive: true });
    symlinkSync(outside, join(uploads, "0123456789abcdef", "link.txt"));
    expect(resolveUpload(uploads, "0123456789abcdef")).toBeNull();
  });

  it("目录里的文件被删了：null", async () => {
    const saved = await saveUpload(dir, "a.txt", bytes("x"));
    rmSync(saved.path);
    expect(existsSync(dirname(saved.path))).toBe(true);
    expect(resolveUpload(dir, saved.id)).toBeNull();
  });
});
