import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  API_PATHS,
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  isImageMime,
  sentFileMime,
  type Attachment,
} from "../../shared/index.ts";
import { UploadError, resolveUpload, saveUpload } from "../uploads.ts";
import type { UiCtx } from "./context.ts";
import { fail } from "./http.ts";

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  // RFC 9110 says an inverted range is invalid and must be ignored.
  if (match[2] !== "" && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

/** Stored files are untrusted; the sandbox CSP prevents them from executing as pages even when opened directly. */
const STORED_FILE_CSP = "sandbox; default-src 'none'";
const SVG_MIME = "image/svg+xml";
/** SVG needs inline styles or it renders black under default-src 'none'; scripts stay blocked by sandbox and default-src. */
const SVG_CSP = `${STORED_FILE_CSP}; style-src 'unsafe-inline'`;

const wantsPreview = (req: FastifyRequest) => (req.query as { inline?: unknown }).inline === "1";
/** HTML previews run scripts in an opaque origin (no allow-same-origin), so they get no cookies and fail the Origin check. */
const HTML_PREVIEW_CSP = "sandbox allow-scripts";

function sendStoredFile(req: FastifyRequest, reply: FastifyReply, file: Pick<Attachment, "name" | "path" | "size" | "mime">) {
  req.headers["x-no-compression"] = "1";
  const preview = wantsPreview(req);
  const inline = isImageMime(file.mime) || (preview && (file.mime === "application/pdf" || file.mime === "text/html"));
  // Without an explicit charset, Chinese pages render as Latin-1 mojibake.
  const contentType = preview && file.mime === "text/html" ? `${file.mime}; charset=utf-8` : file.mime;
  const csp = file.mime === SVG_MIME ? SVG_CSP : preview && file.mime === "text/html" ? HTML_PREVIEW_CSP : STORED_FILE_CSP;
  reply
    .header("content-type", contentType)
    .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", csp)
    .header("cache-control", "private, max-age=3600")
    .header("accept-ranges", "bytes");
  const range = parseRange(req.headers.range, file.size);
  if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${file.size}`).send();
  if (range === null) return reply.header("content-length", file.size).send(createReadStream(file.path));
  return reply
    .code(206)
    .header("content-range", `bytes ${range.start}-${range.end}/${file.size}`)
    .header("content-length", range.end - range.start + 1)
    .send(createReadStream(file.path, { start: range.start, end: range.end }));
}

export function registerStoredFileRoutes(c: UiCtx): void {
  const { app } = c;
  const { uploadsDir, sentFilesDir } = c.opts;
  app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    let activeUploads = 0;
    uploads.addHook("onRequest", async (req, reply) => {
      if (req.method !== "POST") return;
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) return fail(reply, "busy", UPLOAD_BUSY_MESSAGE);
      activeUploads++;
      reply.raw.once("close", () => {
        activeUploads--;
      });
    });

    uploads.post(API_PATHS.uploads, async (req, reply) => {
      if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        reply.header("connection", "close");
        throw new UploadError(413, UPLOAD_TOO_LARGE_MESSAGE);
      }
      const { name } = req.query as { name?: unknown };
      return saveUpload(uploadsDir, typeof name === "string" ? name : "", req.body instanceof Readable ? req.body : Buffer.alloc(0));
    });

    // Wildcard because Fastify caps named params at 100 characters and long file names would 404.
    uploads.get("/api/uploads/:id/*", async (req, reply) => {
      const attachment = resolveUpload(uploadsDir, String((req.params as { id?: unknown }).id ?? ""));
      if (attachment === null) return fail(reply, "not_found");
      const mime = wantsPreview(req) ? sentFileMime(attachment.name) : attachment.mime;
      return sendStoredFile(req, reply, { ...attachment, mime });
    });
  });

  app.get("/api/sent-files/:id/*", async (req, reply) => {
    const copy = resolveUpload(sentFilesDir, String((req.params as { id?: unknown }).id ?? ""));
    if (copy === null) return fail(reply, "not_found");
    return sendStoredFile(req, reply, { ...copy, mime: sentFileMime(copy.name) });
  });
}
