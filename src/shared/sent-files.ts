import { API_PATHS } from "./api.ts";
import { FALLBACK_MIME, isImageMime, mimeOfFileName } from "./attachments.ts";

const SENT_FILE_STATUSES = ["saved", "missing", "not_allowed", "not_file", "too_large", "unreadable"] as const;
export type SentFileStatus = (typeof SENT_FILE_STATUSES)[number];

export const FILE_EXPIRED_TEXT = "文件已过期";

export const SENT_FILE_REASONS: Readonly<Record<Exclude<SentFileStatus, "saved">, string>> = {
  missing: "没找到文件",
  not_allowed: "不在可分享的文件夹里",
  not_file: "不是文件，没存副本",
  too_large: "太大，没存副本",
  unreadable: "读不了这个文件",
};

export interface SentFile {
  href: string;
  path: string;
  id: string | null;
  name: string;
  size: number | null;
  mime: string;
  status: SentFileStatus;
  mtime: number | null;
}

export type AgentTextMeta = { files: SentFile[] };

const SENT_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

export function sentFileMime(name: string): string {
  const image = mimeOfFileName(name);
  if (image !== FALLBACK_MIME) return image;
  const dot = name.lastIndexOf(".");
  return SENT_FILE_MIME_BY_EXTENSION[dot === -1 ? "" : name.slice(dot + 1).toLowerCase()] ?? FALLBACK_MIME;
}

export function sentFileUrl(file: Pick<SentFile, "id" | "name"> & { id: string }): string {
  return API_PATHS.sentFile(file.id, file.name);
}

export function isSentImage(file: Pick<SentFile, "mime">): boolean {
  return isImageMime(file.mime);
}

function isSentFile(value: unknown): value is SentFile {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.href === "string" &&
    typeof f.path === "string" &&
    (f.id === null || (typeof f.id === "string" && f.id !== "")) &&
    typeof f.name === "string" &&
    (f.size === null || typeof f.size === "number") &&
    typeof f.mime === "string" &&
    (SENT_FILE_STATUSES as readonly unknown[]).includes(f.status) &&
    (f.status === "saved") === (typeof f.id === "string")
  );
}

export function sentFilesOf(message: { meta: Record<string, unknown> | null }): SentFile[] {
  const list = message.meta?.files;
  return Array.isArray(list) ? list.filter(isSentFile) : [];
}

export interface MdNode {
  type: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

export function linkNodesOf(tree: MdNode): MdNode[] {
  const out: MdNode[] = [];
  const walk = (node: MdNode) => {
    if ((node.type === "link" || node.type === "image") && typeof node.url === "string") out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

export type LocalHref = { kind: "absolute"; path: string } | { kind: "home"; path: string } | { kind: "relative"; path: string };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WIN_DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const FILE_URL_WIN_DRIVE = /^\/([A-Za-z]:[\\/][\s\S]*)$/;

function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function parseLocalHref(href: string): LocalHref | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("?")) return null;
  if (/^file:/i.test(raw)) {
    const rest = raw.replace(/^file:\/\//i, "");
    if (rest === raw) return null;
    const afterLocalhost = /^localhost(?:\/|(?=[A-Za-z]:[\\/]))/i.test(rest) ? rest.slice("localhost".length) : null;
    const candidate = rest.startsWith("/") || WIN_DRIVE_ABS.test(rest) ? rest : afterLocalhost;
    const path = candidate && (candidate.startsWith("/") || WIN_DRIVE_ABS.test(candidate)) ? candidate : null;
    if (path === null) return null;
    const decoded = decodePercent(path);
    const winDrive = FILE_URL_WIN_DRIVE.exec(decoded);
    return { kind: "absolute", path: winDrive ? winDrive[1]! : decoded };
  }
  const decodedRaw = decodePercent(raw);
  if (decodedRaw.includes("\u0000")) return null;
  if (WIN_DRIVE_ABS.test(decodedRaw)) {
    return { kind: "absolute", path: decodedRaw };
  }
  if (URL_SCHEME.test(raw) || raw.startsWith("//")) return null;
  if (raw.startsWith("\\\\")) {
    return { kind: "absolute", path: decodedRaw };
  }
  const path = decodedRaw;
  if (path.startsWith("/")) return { kind: "absolute", path };
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    return { kind: "home", path: path.slice(1).replace(/\\/g, "/") };
  }
  return { kind: "relative", path };
}

const LOCATION_SUFFIX = /(?:#L?\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/;

export function locationFallbackPaths(href: string, path: string): string[] {
  const out: string[] = [];
  const add = (candidate: string) => {
    if (candidate !== "" && candidate !== path && !out.includes(candidate)) out.push(candidate);
  };
  add(path.replace(LOCATION_SUFFIX, ""));
  if (/^file:/i.test(href.trim())) {
    const hash = href.trim().indexOf("#");
    if (hash >= 0) {
      const local = parseLocalHref(href.trim().slice(0, hash));
      if (local !== null) add(local.path);
    }
  }
  return out;
}

function extractRawWindowsLinkTarget(node: MdNode, rawMarkdown: string | undefined): string | null {
  if (!rawMarkdown) return null;
  const pos = (node as { position?: { start?: { offset?: number }; end?: { offset?: number } } }).position;
  const start = pos?.start?.offset;
  const end = pos?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end > rawMarkdown.length || start >= end) {
    return null;
  }
  const slice = rawMarkdown.slice(start, end);
  const closeBracketParen = slice.indexOf("](");
  if (closeBracketParen >= 0 && slice.endsWith(")")) {
    let inner = slice.slice(closeBracketParen + 2, -1).trim();
    if (inner.startsWith("<") && inner.endsWith(">")) {
      inner = inner.slice(1, -1);
    }
    if (/^(?:[A-Za-z]:\\|\\\\|~\\|file:\/\/(?:localhost\/?)?[A-Za-z]:\\)/i.test(inner)) {
      return inner;
    }
  }
  if (slice.startsWith("<") && slice.endsWith(">")) {
    const inner = slice.slice(1, -1);
    if (/^(?:[A-Za-z]:\\|\\\\|file:\/\/(?:localhost\/?)?[A-Za-z]:\\)/i.test(inner)) {
      return inner;
    }
  }
  return null;
}

export function localLinksOf(tree: MdNode, rawMarkdown?: string): { href: string; local: LocalHref }[] {
  const seen = new Set<string>();
  const out: { href: string; local: LocalHref }[] = [];
  for (const node of linkNodesOf(tree)) {
    const href = node.url!;
    if (seen.has(href)) continue;
    const rawWinTarget = extractRawWindowsLinkTarget(node, rawMarkdown);
    const local = parseLocalHref(rawWinTarget ?? href);
    if (local === null) continue;
    seen.add(href);
    out.push({ href, local });
  }
  return out;
}
