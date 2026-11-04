// 聊天框上传的文件（附件）：存在数据目录的 uploads/（paths.ts 的 uploadsDir），消息的 meta 里记着它们，
// 发给 agent 的正文里带上每个文件的完整绝对路径，agent 用自己的读文件工具去读（不做图片内容块）。
// 前后端都用这一个文件认附件、拼正文；接口地址在 api.ts 的 API_PATHS.uploads / upload。
import { API_PATHS } from "./api.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "./limits.ts";

/** 一个上传好的文件。服务端从磁盘上的文件重新算出来，不信客户端报的（见 daemon/uploads.ts 的 resolveUpload）。 */
export interface Attachment {
  /** 上传编号，也是 uploads/ 下放这个文件的目录名。 */
  id: string;
  /** 用户看到的文件名（已经去掉路径、控制字符）。 */
  name: string;
  /** 文件的完整绝对路径：uploads/<编号>/<文件名>。 */
  path: string;
  size: number;
  mime: string;
}

/** 用户消息的 meta：有附件时是 { attachments }；没有附件的用户消息 meta 还是 null（老消息就是这样）。 */
export interface UserMessageMeta {
  attachments: Attachment[];
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

/** 按扩展名定类型：认得的位图是 image/*，别的一律 application/octet-stream（svg 能带脚本，不当图片内联显示）。 */
export function mimeOfFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? FALLBACK_MIME;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** 网页显示缩略图、下载用的地址（界面服务按编号找文件，文件名只是给浏览器看的）。 */
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

/** 一条消息带的附件。没有附件字段的老消息、meta 是 null、形状不对的元素：当作没有（跳过），不抛错。 */
export function attachmentsOf(message: { meta: Record<string, unknown> | null }): Attachment[] {
  const list = message.meta?.attachments;
  return Array.isArray(list) ? list.filter(isAttachment) : [];
}

/** 加在正文后面的说明。 */
export const ATTACHMENTS_HEADING = "用户随消息附了下面的文件，完整路径如下，用读文件的工具按路径读取：";

/** 路径括在反引号里，划清边界；路径里自己有反引号时，外面的比里面最长的一串多一个（和 Markdown 行内代码一样）。 */
function quotePath(path: string): string {
  const longestRun = Math.max(0, ...(path.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${path}${fence}`;
}

/**
 * 真正发给 agent 的正文：用户写的字 + 附件的完整绝对路径清单（每个路径用反引号括起来）。消息里存的 text 还是用户写的原文（界面显示它），
 * 发送（含重试、重启恢复重发）时才拼，所以改这里的说法不用动存下来的消息。
 */
export function agentTextOf(message: { text: string; meta: Record<string, unknown> | null }): string {
  const attachments = attachmentsOf(message);
  if (attachments.length === 0) return message.text;
  const list = [ATTACHMENTS_HEADING, ...attachments.map((a) => `- ${quotePath(a.path)}`)].join("\n");
  return message.text.trim() === "" ? list : `${message.text}\n\n${list}`;
}

// ---- 上传被拒时给用户看的中文原因（服务端和网页预检共用一份）----

export const UPLOAD_TOO_LARGE_MESSAGE = `文件太大，单个文件最多 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
export const UPLOAD_EMPTY_MESSAGE = "文件是空的，没有内容可发";
export const UPLOAD_BUSY_MESSAGE = "同时上传的文件太多了，稍等一下再试";
/** 一条消息的文件个数超了（服务端直接用；网页加文件时后面再接“多出来的没有加入”）。个数上限只在这里写一处。 */
export const ATTACHMENTS_TOO_MANY_MESSAGE = `一条消息最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件`;
/** 发消息时带的上传编号找不到文件了（被清理、没传过）：服务端回 400 用它，网页认出它就不显示“重试”。 */
export const ATTACHMENTS_MISSING_MESSAGE = "有文件找不到了（可能已被清理），请重新添加";
