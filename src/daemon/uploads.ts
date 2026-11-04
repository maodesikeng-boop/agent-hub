// 聊天框上传的文件怎么存（设计：用户在聊天框发文件给 agent）。
// 一个文件一个目录：<uploadsDir>/<上传编号>/<清理过的原文件名>。编号随机，所以同名文件不会互相覆盖，
// agent 拿到的路径末尾还是用户的原文件名；文件名只留最后一段、去掉控制字符，所以怎么写都出不了这个目录。
// 上传接口不绑定接收方：谁来用（项目经理、以后的 Worker 输入框）都是先上传拿到 Attachment，再在发消息时带上编号。
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_EXTENSION_BYTES,
  MAX_UPLOAD_NAME_BYTES,
  UPLOAD_EMPTY_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  mimeOfFileName,
  utf8Bytes,
  type Attachment,
} from "../shared/index.ts";

/** 上传失败，message 是给用户看的中文原因（界面服务原样返回）。 */
export class UploadError extends Error {
  readonly statusCode: 400 | 413;
  constructor(statusCode: 400 | 413, message: string) {
    super(message);
    this.name = "UploadError";
    this.statusCode = statusCode;
  }
}

/** 文件名清理后什么都不剩时用的名字。 */
const DEFAULT_FILE_NAME = "文件";
/**
 * 要去掉的字符：控制字符 Cc（换行、NUL…）、不可见的格式字符 Cf（方向控制符能把 .txt 伪装成别的扩展名，零宽字符、BOM 能藏字）、
 * 行分隔符 Zl、段分隔符 Zp（U+2028/2029，能让文件名在清单里换行）。代价：emoji 组合用的零宽连接符也被去掉，组合 emoji 会拆开，无妨。
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** 上传编号：16 位小写十六进制。找文件时只认这个形状，别的一律当没有（不会拼出 uploads/ 之外的路径）。 */
const UPLOAD_ID = /^[0-9a-f]{16}$/;

/** 按 UTF-8 字节截断，不切坏一个字（码点）。 */
function truncateBytes(text: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const n = utf8Bytes(char);
    if (used + n > maxBytes) break;
    out += char;
    used += n;
  }
  return out;
}

/** 只留最后一段、去控制字符、统一成 NFC、限长（扩展名尽量留着）；什么都不剩用默认名。 */
export function sanitizeFileName(raw: string): string {
  const last = raw.split(/[\\/]/).at(-1) ?? "";
  let name = last.replace(UNSAFE_CHARS, "").normalize("NFC").trim();
  if (name === "" || name === "." || name === "..") return DEFAULT_FILE_NAME;
  if (utf8Bytes(name) > MAX_UPLOAD_NAME_BYTES) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && utf8Bytes(name.slice(dot)) <= MAX_UPLOAD_EXTENSION_BYTES ? name.slice(dot) : "";
    name = truncateBytes(name.slice(0, extension === "" ? name.length : dot), MAX_UPLOAD_NAME_BYTES - utf8Bytes(extension)) + extension;
  }
  return name;
}

function toAttachment(uploadsDir: string, id: string, name: string, size: number): Attachment {
  return { id, name, path: join(uploadsDir, id, name), size, mime: mimeOfFileName(name) };
}

/** 存一个文件，返回它的附件信息。空文件、超过 MAX_UPLOAD_BYTES 抛 UploadError（磁盘上不留东西）。 */
export async function saveUpload(uploadsDir: string, rawName: string, data: Buffer): Promise<Attachment> {
  if (data.length === 0) throw new UploadError(400, UPLOAD_EMPTY_MESSAGE);
  if (data.length > MAX_UPLOAD_BYTES) throw new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE);
  const name = sanitizeFileName(rawName);
  const id = randomBytes(8).toString("hex");
  const dir = join(uploadsDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(dir, name), data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return toAttachment(uploadsDir, id, name, data.length);
}

/**
 * 按上传编号找文件：从磁盘重新算名字、路径、大小、类型，不信任何客户端报的。编号不合法、目录或文件没了：null。
 * 用 lstat：uploads/<编号> 和里面的文件都必须是真目录、真文件，符号链接一律当没有（免得被指到 uploads/ 外面）。
 */
export function resolveUpload(uploadsDir: string, id: string): Attachment | null {
  if (!UPLOAD_ID.test(id)) return null;
  try {
    const dir = join(uploadsDir, id);
    if (!lstatSync(dir).isDirectory()) return null;
    const names = readdirSync(dir);
    const name = names.length === 1 ? names[0]! : undefined;
    if (name === undefined) return null;
    const stat = lstatSync(join(dir, name));
    return stat.isFile() ? toAttachment(uploadsDir, id, name, stat.size) : null;
  } catch {
    return null;
  }
}
