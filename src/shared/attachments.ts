import type { MessageId } from "./domain.ts";
import { API_PATHS } from "./api.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "./limits.ts";
import type { FeishuMessageOrigin } from "./feishu.ts";
import type { WorkerPick } from "./worker.ts";

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  mime: string;
}

export interface UserMessageMeta {
  replyId?: MessageId;
  attachments?: Attachment[];
  workerPick?: WorkerPick;
  deliveryConfirmed?: true;
  rewound?: true;
  origin?: FeishuMessageOrigin;
}

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};
export const FALLBACK_MIME = "application/octet-stream";

export function mimeOfFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? FALLBACK_MIME;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function uploadUrl(attachment: Pick<Attachment, "id" | "name">): string {
  return API_PATHS.upload(attachment.id, attachment.name);
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    a.id !== "" &&
    typeof a.name === "string" &&
    a.name !== "" &&
    typeof a.path === "string" &&
    a.path !== "" &&
    typeof a.size === "number" &&
    typeof a.mime === "string"
  );
}

export function attachmentsOf(message: { meta: Record<string, unknown> | null }): Attachment[] {
  const list = message.meta?.attachments;
  return Array.isArray(list) ? list.filter(isAttachment) : [];
}

const ATTACHMENTS_HEADING = "用户随消息附了下面的文件，完整路径如下，用读文件的工具按路径读取：";

function quotePath(path: string): string {
  const longestRun = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${path}${fence}`;
}

export function agentTextOf(message: { text: string; meta: Record<string, unknown> | null }): string {
  const attachments = attachmentsOf(message);
  if (attachments.length === 0) return message.text;
  const list = [ATTACHMENTS_HEADING, ...attachments.map((a) => `- ${quotePath(a.path)}`)].join("\n");
  return message.text.trim() === "" ? list : `${message.text}\n\n${list}`;
}

export const UPLOAD_TOO_LARGE_MESSAGE = `文件太大，单个文件最多 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
export const UPLOAD_EMPTY_MESSAGE = "文件是空的，没有内容可发";
export const UPLOAD_BUSY_MESSAGE = "同时上传的文件太多了，稍等一下再试";
export const ATTACHMENTS_TOO_MANY_MESSAGE = `一条消息最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件`;
export const ATTACHMENTS_MISSING_MESSAGE = "有文件找不到了（可能已被清理），请重新添加";
