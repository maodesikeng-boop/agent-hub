// 文件进出（docs/feishu-design.md「交付与附件」）：项目经理发的文件、卡片的交付物、网页上用户发的附件传到飞书，
// 图片拿图片编号嵌进卡片、别的文件拿文件编号紧跟卡片发成文件消息；主人（或本档允许的访客）在飞书里发的图片、文件、视频、语音
// 下载存成附件，随消息交给项目经理。
// 不变量：
// - 图片 ≤ 10 MB 走上传图片（嵌进卡片）；超过 FEISHU_IMAGE_MAX_EDGE 边长或 FEISHU_IMAGE_SHRINK_BYTES 的位图先在临时目录缩一份再传，
//   avif（飞书图片接口不收）一律转一份，超过 10 MB 的动图取第一帧；传完删掉临时文件，磁盘上的原文件不动；
//   要转、要缩却转不成（读不出来、加载不了 sharp）的不白传，按飞书拒收报 FEISHU_IMAGE_REJECTED_CODE；
// - 其他文件 ≤ 30 MB 走上传文件，消息类型和上传类型照飞书配对（mp4 发视频 media、opus 发语音 audio、其余发文件 file，
//   不配对飞书回 230055）；超过的不传，卡上写一行“文件太大，去网页看”；
// - 发文件消息带 uuid fusa-file-<消息编号>-<第几个>，重发同一个文件飞书只收一次；
// - 下载是流，边收边写盘，最多 MAX_UPLOAD_BYTES（和网页上传同一个上限），超了不存、回一句提示；存法和网页上传一样走 saveUpload。
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
  /** 账本消息编号和第几个文件，记 feishu_posts 用。 */
  messageId: MessageId;
  part: number;
  /** 本机绝对路径（sent-files 副本、交付物副本或网页上传的附件）。 */
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

/** 能先缩一份再传的位图（sharp 能读、飞书能收）；gif 可能是动图，不缩。 */
const SHRINKABLE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

/**
 * 后置：按 mime 和大小定怎么发：image/* 且 ≤ FEISHU_IMAGE_MAX_BYTES（能缩的位图不限大小）发图片；其余 ≤ FEISHU_FILE_MAX_BYTES 发文件
 * （按扩展名定 fileType，msgType 和它配对：mp4 → media，opus → audio，其余 → file）；更大的 too_large。
 */
export function planFeishuFile(file: FeishuOutboundFile): FeishuFilePlan {
  if (isImageMime(file.mime) && (file.bytes <= FEISHU_IMAGE_MAX_BYTES || SHRINKABLE_MIMES.has(file.mime))) return { kind: "image", file };
  if (file.bytes > FEISHU_FILE_MAX_BYTES) return { kind: "too_large", file };
  const fileType = FILE_TYPES[extname(file.name).slice(1).toLowerCase()] ?? "stream";
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

/** 原样传飞书一定不收、非转一份不可的图：avif，或超过 FEISHU_IMAGE_MAX_BYTES 的。 */
const mustConvert = (file: Pick<FeishuOutboundFile, "mime" | "bytes">) => file.mime === "image/avif" || file.bytes > FEISHU_IMAGE_MAX_BYTES;

/**
 * 位图超过 FEISHU_IMAGE_MAX_EDGE 边长或 FEISHU_IMAGE_SHRINK_BYTES、是 avif 时，在临时目录写一份最长边 ≤ FEISHU_IMAGE_MAX_EDGE 的副本，返回它的路径；
 * 动图不超过 FEISHU_IMAGE_MAX_BYTES 时照原图传（保留动画），超过的只取第一帧。
 * 不用缩、缩不了（读不出来、这台机器加载不了 sharp）返回 null。png 照旧出 png，缩完还超过 FEISHU_IMAGE_SHRINK_BYTES 改出 jpeg；webp 出 webp；别的出 jpeg。
 * 官方 sharp 只在要发图片时才加载（docs/feishu-design.md「性能」）。
 */
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

/** 飞书消息里的图片不带文件名：按开头几个字节认出格式起个名字。 */
function imageNameOf(fileKey: string, data: Buffer): string {
  const hex = data.subarray(0, 4).toString("hex");
  const ext = hex.startsWith("89504e47") ? "png" : hex.startsWith("ffd8ff") ? "jpg" : hex.startsWith("47494638") ? "gif" : data.subarray(8, 12).toString("latin1") === "WEBP" ? "webp" : "png";
  return `飞书图片-${fileKey.slice(-8)}.${ext}`;
}

/** 先读出第一块用来认图片格式，再原样塞回流前面，整条流照样边收边写盘；流结束时没有数据回空 Buffer。 */
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

/** 一个附件传完的结果：图片编号（嵌进卡片）、文件编号和要配的消息类型，或太大没传。 */
export type FeishuUploaded =
  | { kind: "image"; imageKey: string }
  | { kind: "file"; fileKey: string; msgType: FeishuFileMsgType }
  | { kind: "too_large" };

export interface FeishuFileService {
  /** 后置：按 planFeishuFile 传上去（图片先按 shrinkFeishuImage 缩），返回编号；too_large 不传。上传出错往外抛。 */
  upload(file: FeishuOutboundFile): Promise<FeishuUploaded>;
  /** 后置：把传好的文件发到 chatId 的主聊天流，返回飞书消息编号。 */
  sendFile(chatId: FeishuChatId, file: FeishuOutboundFile, uploaded: Extract<FeishuUploaded, { kind: "file" }>): Promise<FeishuMessageId>;
  /** 后置：下载并存成附件；超过上限或下载失败返回 null，不存半截文件，下载失败记一行日志。 */
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
