import { randomBytes } from "node:crypto";
import { createWriteStream, lstatSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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

export class UploadError extends Error {
  readonly statusCode: 400 | 413;
  constructor(statusCode: 400 | 413, message: string) {
    super(message);
    this.name = "UploadError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_FILE_NAME = "文件";
/** Strip Cc and Cf characters because bidi controls can disguise an extension and zero-width characters can spoof names. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export const UPLOAD_ID = /^[0-9a-f]{16}$/;

/** Truncate by UTF-8 bytes without splitting a code point. */
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

export async function saveUpload(uploadsDir: string, rawName: string, data: Buffer | Readable): Promise<Attachment> {
  if (Buffer.isBuffer(data) && data.length > MAX_UPLOAD_BYTES) throw new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE);
  const source = Buffer.isBuffer(data) ? Readable.from([data]) : data;
  // The connection may drop while mkdir runs; catch it here so the process does not crash and pipeline still sees the error.
  const ignore = () => {};
  source.once("error", ignore);
  const name = sanitizeFileName(rawName);
  const id = randomBytes(8).toString("hex");
  const dir = join(uploadsDir, id);
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > MAX_UPLOAD_BYTES ? new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE) : null, chunk);
    },
  });
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await pipeline(source, limit, createWriteStream(join(dir, name), { flags: "wx", mode: 0o600 }));
    if (size === 0) throw new UploadError(400, UPLOAD_EMPTY_MESSAGE);
  } catch (error) {
    source.destroy();
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    source.off("error", ignore);
  }
  return toAttachment(uploadsDir, id, name, size);
}

/** Rebuild metadata from disk and use lstat; nothing reported by the client is trusted. */
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
