import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, FEISHU_IMAGE_MAX_EDGE, MAX_UPLOAD_BYTES } from "../../shared/limits.ts";
import { resolveUpload } from "../uploads.ts";
import { createFeishuFileService, planFeishuFile, type FeishuOutboundFile } from "./files.ts";
import { createFakeFeishu } from "./test-helpers.ts";
import { isFeishuRejection } from "./transport.ts";

const file = (name: string, mime: string, bytes: number): FeishuOutboundFile => ({ messageId: 1, part: 0, path: `/tmp/${name}`, name, mime, bytes });

const MB = 1024 * 1024;

/** 像慢网上的飞书下载连接：给够 total 字节后停住，不结束也不报错，只有被销毁才断开。第一块以 png 文件头开头。 */
function stalledDownload(total: number): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) return;
      const chunk = Buffer.alloc(MB);
      if (sent === 0) chunk.write("89504e470d0a1a0a", "hex");
      sent += chunk.length;
      this.push(chunk);
    },
  });
}

/** 等 promise，2 秒还没结果当挂住了。 */
const settleWithin = <T>(promise: Promise<T>): Promise<T | "挂住了"> =>
  Promise.race([promise, new Promise<"挂住了">((resolve) => setTimeout(() => resolve("挂住了"), 2000))]);

describe("planFeishuFile", () => {
  it("图片发图片（能缩的位图不限大小，上传前缩）；超过 10 MB 又不能缩的图片（gif）按文件发", () => {
    expect(planFeishuFile(file("a.png", "image/png", FEISHU_IMAGE_MAX_BYTES)).kind).toBe("image");
    expect(planFeishuFile(file("a.png", "image/png", FEISHU_IMAGE_MAX_BYTES + 1)).kind).toBe("image");
    expect(planFeishuFile(file("a.gif", "image/gif", FEISHU_IMAGE_MAX_BYTES + 1))).toMatchObject({ kind: "file", fileType: "stream" });
  });

  it("30 MB 以内的其他文件发文件，fileType 按扩展名定（pdf、doc、xls、ppt、mp4、opus，其余 stream）", () => {
    const types = ["r.pdf", "r.docx", "r.xlsx", "r.pptx", "r.mp4", "r.opus", "r.md", "noext"].map((n) => planFeishuFile(file(n, "application/octet-stream", 10)));
    expect(types.map((t) => (t.kind === "file" ? t.fileType : t.kind))).toEqual(["pdf", "doc", "xls", "ppt", "mp4", "opus", "stream", "stream"]);
  });

  it("消息类型和上传类型配对：mp4 发 media、opus 发 audio，其余发 file", () => {
    const plans = ["r.mp4", "r.opus", "r.pdf", "r.md"].map((n) => planFeishuFile(file(n, "application/octet-stream", 10)));
    expect(plans.map((p) => (p.kind === "file" ? p.msgType : p.kind))).toEqual(["media", "audio", "file", "file"]);
  });

  it("超过 30 MB 的 too_large", () => {
    expect(planFeishuFile(file("big.zip", "application/octet-stream", FEISHU_FILE_MAX_BYTES + 1)).kind).toBe("too_large");
  });
});

describe("createFeishuFileService", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "feishu-files-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("图片传成图片编号，别的文件传成文件编号并配好消息类型，太大的不传；发文件消息带固定 uuid", async () => {
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const path = join(dir, "shot.png");
    writeFileSync(path, "x");
    const f: FeishuOutboundFile = { messageId: 7, part: 0, path, name: "shot.png", mime: "image/png", bytes: 1 };
    expect(await svc.upload(f)).toMatchObject({ kind: "image", imageKey: expect.stringMatching(/^img_/) });
    const mp4 = await svc.upload({ ...f, part: 1, name: "demo.mp4", mime: "application/octet-stream" });
    expect(mp4).toMatchObject({ kind: "file", msgType: "media" });
    expect(await svc.upload({ ...f, part: 2, name: "huge.zip", mime: "application/octet-stream", bytes: FEISHU_FILE_MAX_BYTES + 1 })).toEqual({ kind: "too_large" });
    expect(fake.calls.filter((c) => c.method === "uploadFile")).toHaveLength(1);
    if (mp4.kind !== "file") throw new Error("unreachable");
    await svc.sendFile("oc_1" as FeishuChatId, { ...f, part: 1, name: "demo.mp4" }, mp4);
    expect(fake.callsOf("message.create")[0]).toMatchObject({ msg_type: "media", receive_id: "oc_1", uuid: "fusa-file-7-1" });
  });

  it("超过最长边的截图传缩过的临时副本，传完删掉临时副本，原图不动", async () => {
    const sharp = (await import("sharp")).default;
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const path = join(dir, "wide.png");
    await sharp({ create: { width: FEISHU_IMAGE_MAX_EDGE * 2, height: 100, channels: 3, background: "#336699" } }).png().toFile(path);
    const original = readFileSync(path);
    let seen: { path: string; width: number } | null = null;
    fake.beforeUpload = async (input) => {
      if (!("path" in input)) return;
      seen = { path: input.path, width: (await sharp(input.path).metadata()).width ?? 0 };
    };
    await svc.upload({ messageId: 1, part: 0, path, name: "wide.png", mime: "image/png", bytes: original.length });
    expect(seen!.path).not.toBe(path);
    expect(seen!.width).toBe(FEISHU_IMAGE_MAX_EDGE);
    expect(existsSync(seen!.path)).toBe(false);
    expect(readFileSync(path).equals(original)).toBe(true);
  });

  it("avif 再小也转成飞书收的格式再传（飞书图片接口不收 avif）", async () => {
    const sharp = (await import("sharp")).default;
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const path = join(dir, "small.avif");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).avif().toFile(path);
    let format: string | undefined;
    fake.beforeUpload = async (input) => {
      if ("path" in input) format = (await sharp(input.path).metadata()).format;
    };
    expect(await svc.upload({ messageId: 1, part: 0, path, name: "small.avif", mime: "image/avif", bytes: readFileSync(path).length })).toMatchObject({ kind: "image" });
    expect(format).toBe("jpeg");
  });

  it("超过 10 MB 的图缩不了（读不出来、加载不了 sharp）时不白传：按飞书拒收报错，不调上传图片", async () => {
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const path = join(dir, "broken.png");
    writeFileSync(path, "not really a png");
    const error = await svc.upload({ messageId: 1, part: 0, path, name: "broken.png", mime: "image/png", bytes: FEISHU_IMAGE_MAX_BYTES + 1 }).catch((e: unknown) => e);
    expect(isFeishuRejection(error)).toBe(true);
    expect(fake.calls.filter((c) => c.method === "uploadImage")).toEqual([]);
  });

  it("超过 10 MB 的动图取第一帧缩成静态图再传", async () => {
    const sharp = (await import("sharp")).default;
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const frame = (color: string) => sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).png().toBuffer();
    const path = join(dir, "anim.webp");
    await sharp([await frame("#ff0000"), await frame("#00ff00")], { join: { animated: true } }).webp().toFile(path);
    expect((await sharp(path).metadata()).pages).toBe(2);
    let pages: number | undefined;
    fake.beforeUpload = async (input) => {
      if ("path" in input) pages = (await sharp(input.path).metadata()).pages ?? 1;
    };
    expect(await svc.upload({ messageId: 1, part: 0, path, name: "anim.webp", mime: "image/webp", bytes: FEISHU_IMAGE_MAX_BYTES + 1 })).toMatchObject({ kind: "image" });
    expect(pages).toBe(1);
  });

  it("下载超过 MAX_UPLOAD_BYTES 时返回 null，上传目录里不留文件", async () => {
    const fake = createFakeFeishu();
    fake.resources.set("file_big", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    expect(await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "file_big", fileName: "big.bin" })).toBeNull();
    expect(await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "missing", fileName: "x" })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("图片下载超过 MAX_UPLOAD_BYTES 而飞书那头还没发完：立刻返回 null，断开下载连接，不留文件", async () => {
    const fake = createFakeFeishu();
    const download = stalledDownload(MAX_UPLOAD_BYTES + 2 * MB);
    fake.resources.set("img_big", download);
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    expect(await settleWithin(svc.receive("om_1" as FeishuMessageId, { type: "image", fileKey: "img_big", fileName: null }))).toBeNull();
    expect(download.destroyed).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("写不了盘（上传目录建不出来）：图片和文件都立刻返回 null，断开下载连接", async () => {
    const notDir = join(dir, "not-a-dir");
    writeFileSync(notDir, "");
    const fake = createFakeFeishu();
    const image = stalledDownload(MB);
    const doc = stalledDownload(MB);
    fake.resources.set("img_k", image);
    fake.resources.set("file_k", doc);
    const svc = createFeishuFileService({ transport: fake, uploadsDir: notDir, log: () => {} });
    expect(await settleWithin(svc.receive("om_1" as FeishuMessageId, { type: "image", fileKey: "img_k", fileName: null }))).toBeNull();
    expect(await settleWithin(svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "file_k", fileName: "a.mov" }))).toBeNull();
    expect(image.destroyed).toBe(true);
    expect(doc.destroyed).toBe(true);
  });

  it("下载失败返回 null 并记一行日志，带上消息编号和出错原因（飞书权限不够、资源过期不再悄悄吞掉）", async () => {
    const fake = createFakeFeishu();
    const lines: string[] = [];
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: (line) => lines.push(line) });
    expect(await svc.receive("om_9" as FeishuMessageId, { type: "image", fileKey: "img_gone", fileName: null })).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("om_9");
    expect(lines[0]).toContain("no such resource");
  });

  it("下载成功存成附件，和网页上传一样的目录和命名", async () => {
    const fake = createFakeFeishu();
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    fake.resources.set("img_k1", png);
    fake.resources.set("file_k2", Buffer.from("# 笔记"));
    const svc = createFeishuFileService({ transport: fake, uploadsDir: dir, log: () => {} });
    const image = (await svc.receive("om_1" as FeishuMessageId, { type: "image", fileKey: "img_k1", fileName: null }))!;
    expect(image.mime).toBe("image/png");
    expect(resolveUpload(dir, image.id)).toEqual(image);
    const doc = (await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "file_k2", fileName: "笔记.md" }))!;
    expect(doc.name).toBe("笔记.md");
    expect(existsSync(doc.path)).toBe(true);
    expect(readFileSync(doc.path, "utf8")).toBe("# 笔记");
  });
});
