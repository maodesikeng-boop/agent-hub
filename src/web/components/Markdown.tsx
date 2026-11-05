import { Check, Copy } from "lucide-react";
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  SENT_FILE_REASONS,
  isSentImage,
  linkNodesOf,
  parseLocalHref,
  FILE_EXPIRED_TEXT,
  sentFileUrl,
  type MdNode,
  type SentFile,
} from "../../shared/index.ts";
import { highlightHtml } from "../highlight.ts";
import { formatBytes } from "../upload.ts";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";

/** 对上 meta.files 的图片、链接，在 hast 上带这个属性（值是 files 里的下标），渲染时换成内联图片或文件卡片。 */
const SENT_FILE_ATTR = "data-sent-file";

/**
 * 引用式链接（`![a][r]`、`[a][r]` + `[r]: 地址`）指向本机路径的：守护进程不处理它们，这里一律换成文字（图片换成说明文字，
 * 链接只留链接文字），不让浏览器拿本机路径去请求。指向网址的照常。
 */
function flattenLocalReferences(tree: MdNode): void {
  const definitions = new Map<string, string>();
  const collect = (node: MdNode) => {
    if (node.type === "definition" && node.identifier !== undefined && typeof node.url === "string") definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  };
  collect(tree);
  const isLocal = (node: MdNode) => {
    const url = node.identifier === undefined ? undefined : definitions.get(node.identifier);
    return url !== undefined && parseLocalHref(url) !== null;
  };
  const flatten = (node: MdNode) => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type === "imageReference" && isLocal(child)) return [{ type: "text", value: child.alt ?? "" }];
      if (child.type === "linkReference" && isLocal(child)) {
        flatten(child);
        return child.children ?? [];
      }
      flatten(child);
      return [child];
    });
  };
  flatten(tree);
}

/**
 * remark 插件：按 href 把 Markdown 里的图片、链接对上这条消息的 meta.files（shared/sent-files.ts）。
 * 对上的：存了副本的地址换成取副本的接口，记下是第几个文件；没存下来的地址清空（不发请求）。
 * 没对上的本机图片（老消息、没有 meta.files、超过个数的）：换成说明文字，不让浏览器拿本机路径去请求。
 */
function remarkSentFiles(files: SentFile[]) {
  const index = new Map(files.map((file, i) => [file.href, i]));
  return () => (tree: MdNode) => {
    flattenLocalReferences(tree);
    for (const node of linkNodesOf(tree)) {
      const i = index.get(node.url!);
      const file = i === undefined ? undefined : files[i]!;
      if (file !== undefined) {
        node.url = file.id === null ? "" : sentFileUrl({ id: file.id, name: file.name });
        node.data = { ...node.data, hProperties: { [SENT_FILE_ATTR]: String(i) } };
      } else if (node.type === "image" && parseLocalHref(node.url!) !== null) {
        Object.assign(node, { type: "text", value: node.alt ?? "" });
      }
    }
  };
}

/** 这条消息的 meta.files 和消息编号（预览窗的“在 Finder 中显示”按它找文件）：模块级的 a、img 组件从这里取（组件引用不变，重渲染时内联图、卡片不卸载重建）。 */
const SentFilesContext = createContext<{ files: SentFile[]; messageId: number | undefined }>({ files: [], messageId: undefined });

function useSentFile(props: object): { file: SentFile; index: number; messageId: number | undefined } | undefined {
  const { files, messageId } = useContext(SentFilesContext);
  const raw = (props as Record<string, unknown>)[SENT_FILE_ATTR];
  const index = typeof raw === "string" ? Number(raw) : -1;
  const file = files[index];
  return file === undefined ? undefined : { file, index, messageId };
}

/** 点开预览窗要的信息；没有消息编号（不是从消息里渲染的）就没有 Finder / 默认程序按钮。 */
function previewOf(file: SentFile, url: string, index: number, messageId: number | undefined): PreviewFile {
  return { name: file.name, mime: file.mime, size: file.size, url, target: messageId === undefined ? null : { kind: "sent", messageId, index } };
}

/** 内联图片，点开预览窗。固定 240px 高、最宽 320px，加载前后高度不变（消息流不跳，docs/ui-standard.md 第 15、17 条）；文件被清理掉了（取文件 404，<img> 报错）就换成“文件已过期”的卡片，不留破图、点不开。 */
function InlineSentImage({ alt, file, preview }: { alt: string; file: SentFile; preview: PreviewFile }) {
  const [open, setOpen] = useState(false);
  const [expired, markExpired] = useFileExpired(preview.url, false);
  if (expired) return <FileCard name={file.name} mime={file.mime} detail={FILE_EXPIRED_TEXT} className="my-1.5 w-fit max-w-full" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-sent-image className="my-2 block w-fit max-w-full cursor-zoom-in">
        <img src={preview.url} alt={alt} loading="lazy" onError={markExpired} className="block h-60 w-auto max-w-xs rounded-xl object-contain object-left" />
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * agent 发来的一个文件。图片语法 `![]()`（inline）写的、存了副本的图片：内联（固定 240px 高、最宽 320px，加载前后高度不变，点开看大图）；
 * 别的都是卡片：普通链接写的图片带缩略图，点了看大图；其他文件点了看预览；没存下来的写原因。大图和预览是同一个预览窗。
 */
function SentFileView({ sent, inline, alt }: { sent: NonNullable<ReturnType<typeof useSentFile>>; inline: boolean; alt?: string }) {
  const { file, index, messageId } = sent;
  if (file.status === "saved" && file.id !== null) {
    const url = sentFileUrl({ id: file.id, name: file.name });
    const preview = previewOf(file, url, index, messageId);
    if (inline && isSentImage(file)) return <InlineSentImage alt={alt || file.name} file={file} preview={preview} />;
    return <FileCard name={file.name} mime={file.mime} detail={file.size === null ? "" : formatBytes(file.size)} preview={preview} className="my-1.5 w-fit max-w-full" />;
  }
  return <FileCard name={file.name} mime={file.mime} detail={SENT_FILE_REASONS[file.status as Exclude<SentFile["status"], "saved">]} className="my-1.5 w-fit max-w-full" />;
}

function withoutNode<T extends object>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props as T & { node?: unknown };
  return rest;
}

/** 链接一律在新窗口打开；noopener noreferrer 防止新页面拿到当前页面的 window。对上 meta.files 的换成文件卡片。 */
function Link(props: ComponentProps<"a">) {
  const sent = useSentFile(props);
  if (sent !== undefined) return <SentFileView sent={sent} inline={false} />;
  return <a {...withoutNode(props)} target="_blank" rel="noopener noreferrer" />;
}

function Image(props: ComponentProps<"img">) {
  const sent = useSentFile(props);
  if (sent !== undefined) return <SentFileView sent={sent} inline alt={props.alt} />;
  return <img {...withoutNode(props)} />;
}

/** 不上色的语言写法：和没写语言一样，直接纯文本。 */
const PLAIN_LANGUAGES = new Set(["text", "txt", "plain", "plaintext"]);
/** 流式输出时，内容停多久才重新上色（毫秒）。 */
const HIGHLIGHT_DEBOUNCE_MS = 120;
const COPIED_RESET_MS = 1500;

/** 代码块的语言：fence 上写的第一个词（remark 给 <code> 的 class 是 language-xxx）。 */
function languageOf(className: string | undefined): string {
  return /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? "";
}

/** 把 <code> 里的文字拼回原文；react-markdown 会在末尾多补一个换行，去掉。 */
function plainTextOf(node: ReactNode): string {
  let out = "";
  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") out += child;
    else if (isValidElement<{ children?: ReactNode }>(child)) out += plainTextOf(child.props.children);
  });
  return out;
}
const codeSource = (node: ReactNode) => plainTextOf(node).replace(/\n$/, "");

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 上色：先显示纯文本，Shiki 加载好换成上过色的（不认识的语言一直是纯文本）。
 * 流式输出时 code 一直在变：每次变化停 HIGHLIGHT_DEBOUNCE_MS 才重新上色；等的时候保留上一版的颜色，
 * 新来的尾巴先用纯文本接在后面（只对“在原来内容后面追加”这种情况），不闪回灰色。
 */
function useHighlightedHtml(code: string, language: string): string | null {
  const [done, setDone] = useState<{ code: string; html: string } | null>(null);
  const enabled = language !== "" && !PLAIN_LANGUAGES.has(language.toLowerCase());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const timer = setTimeout(() => {
      highlightHtml(code, language).then(
        (html) => alive && setDone({ code, html }),
        () => {},
      );
    }, done === null ? 0 : HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // done 只用来决定第一次要不要等，不能放进依赖（上完色会再触发一遍）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language, enabled]);
  if (!enabled || done === null) return null;
  if (done.code === code) return done.html;
  if (!code.startsWith(done.code)) return null;
  const tail = escapeHtml(code.slice(done.code.length));
  return done.html.replace(/(<\/code>\s*<\/pre>\s*)$/, `${tail}$1`);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 没有剪贴板权限（非 https、被拒绝）：退回选中再复制
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={copied ? "已复制" : "复制代码"}
      onClick={() => {
        void copyText(code).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        });
      }}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** 代码块：右上角语言名 + 复制；代码按需上色。覆盖 react-markdown 的 <pre>（模块级、引用不变，流式重渲染不卸载）。 */
function CodeBlock(props: ComponentProps<"pre">) {
  const child = Children.toArray(props.children).find((c) => isValidElement(c)) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = languageOf(child?.props.className);
  const code = codeSource(child?.props.children ?? props.children);
  const html = useHighlightedHtml(code, language);
  return (
    <div data-md-code className="md-code">
      <div className="md-code-bar">
        {language !== "" && (
          <span data-md-code-lang className="md-code-lang">
            {language}
          </span>
        )}
        <CopyCodeButton code={code} />
      </div>
      {html !== null ? (
        <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-code-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** 表格：外面套一层横向滚动，宽表格在容器里滚，不撑破消息列。数字用等宽数字。 */
function Table(props: ComponentProps<"table">) {
  return (
    <div data-md-table>
      <table {...withoutNode(props)} className="tabular-nums" />
    </div>
  );
}

/** 模块级、引用不变：每次渲染都新建的话，父组件一重画（WS 推送）React 就当成新组件，内联图和卡片整个卸载重建、闪烁。 */
const COMPONENTS = { a: Link, img: Image, pre: CodeBlock, table: Table };
const NO_FILES: SentFile[] = [];

/**
 * agent 消息的 Markdown。不加 rehype-raw：消息里的原始 HTML 不会变成元素，当字面文字显示；
 * 链接地址由 react-markdown 默认的过滤处理（javascript: 之类不会带 href）。
 * files：这条消息的 meta.files（agent 发来的文件），对上的图片内联、链接换成文件卡片；老消息没有，照原样显示。
 * messageId：这条消息的编号，预览窗用它找文件做“在 Finder 中显示”；预览窗里渲染 .md 文件时不带（没有这两个按钮的对象）。
 */
export function Markdown({ text, files = NO_FILES, messageId }: { text: string; files?: SentFile[]; messageId?: number }) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks, remarkSentFiles(files)], [files]);
  const context = useMemo(() => ({ files, messageId }), [files, messageId]);
  return (
    <SentFilesContext value={context}>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </SentFilesContext>
  );
}
