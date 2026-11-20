import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { extname, join } from "node:path";
import type { MessageId } from "../../shared/domain.ts";
import { isImageMime, type Attachment } from "../../shared/attachments.ts";
import { parseFeishuMessageId, type FeishuChatId, type FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, FEISHU_IMAGE_MAX_EDGE, FEISHU_IMAGE_SHRINK_BYTES } from "../../shared/limits.ts";
import { saveUpload } from "../uploads.ts";
import type { FeishuInboundFile } from "./inbound.ts";
import { FEISHU_IMAGE_REJECTED_CODE, FeishuApiError, feishuDataOf, feishuStringField, type FeishuFileUpload, type FeishuTransport } from "./transport.ts";

export interface FeishuOutboundFile {
  messageId: MessageId;
  part: number;
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

export type FeishuFileMsgType = "file" | "media" | "audio";

export type FeishuFilePlan =
  | { kind: "image"; file: FeishuOutboundFile }
  | { kind: "file"; file: FeishuOutboundFile; fileType: FeishuFileUpload["fileType"]; msgType: FeishuFileMsgType }
  | { kind: "too_large"; file: FeishuOutboundFile };

const SHRINKABLE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

export function planFeishuFile(file: FeishuOutboundFile): FeishuFilePlan {
  if (isImageMime(file.mime) && (file.bytes <= FEISHU_IMAGE_MAX_BYTES || SHRINKABLE_MIMES.has(file.mime))) return { kind: "image", file };
  if (file.bytes > FEISHU_FILE_MAX_BYTES) return { kind: "too_large", file };
  const fileType = FILE_TYPES[extname(file.name).slice(1).toLowerCase()] ?? "stream";
  // Feishu rejects the message with 230055 unless msg_type matches the uploaded file_type.
  return { kind: "file", file, fileType, msgType: fileType === "mp4" ? "media" : fileType === "opus" ? "audio" : "file" };
}

const FILE_TYPES: Readonly<Record<string, FeishuFileUpload["fileType"]>> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  xls: "xls",
  xlsx: "xls",
  ppt: "ppt",
  pptx: "ppt",
  mp4: "mp4",
  opus: "opus",
};

// The Feishu image API rejects avif and anything over 10 MB, so those always get a converted copy.
const mustConvert = (file: Pick<FeishuOutboundFile, "mime" | "bytes">) => file.mime === "image/avif" || file.bytes > FEISHU_IMAGE_MAX_BYTES;

export async function shrinkFeishuImage(file: Pick<FeishuOutboundFile, "path" | "mime" | "bytes">): Promise<string | null> {
  if (!SHRINKABLE_MIMES.has(file.mime)) return null;
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(file.path).metadata();
    if (!mustConvert(file)) {
      if ((meta.pages ?? 1) > 1) return null;
      if (Math.max(meta.width ?? 0, meta.height ?? 0) <= FEISHU_IMAGE_MAX_EDGE && file.bytes <= FEISHU_IMAGE_SHRINK_BYTES) return null;
    }
    const resized = () => sharp(file.path).rotate().resize({ width: FEISHU_IMAGE_MAX_EDGE, height: FEISHU_IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
    let ext = meta.format === "png" ? "png" : meta.format === "webp" ? "webp" : "jpg";
    let data = ext === "png" ? await resized().png({ compressionLevel: 9 }).toBuffer() : ext === "webp" ? await resized().webp({ quality: 85 }).toBuffer() : null;
    if (data === null || data.length > FEISHU_IMAGE_SHRINK_BYTES) {
      data = await resized().flatten({ background: "#ffffff" }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      ext = "jpg";
    }
    const out = join(tmpdir(), `fusa-feishu-${randomUUID()}.${ext}`);
    await writeFile(out, data);
    return out;
  } catch {
    return null;
  }
}

function imageNameOf(fileKey: string, data: Buffer): string {
  const hex = data.subarray(0, 4).toString("hex");
  const ext = hex.startsWith("89504e47") ? "png" : hex.startsWith("ffd8ff") ? "jpg" : hex.startsWith("47494638") ? "gif" : data.subarray(8, 12).toString("latin1") === "WEBP" ? "webp" : "png";
  return `飞书图片-${fileKey.slice(-8)}.${ext}`;
}

function peekFirstChunk(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      stream.off("readable", onReadable).off("end", onEnd).off("error", onError);
      fn();
    };
    const onReadable = () => {
      const head = stream.read() as Buffer | null;
      if (head === null) return;
      settle(() => {
        stream.unshift(head);
        resolve(head);
      });
    };
    const onEnd = () => settle(() => resolve(Buffer.alloc(0)));
    const onError = (error: Error) => settle(() => reject(error));
    stream.on("readable", onReadable).on("end", onEnd).on("error", onError);
  });
}

export type FeishuUploaded =
  | { kind: "image"; imageKey: string }
  | { kind: "file"; fileKey: string; msgType: FeishuFileMsgType }
  | { kind: "too_large" };

export interface FeishuFileService {
  upload(file: FeishuOutboundFile): Promise<FeishuUploaded>;
  sendFile(chatId: FeishuChatId, file: FeishuOutboundFile, uploaded: Extract<FeishuUploaded, { kind: "file" }>): Promise<FeishuMessageId>;
  receive(messageId: FeishuMessageId, file: FeishuInboundFile): Promise<Attachment | null>;
}

export interface FeishuFileServiceDeps {
  transport: Pick<FeishuTransport, "call" | "uploadImage" | "uploadFile" | "downloadResource">;
  uploadsDir: string;
  log: (line: string) => void;
}

export function createFeishuFileService(deps: FeishuFileServiceDeps): FeishuFileService {
  const { transport } = deps;
  return {
    async upload(file) {
      const plan = planFeishuFile(file);
      if (plan.kind === "too_large") return { kind: "too_large" };
      if (plan.kind === "file") {
        const { fileKey } = await transport.uploadFile({ path: file.path, fileName: file.name, fileType: plan.fileType });
        return { kind: "file", fileKey, msgType: plan.msgType };
      }
      const shrunk = await shrinkFeishuImage(file);
      if (shrunk === null && mustConvert(file)) {
        throw new FeishuApiError("image.create", FEISHU_IMAGE_REJECTED_CODE, `「${file.name}」转不成飞书收的图片（avif 或超过 10 MB）`);
      }
      try {
        const { imageKey } = await transport.uploadImage({ imageType: "message", path: shrunk ?? file.path });
        return { kind: "image", imageKey };
      } finally {
        if (shrunk !== null) await rm(shrunk, { force: true });
      }
    },
    async sendFile(chatId, file, uploaded) {
      const result = await transport.call("message.create", {
        receive_id_type: "chat_id",
        receive_id: chatId,
        msg_type: uploaded.msgType,
        content: JSON.stringify({ file_key: uploaded.fileKey }),
        uuid: `fusa-file-${file.messageId}-${file.part}`,
      });
      const id = parseFeishuMessageId(feishuStringField(feishuDataOf("message.create", result), "message_id"));
      if (id === null) throw new Error("飞书发文件消息没回消息编号");
      return id;
    },
    async receive(messageId, file) {
      let stream: Readable | null = null;
      try {
        stream = await transport.downloadResource(messageId, file.fileKey, file.type);
        const name =
          file.fileName ?? (file.type === "file" ? `飞书文件-${file.fileKey.slice(-8)}` : imageNameOf(file.fileKey, await peekFirstChunk(stream)));
        return await saveUpload(deps.uploadsDir, name, stream);
      } catch (error) {
        deps.log(`下载 ${messageId} 里的${file.type === "image" ? "图片" : "文件"}没成：${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        stream?.destroy();
      }
    },
  };
}
