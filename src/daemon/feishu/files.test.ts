import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, MAX_UPLOAD_BYTES } from "../../shared/limits.ts";
import { resolveUpload } from "../uploads.ts";
import { createFeishuFileService, planFeishuFile, type FeishuOutboundFile } from "./files.ts";
import type { FeishuPostRecord, FeishuPostRef } from "./store.ts";
import { createFakeFeishu } from "./test-helpers.ts";

const file = (name: string, mime: string, bytes: number): FeishuOutboundFile => ({ messageId: 1, part: 0, path: `/tmp/${name}`, name, mime, bytes });

describe("planFeishuFile", () => {
  it("10 MB 以内的图片发图片；更大的图片按文件发", () => {
    expect(planFeishuFile(file("a.png", "image/png", FEISHU_IMAGE_MAX_BYTES)).kind).toBe("image");
    expect(planFeishuFile(file("a.png", "image/png", FEISHU_IMAGE_MAX_BYTES + 1))).toMatchObject({ kind: "file", fileType: "stream" });
  });

  it("30 MB 以内的其他文件发文件，fileType 按扩展名定（pdf、doc、xls、ppt、mp4、opus，其余 stream）", () => {
    const types = ["r.pdf", "r.docx", "r.xlsx", "r.pptx", "r.mp4", "r.opus", "r.md", "noext"].map((n) => planFeishuFile(file(n, "application/octet-stream", 10)));
    expect(types.map((t) => (t.kind === "file" ? t.fileType : t.kind))).toEqual(["pdf", "doc", "xls", "ppt", "mp4", "opus", "stream", "stream"]);
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

  const memoryStore = () => {
    const posts = new Map<string, FeishuPostRecord>();
    const key = (ref: FeishuPostRef) => JSON.stringify(ref);
    return {
      postOf: (ref: FeishuPostRef) => posts.get(key(ref)) ?? null,
      savePost: (record: Omit<FeishuPostRecord, "updatedAt">, now: number) => void posts.set(key(record.ref), { ...record, updatedAt: now }),
    };
  };

  it("同一个账本文件只上传一次，第二次直接返回记下的消息编号", async () => {
    const fake = createFakeFeishu();
    const svc = createFeishuFileService({ transport: fake, store: memoryStore(), uploadsDir: dir, now: () => 1 });
    const path = join(dir, "shot.png");
    writeFileSync(path, "x");
    const f: FeishuOutboundFile = { messageId: 7, part: 0, path, name: "shot.png", mime: "image/png", bytes: 1 };
    const first = await svc.send("oc_1" as FeishuChatId, f);
    const second = await svc.send("oc_1" as FeishuChatId, f);
    expect(second).toBe(first);
    expect(fake.calls.filter((c) => c.method === "uploadImage")).toHaveLength(1);
    expect(fake.callsOf("message.create")).toHaveLength(1);
    expect(fake.callsOf("message.create")[0]).toMatchObject({ msg_type: "image", receive_id: "oc_1" });
    const md = await svc.send("oc_1" as FeishuChatId, { ...f, part: 1, name: "a.md", mime: "application/octet-stream" });
    expect(md).not.toBe(first);
    expect(fake.callsOf("message.create")[1]).toMatchObject({ msg_type: "file" });
    await svc.send("oc_1" as FeishuChatId, { ...f, part: 2, name: "huge.zip", mime: "application/octet-stream", bytes: FEISHU_FILE_MAX_BYTES + 1 });
    expect(fake.callsOf("message.create")[2]).toMatchObject({ msg_type: "text" });
    expect(fake.calls.filter((c) => c.method === "uploadFile")).toHaveLength(1);
  });

  it("下载超过 MAX_UPLOAD_BYTES 时返回 null，上传目录里不留文件", async () => {
    const fake = createFakeFeishu();
    fake.resources.set("file_big", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    const svc = createFeishuFileService({ transport: fake, store: memoryStore(), uploadsDir: dir, now: () => 1 });
    expect(await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "file_big", fileName: "big.bin" })).toBeNull();
    expect(await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "missing", fileName: "x" })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("下载成功存成附件，和网页上传一样的目录和命名", async () => {
    const fake = createFakeFeishu();
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    fake.resources.set("img_k1", png);
    fake.resources.set("file_k2", Buffer.from("# 笔记"));
    const svc = createFeishuFileService({ transport: fake, store: memoryStore(), uploadsDir: dir, now: () => 1 });
    const image = (await svc.receive("om_1" as FeishuMessageId, { type: "image", fileKey: "img_k1", fileName: null }))!;
    expect(image.mime).toBe("image/png");
    expect(resolveUpload(dir, image.id)).toEqual(image);
    const doc = (await svc.receive("om_1" as FeishuMessageId, { type: "file", fileKey: "file_k2", fileName: "笔记.md" }))!;
    expect(doc.name).toBe("笔记.md");
    expect(existsSync(doc.path)).toBe(true);
    expect(readFileSync(doc.path, "utf8")).toBe("# 笔记");
  });
});
