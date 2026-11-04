import { Check, Copy, Download, ExternalLink, FileText, FolderSearch, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FALLBACK_MIME,
  MAX_PREVIEW_CSV_ROWS,
  MAX_PREVIEW_TEXT_BYTES,
  canOpenWithDefault,
  codeLanguageOf,
  previewKindOf,
  sentFileMime,
  type FileAction,
} from "../../shared/index.ts";
import { ApiError, fetchFileBytes, postFileAction, type FileActionTarget } from "../client.ts";
import { parseCsv } from "../csv.ts";
import { highlightHtml } from "../highlight.ts";
import { formatBytes } from "../upload.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Markdown } from "./Markdown.tsx";

/** 预览窗要的一个文件。url 是取文件的接口地址（文件卡片、下载用同一个）；target 是“在 Finder 中显示 / 默认程序打开”的对象，没有就不显示这两个按钮。 */
export interface PreviewFile {
  name: string;
  mime: string;
  size: number | null;
  url: string;
  target: FileActionTarget | null;
}

/** 放进 iframe、播放器、<img> 的地址：?inline=1 让服务端把 pdf、html 内联发（daemon/ui-server/server.ts）。 */
const inlineUrl = (url: string) => `${url}?inline=1`;

const OPEN_BLOCKED_TITLE = "这种文件打开可能会直接运行，只能在 Finder 中显示";
const COPY_NOTICE = "原文件已经不在了，显示的是发出时存的副本";
const MB = 1024 * 1024;

type TextState = { status: "loading" } | { status: "error" } | { status: "ready"; text: string; truncated: boolean };

/** 读文件内容当文本：maxBytes 不是 null 就只取前这么多字节。 */
function useFileText(url: string, enabled: boolean, maxBytes: number | null, size: number | null): TextState {
  const [state, setState] = useState<TextState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchFileBytes(url, maxBytes).then(
      (bytes) => {
        if (!alive) return;
        const truncated = maxBytes !== null && (size === null ? bytes.byteLength >= maxBytes : size > maxBytes);
        setState({ status: "ready", text: new TextDecoder().decode(bytes), truncated });
      },
      () => alive && setState({ status: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [url, enabled, maxBytes, size]);
  return state;
}

/** 代码：先显示纯文本（行号靠 CSS 计数），Shiki 加载好再换成上色的；纯文本和 Shiki 不认识的语言一直是纯文本。 */
function CodeView({ text, language }: { text: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    setHtml(null);
    if (language === "text") return;
    let alive = true;
    // 末尾的换行不算一行：Shiki 会给它多出一个空行
    highlightHtml(text.endsWith("\n") ? text.slice(0, -1) : text, language).then(
      (result) => alive && setHtml(result),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [text, language]);
  const lines = useMemo(() => {
    const all = text.split("\n");
    return all.length > 1 && all.at(-1) === "" ? all.slice(0, -1) : all;
  }, [text]);
  if (html !== null) return <div data-preview-code className="code-view" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre data-preview-code className="code-view">
      <code>
        {lines.map((line, i) => (
          <span key={i} className="line">
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** 表格：整个容器滚动（横竖都能），表头 sticky 固定在顶上。 */
function CsvView({ rows }: { rows: string[][] }) {
  const [head = [], ...body] = rows;
  return (
    <div data-preview-table className="h-full overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-left text-[13.5px]">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="sticky top-0 border-b border-border bg-sidebar px-3 py-2 font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border-b border-border px-3 py-1.5 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-muted-foreground">{children}</div>;
}

const rowsLabel = (total: number, shown: number) => (total > shown ? `共 ${total} 行，只显示前 ${shown} 行` : `共 ${total} 行`);

/** 内容区和工具栏上跟类型有关的部分（源码切换、复制、截断说明）。 */
function usePreviewBody(file: PreviewFile, kind: ReturnType<typeof previewKindOf>) {
  const isText = kind === "markdown" || kind === "code";
  const isCsv = kind === "csv";
  const textLimit = file.size !== null && file.size <= MAX_PREVIEW_TEXT_BYTES ? null : MAX_PREVIEW_TEXT_BYTES;
  const textState = useFileText(file.url, isText, textLimit, file.size);
  const csvState = useFileText(file.url, isCsv, null, file.size);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const csv = useMemo(
    () => (csvState.status === "ready" ? parseCsv(csvState.text, file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",", MAX_PREVIEW_CSV_ROWS) : null),
    [csvState, file.name],
  );
  const state = isCsv ? csvState : textState;
  const pending = (isText || isCsv) && state.status === "loading";
  const failed = (isText || isCsv) && state.status === "error";

  let controls: React.ReactNode = null;
  let note: string | null = null;
  let body: React.ReactNode = null;
  if (isText && textState.status === "ready") {
    const { text, truncated } = textState;
    const showCode = kind === "code" || source;
    if (truncated) note = `文件较大，只显示前 ${MAX_PREVIEW_TEXT_BYTES / MB} MB`;
    controls = (
      <>
        {kind === "markdown" && (
          <Button variant="outline" size="sm" onClick={() => setSource((v) => !v)}>
            {source ? "渲染" : "源码"}
          </Button>
        )}
        {showCode && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true));
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "已复制" : "复制"}
          </Button>
        )}
      </>
    );
    body = showCode ? (
      <CodeView text={text} language={kind === "markdown" ? "markdown" : (codeLanguageOf(file.name) ?? "text")} />
    ) : (
      <div data-preview-markdown className="mx-auto max-w-[72ch] px-6 py-5">
        <Markdown text={text} />
      </div>
    );
  } else if (isCsv && csv !== null) {
    note = rowsLabel(csv.total, MAX_PREVIEW_CSV_ROWS);
    body = <CsvView rows={csv.rows} />;
  }
  return { pending, failed, controls, note, body };
}

function OtherInfo({ file }: { file: PreviewFile }) {
  return (
    <Centered>
      <div className="flex flex-col items-center gap-2">
        <FileText className="size-10" aria-hidden="true" />
        <span className="text-[15px] font-medium text-foreground">{file.name}</span>
        {file.size !== null && <span className="text-[13.5px]">{formatBytes(file.size)}</span>}
      </div>
    </Centered>
  );
}

/**
 * 文件预览窗（接近全屏）：按类型显示，上面是三个按钮——下载、在 Finder 中显示、用默认程序打开。
 * 内容在窗打开之后才去取（Radix 关着的时候不挂载内容）；Shiki 要上色时才加载。
 */
export function FilePreview({ file, open, onOpenChange }: { file: PreviewFile; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={file.name} className="h-[90vh] w-[90vw] max-w-none gap-3 overflow-hidden">
        <PreviewContent file={file} />
      </DialogContent>
    </Dialog>
  );
}

function PreviewContent({ file }: { file: PreviewFile }) {
  const mime = file.mime === FALLBACK_MIME ? sentFileMime(file.name) : file.mime;
  const kind = previewKindOf(file.name, mime);
  const { pending, failed, controls, note, body } = usePreviewBody(file, kind);
  const [busy, setBusy] = useState<FileAction | null>(null);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const openAllowed = canOpenWithDefault(file.name);

  const run = async (action: FileAction) => {
    if (file.target === null) return;
    setBusy(action);
    setResult(null);
    try {
      const response = await postFileAction(file.target, action);
      if (response.target === "copy" && file.target.kind === "sent") setResult({ text: COPY_NOTICE, error: false });
    } catch (error) {
      setResult({ text: error instanceof ApiError ? error.message : "没能打开这个文件", error: true });
    } finally {
      setBusy(null);
    }
  };

  const src = inlineUrl(file.url);
  let content: React.ReactNode = body;
  if (pending) {
    content = (
      <Centered>
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span className="ml-2 text-[13.5px]">加载中</span>
      </Centered>
    );
  } else if (failed) {
    content = (
      <Centered>
        <span className="text-[13.5px] text-danger">读不了这个文件</span>
      </Centered>
    );
  } else if (kind === "pdf") {
    // 不加 sandbox 属性：Chrome 在带 sandbox 的 iframe 里不渲染 PDF 查看器（响应头上的 CSP 沙箱不受影响，实测能渲染）
    content = <iframe title={file.name} src={src} className="size-full border-0" />;
  } else if (kind === "html") {
    // 只给 allow-scripts，不给 allow-same-origin：页面拿不到界面的 cookie，也发不了带登录的请求
    content = <iframe title={file.name} src={src} sandbox="allow-scripts" className="size-full border-0 bg-white" />;
  } else if (kind === "video") {
    content = <video src={src} controls className="size-full bg-black object-contain" />;
  } else if (kind === "audio") {
    content = (
      <Centered>
        <audio src={src} controls className="w-full max-w-[560px]" />
      </Centered>
    );
  } else if (kind === "image") {
    content = (
      <div className="flex size-full items-center justify-center bg-muted p-4">
        <img src={src} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (kind === "other") {
    content = <OtherInfo file={file} />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={file.url} download={file.name}>
            <Download />
            下载
          </a>
        </Button>
        {file.target !== null && (
          <>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void run("reveal")}>
              <FolderSearch />
              在 Finder 中显示
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !openAllowed}
              title={openAllowed ? undefined : OPEN_BLOCKED_TITLE}
              onClick={() => void run("open")}
            >
              <ExternalLink />
              用默认程序打开
            </Button>
          </>
        )}
        {controls}
        <span role="status" className="ml-auto text-[13.5px] text-muted-foreground">
          {result !== null ? <span className={result.error ? "text-danger" : undefined}>{result.text}</span> : note}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">{content}</div>
    </>
  );
}
