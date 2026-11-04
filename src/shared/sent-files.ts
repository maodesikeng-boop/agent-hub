// agent 发给用户的文件（第 1 步：图片内联、文件卡片）：agent 在回复里用 Markdown 写本机路径，
// `![说明](/绝对/路径.png)` 或 `[文件名](/绝对/路径)`（路径有空格用尖括号 `[x](</a b.pdf>)`）。
// 守护进程在这条消息入库时给每个指向本机文件的链接存一份副本（daemon/sent-files.ts），消息 meta 记 files（SentFileMeta）；
// 网页按 href 把 Markdown 里的图片、链接对上 files，换成内联图片和文件卡片（web/components/Markdown.tsx）。
// 前后端都用这个文件认链接、认 meta；接口地址在 api.ts 的 API_PATHS.sentFile。
import { API_PATHS } from "./api.ts";
import { FALLBACK_MIME, isImageMime, mimeOfFileName } from "./attachments.ts";

/**
 * 一个链接的处理结果：
 * - saved：存好了副本，网页按 id 取；
 * - missing：没找到文件；not_allowed：不在可分享的文件夹里（含数据目录、.git/）；not_file：不是普通文件（文件夹之类）；
 * - too_large：单个超过 MAX_SENT_FILE_BYTES，或这条消息的合计超过 MAX_SENT_FILES_TOTAL_BYTES；unreadable：读不了（没权限、拷贝出错）。
 * 没存副本的不拷任何东西，网页的卡片显示原因（SENT_FILE_REASONS）。
 */
export const SENT_FILE_STATUSES = ["saved", "missing", "not_allowed", "not_file", "too_large", "unreadable"] as const;
export type SentFileStatus = (typeof SENT_FILE_STATUSES)[number];

/** 文件被定期清理删掉后（取文件接口 404），卡片和图片显示这个。 */
export const FILE_EXPIRED_TEXT = "文件已过期";

/** 没存副本时卡片上显示的原因。 */
export const SENT_FILE_REASONS: Readonly<Record<Exclude<SentFileStatus, "saved">, string>> = {
  missing: "没找到文件",
  not_allowed: "不在可分享的文件夹里",
  not_file: "不是文件，没存副本",
  too_large: "太大，没存副本",
  unreadable: "读不了这个文件",
};

/** 消息 meta.files 里的一项。 */
export interface SentFile {
  /** Markdown 里写的原链接地址（mdast 的 url，转义已处理、%xx 没解码），网页靠它把链接对上这一项。 */
  href: string;
  /** 解析出的原文件绝对路径（%xx 已解码、~ 已展开、相对路径已按会话的工作目录拼好；没 realpath）。 */
  path: string;
  /** 副本编号（sent-files/<编号>/ 的目录名，16 位十六进制）；没存副本是 null。 */
  id: string | null;
  /** 文件名（副本的文件名，清理过；没存副本时是原路径的最后一段）。 */
  name: string;
  /** 字节数；没找到文件、不在可分享的文件夹里是 null。 */
  size: number | null;
  mime: string;
  status: SentFileStatus;
  /** 原文件发出时的修改时间（毫秒）；没读到是 null。 */
  mtime: number | null;
}

/** agent 文字消息的 meta：回复里有指向本机文件的链接时是 { files }；没有的 meta 还是 null（老消息就是这样）。 */
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

/**
 * 发出去的文件按扩展名定类型：位图同上传（mimeOfFileName），再加上 svg（当图片显示，只用 <img> 加载，带 CSP sandbox，脚本不执行）
 * 、常见文档和音视频；别的 application/octet-stream。直接取文件时只有 image/* 内联，别的当下载（预览窗带 ?inline=1 取 pdf、html，见 daemon/ui-server/server.ts）。
 */
export function sentFileMime(name: string): string {
  const image = mimeOfFileName(name);
  if (image !== FALLBACK_MIME) return image;
  const dot = name.lastIndexOf(".");
  return SENT_FILE_MIME_BY_EXTENSION[dot === -1 ? "" : name.slice(dot + 1).toLowerCase()] ?? FALLBACK_MIME;
}

/** 网页取副本的地址。 */
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

/** 一条消息的 files。老消息（meta 是 null）、没有 files、形状不对的元素：当作没有，不抛错。 */
export function sentFilesOf(message: { meta: Record<string, unknown> | null }): SentFile[] {
  const list = message.meta?.files;
  return Array.isArray(list) ? list.filter(isSentFile) : [];
}

// ---- 认链接（守护进程和网页共用：都在 remark 解析出的 mdast 上找）----

/** mdast 节点里用得到的部分（不引 @types/mdast）。 */
export interface MdNode {
  type: string;
  url?: string;
  alt?: string | null;
  /** 引用式链接（linkReference、imageReference）和定义（definition）对上用的标识。 */
  identifier?: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** 按文档顺序找出所有图片、链接节点（代码块、行内代码里的不是节点，自然不算）。 */
export function linkNodesOf(tree: MdNode): MdNode[] {
  const out: MdNode[] = [];
  const walk = (node: MdNode) => {
    if ((node.type === "link" || node.type === "image") && typeof node.url === "string") out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/** 本机路径的写法：绝对路径、file://、~/、相对路径。 */
export type LocalHref = { kind: "absolute"; path: string } | { kind: "home"; path: string } | { kind: "relative"; path: string };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * 链接地址是不是指向本机文件，是的话 %xx 解码后给出路径。认：`/绝对路径`、`file:///绝对路径`（或 file://localhost/）、`~/`、
 * 相对路径（按会话的工作目录解析）；不认：http: 之类带协议的、`//主机/`、只有 `#锚点` 或 `?参数` 的、空的。
 * # 和 ? 不当锚点、参数切掉：文件名里本来就可能有，agent 写的是路径不是网址。
 */
export function parseLocalHref(href: string): LocalHref | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("?")) return null;
  if (/^file:/i.test(raw)) {
    const rest = raw.replace(/^file:\/\//i, "");
    if (rest === raw) return null;
    const path = rest.startsWith("/") ? rest : /^localhost\//i.test(rest) ? rest.slice("localhost".length) : null;
    return path === null ? null : { kind: "absolute", path: decodePercent(path) };
  }
  if (URL_SCHEME.test(raw) || raw.startsWith("//")) return null;
  const path = decodePercent(raw);
  if (path.includes("\u0000")) return null;
  if (path.startsWith("/")) return { kind: "absolute", path };
  if (path === "~" || path.startsWith("~/")) return { kind: "home", path: path.slice(1) };
  return { kind: "relative", path };
}

/**
 * 回复里写成本机路径的链接（候选）：按出现顺序去重（同一个地址写两次只算一个）。图片和链接一视同仁。
 * 不一定都是文件（站内链接 /login、不存在的相对路径），守护进程逐个判断（daemon/sent-files.ts），最多收 MAX_SENT_FILES_PER_MESSAGE 个。
 */
export function localLinksOf(tree: MdNode): { href: string; local: LocalHref }[] {
  const seen = new Set<string>();
  const out: { href: string; local: LocalHref }[] = [];
  for (const node of linkNodesOf(tree)) {
    const href = node.url!;
    if (seen.has(href)) continue;
    const local = parseLocalHref(href);
    if (local === null) continue;
    seen.add(href);
    out.push({ href, local });
  }
  return out;
}
