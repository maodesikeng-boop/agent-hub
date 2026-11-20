import { isImageMime } from "./attachments.ts";

export type PreviewKind = "markdown" | "code" | "csv" | "pdf" | "html" | "video" | "audio" | "image" | "other";

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

export function codeLanguageOf(name: string): string | null {
  return CODE_LANGUAGES[extensionOf(name)] ?? null;
}

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
  "webm",
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
  return name.lastIndexOf(".") > 0 && OPEN_ALLOWED_EXTENSIONS.includes(extensionOf(name));
}

export const FILE_ACTIONS = ["reveal", "open"] as const;
export type FileAction = (typeof FILE_ACTIONS)[number];

export interface FileActionResponse {
  target: "original" | "copy";
}
