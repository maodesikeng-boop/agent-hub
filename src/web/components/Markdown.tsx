import { createContext, useContext, useMemo, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
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
import { isChartLanguage } from "../charts/registry.ts";
import { CHART_CLOSED_ATTR, remarkChartBlocks } from "../charts/remark-chart-blocks.ts";
import { formatBytes } from "../upload.ts";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { ChartBlock } from "./ChartBlock.tsx";
import { codeElementOf, codeSource, CodeBlock, languageOf } from "./CodeBlock.tsx";
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

/** 表格：外面套一层横向滚动，宽表格在容器里滚，不撑破消息列。数字用等宽数字。 */
function Table(props: ComponentProps<"table">) {
  return (
    <div data-md-table>
      <table {...withoutNode(props)} className="tabular-nums" />
    </div>
  );
}

/**
 * 代码块分流：语言在图表渲染器表里、且已闭合（remarkChartBlocks 标的）→ 图表块；其余（含流式中没闭合的）→ 普通代码块。
 * 不按厂商分支：所有地方的 Markdown 都走这里。
 */
function Pre(props: ComponentProps<"pre">) {
  const child = codeElementOf(props);
  const language = languageOf(child?.props.className);
  if (isChartLanguage(language) && (child?.props as Record<string, unknown> | undefined)?.[CHART_CLOSED_ATTR] === "true") {
    return <ChartBlock language={language.toLowerCase()} source={codeSource(child?.props.children)} />;
  }
  return <CodeBlock {...props} />;
}

/** 模块级、引用不变：每次渲染都新建的话，父组件一重画（WS 推送）React 就当成新组件，内联图和卡片整个卸载重建、闪烁。 */
const COMPONENTS = { a: Link, img: Image, pre: Pre, table: Table };
const NO_FILES: SentFile[] = [];

/**
 * agent 消息的 Markdown。不加 rehype-raw：消息里的原始 HTML 不会变成元素，当字面文字显示；
 * 中文旁边的 **、*、~~：CommonMark 在收尾符号前是标点（。）、后面紧跟汉字时认不出收尾，用 remark-cjk-friendly 修（顺序：必须在 remarkGfm 之后）。
 * 链接地址由 react-markdown 默认的过滤处理（javascript: 之类不会带 href）。
 * files：这条消息的 meta.files（agent 发来的文件），对上的图片内联、链接换成文件卡片；老消息没有，照原样显示。
 * messageId：这条消息的编号，预览窗用它找文件做“在 Finder 中显示”；预览窗里渲染 .md 文件时不带（没有这两个按钮的对象）。
 */
export function Markdown({ text, files = NO_FILES, messageId }: { text: string; files?: SentFile[]; messageId?: number }) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkBreaks, remarkChartBlocks, remarkSentFiles(files)], [files]);
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
