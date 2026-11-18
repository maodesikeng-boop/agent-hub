// 文件进出（docs/feishu-design.md「交付与附件」）：项目经理发的文件、卡片的交付物传成群里的原生图片和文件消息；
// 主人（或本档允许的访客）在飞书里发的图片、文件下载存成附件，随消息交给项目经理。
// 不变量：
// - 图片 ≤ 10 MB 走上传图片发成图片消息；其他文件 ≤ 30 MB 走上传文件发成文件消息；超过的不传，发一行“文件太大，去网页看”；
// - 同一个账本文件（feishu_posts 的 file ref）只传一次；
// - 下载最多 MAX_UPLOAD_BYTES（和网页上传同一个上限），超了不存、回一句提示；存法和网页上传一样走 saveUpload。
import { extname } from "node:path";
import type { MessageId } from "../../shared/domain.ts";
import { isImageMime, type Attachment } from "../../shared/attachments.ts";
import { parseFeishuMessageId, type FeishuChatId, type FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_FILE_MAX_BYTES, FEISHU_IMAGE_MAX_BYTES, MAX_UPLOAD_BYTES } from "../../shared/limits.ts";
import { saveUpload } from "../uploads.ts";
import type { FeishuInboundFile } from "./inbound.ts";
import type { FeishuStore } from "./store.ts";
import { feishuDataOf, feishuStringField, type FeishuTransport } from "./transport.ts";

export interface FeishuOutboundFile {
  /** 账本消息编号和第几个文件，记 feishu_posts 用。 */
  messageId: MessageId;
  part: number;
  /** 本机绝对路径（sent-files 副本或交付物副本）。 */
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

export type FeishuFilePlan =
  | { kind: "image"; file: FeishuOutboundFile }
  | { kind: "file"; file: FeishuOutboundFile; fileType: "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "stream" }
  | { kind: "too_large"; file: FeishuOutboundFile };

/** 后置：按 mime 和大小定怎么发：image/* 且 ≤ FEISHU_IMAGE_MAX_BYTES 发图片；其余 ≤ FEISHU_FILE_MAX_BYTES 发文件（按扩展名定 fileType）；更大的 too_large。 */
export function planFeishuFile(file: FeishuOutboundFile): FeishuFilePlan {
  if (isImageMime(file.mime) && file.bytes <= FEISHU_IMAGE_MAX_BYTES) return { kind: "image", file };
  if (file.bytes > FEISHU_FILE_MAX_BYTES) return { kind: "too_large", file };
  return { kind: "file", file, fileType: FILE_TYPES[extname(file.name).slice(1).toLowerCase()] ?? "stream" };
}

const FILE_TYPES: Readonly<Record<string, Exclude<FeishuFilePlan, { kind: "image" | "too_large" }>["fileType"]>> = {
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

/** 飞书消息里的图片不带文件名：按开头几个字节认出格式起个名字。 */
function imageNameOf(fileKey: string, data: Buffer): string {
  const hex = data.subarray(0, 4).toString("hex");
  const ext = hex.startsWith("89504e47") ? "png" : hex.startsWith("ffd8ff") ? "jpg" : hex.startsWith("47494638") ? "gif" : data.subarray(8, 12).toString("latin1") === "WEBP" ? "webp" : "png";
  return `飞书图片-${fileKey.slice(-8)}.${ext}`;
}

const megabytes = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

export interface FeishuFileService {
  /** 后置：按 planFeishuFile 发到 chatId 的主聊天流，返回飞书消息编号；已传过（feishu_posts 有记录）直接返回记下的编号。 */
  send(chatId: FeishuChatId, file: FeishuOutboundFile): Promise<FeishuMessageId>;
  /** 后置：下载并存成附件；超过上限或下载失败返回 null，不存半截文件。 */
  receive(messageId: FeishuMessageId, file: FeishuInboundFile): Promise<Attachment | null>;
}

export interface FeishuFileServiceDeps {
  transport: Pick<FeishuTransport, "call" | "uploadImage" | "uploadFile" | "downloadResource">;
  store: Pick<FeishuStore, "postOf" | "savePost">;
  uploadsDir: string;
  now: () => number;
}

export function createFeishuFileService(deps: FeishuFileServiceDeps): FeishuFileService {
  const { transport, store } = deps;
  const create = async (chatId: FeishuChatId, file: FeishuOutboundFile, msgType: "image" | "file" | "text", content: Record<string, string>) => {
    const result = await transport.call("message.create", {
      receive_id_type: "chat_id",
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
      uuid: `fusa-file-${file.messageId}-${file.part}`,
    });
    const id = parseFeishuMessageId(feishuStringField(feishuDataOf("message.create", result), "message_id"));
    if (id === null) throw new Error("飞书发文件消息没回消息编号");
    return id;
  };
  return {
    async send(chatId, file) {
      const ref = { kind: "file" as const, messageId: file.messageId, part: file.part };
      const existing = store.postOf(ref);
      if (existing !== null) return existing.messageId;
      const plan = planFeishuFile(file);
      let messageId: FeishuMessageId;
      if (plan.kind === "image") {
        const { imageKey } = await transport.uploadImage({ imageType: "message", path: file.path });
        messageId = await create(chatId, file, "image", { image_key: imageKey });
      } else if (plan.kind === "file") {
        const { fileKey } = await transport.uploadFile({ path: file.path, fileName: file.name, fileType: plan.fileType });
        messageId = await create(chatId, file, "file", { file_key: fileKey });
      } else {
        messageId = await create(chatId, file, "text", { text: `文件「${file.name}」有 ${megabytes(file.bytes)}，超过飞书的上限，去网页看。` });
      }
      store.savePost({ ref, chatId, messageId, cardId: null, sequence: 0, state: "final" }, deps.now());
      return messageId;
    },
    async receive(messageId, file) {
      try {
        const data = await transport.downloadResource(messageId, file.fileKey, file.type, MAX_UPLOAD_BYTES);
        if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) return null;
        const name = file.fileName ?? (file.type === "image" ? imageNameOf(file.fileKey, data) : `飞书文件-${file.fileKey.slice(-8)}`);
        return await saveUpload(deps.uploadsDir, name, data);
      } catch {
        return null;
      }
    },
  };
}
