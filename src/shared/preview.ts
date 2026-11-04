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

/** 双击会运行程序、装东西的类型：只允许在 Finder 中显示，不允许用默认程序打开。（带可执行权限的文件由守护进程按权限位再拦。） */
export const OPEN_BLOCKED_EXTENSIONS: readonly string[] = ["app", "command", "sh", "pkg", "scpt", "jar"];

export function canOpenWithDefault(name: string): boolean {
  return !OPEN_BLOCKED_EXTENSIONS.includes(extensionOf(name));
}

/** 在 Finder 中显示 / 用默认程序打开。 */
export const FILE_ACTIONS = ["reveal", "open"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

/** 打开接口的返回：用的是原文件还是守护进程存的副本（原文件没了、不在允许的文件夹里时用副本）。 */
export interface FileActionResponse {
  target: "original" | "copy";
}
