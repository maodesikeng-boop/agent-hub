// 预览窗按文件类型选渲染方式（web/components/FilePreview.tsx），以及哪些文件不能“用默认程序打开”（daemon/open-file.ts 也查）。
import { isImageMime } from "./attachments.ts";

export type PreviewKind = "markdown" | "code" | "csv" | "pdf" | "html" | "video" | "audio" | "image" | "other";

/**
 * 扩展名（小写）→ Shiki 的语言名。text 是纯文本（不上色，只有行号）。
 * 只列常见的；不在表里、mime 也不是 text/* 的文件不当文本预览。
 */
const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  txt: "text",
  text: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "jsonc",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  css: "css",
  scss: "scss",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  diff: "diff",
  patch: "diff",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 文本类文件的 Shiki 语言名；不是文本类是 null。 */
export function codeLanguageOf(name: string): string | null {
  return CODE_LANGUAGES[extensionOf(name)] ?? null;
}

/** 按 mime 选，mime 认不出的（application/octet-stream）再看扩展名是不是文本类。 */
export function previewKindOf(name: string, mime: string): PreviewKind {
  if (isImageMime(mime)) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || codeLanguageOf(name) !== null) return "code";
  return "other";
}

/**
 * 能“用默认程序打开”的扩展名（小写，白名单）：只有文档、图片、音视频、纯文本这类打开只会看、不会执行的。
 * 不在表里的（含没有扩展名的）只能“在 Finder 中显示”：.terminal、.tool、.command、.workflow、.action、.fileloc、.pkg、.mpkg、
 * .app、.prefPane、.scpt、.jar、.sh/.zsh/.bash、.py 之类一双击就可能执行，黑名单列不全，所以反过来写。
 * html、htm 用默认浏览器打开（浏览器里的脚本在沙箱内）；svg 不放（可能带脚本）。带可执行权限的文件另由守护进程按权限位拦。
 */
const OPEN_ALLOWED_EXTENSIONS: readonly string[] = [
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "log",
  "pdf",
  "rtf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "bmp",
  "tif",
  "tiff",
  "mp4",
  "m4v",
  "mov",
  "m4a",
  "mp3",
  "wav",
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "pages",
  "numbers",
  "key",
  "html",
  "htm",
];

export function canOpenWithDefault(name: string): boolean {
  // 点开头的名字（.pdf 是隐藏文件，不是 pdf）不算有扩展名
  return name.lastIndexOf(".") > 0 && OPEN_ALLOWED_EXTENSIONS.includes(extensionOf(name));
}

/** 在 Finder 中显示 / 用默认程序打开。 */
export const FILE_ACTIONS = ["reveal", "open"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

/** 打开接口的返回：用的是原文件还是守护进程存的副本（原文件没了、不在允许的文件夹里时用副本）。 */
export interface FileActionResponse {
  target: "original" | "copy";
}
