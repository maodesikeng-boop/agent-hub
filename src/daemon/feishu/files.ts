// 文件进出（docs/feishu-design.md「交付与附件」）：项目经理发的文件、卡片的交付物传成群里的原生图片和文件消息；
// 主人（或本档允许的访客）在飞书里发的图片、文件下载存成附件，随消息交给项目经理。
// 不变量：
// - 图片 ≤ 10 MB 走上传图片发成图片消息；其他文件 ≤ 30 MB 走上传文件发成文件消息；超过的不传，发一行“文件太大，去网页看”；
// - 同一个账本文件（feishu_posts 的 file ref）只传一次；
// - 下载最多 MAX_UPLOAD_BYTES（和网页上传同一个上限），超了不存、回一句提示；存法和网页上传一样走 saveUpload。
import type { MessageId } from "../../shared/domain.ts";
import type { Attachment } from "../../shared/attachments.ts";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import type { FeishuInboundFile } from "./inbound.ts";
import type { FeishuStore } from "./store.ts";
import type { FeishuTransport } from "./transport.ts";

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
  throw new Error("未实现");
}

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
  throw new Error("未实现");
}
