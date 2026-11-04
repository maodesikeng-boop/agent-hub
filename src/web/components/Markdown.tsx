import { createContext, useContext, useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
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
import { formatBytes } from "../upload.ts";
import { FileCard, useFileExpired } from "./Attachments.tsx";

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

/** 这条消息的 meta.files：模块级的 a、img 组件从这里取（组件引用不变，重渲染时内联图、卡片不卸载重建）。 */
const SentFilesContext = createContext<SentFile[]>([]);

function useSentFile(props: object): SentFile | undefined {
  const files = useContext(SentFilesContext);
  const raw = (props as Record<string, unknown>)[SENT_FILE_ATTR];
  return typeof raw === "string" ? files[Number(raw)] : undefined;
}

/** 内联图片；文件被清理掉了（取文件 404，<img> 报错）就换成“文件已过期”的卡片，不留破图。 */
function InlineSentImage({ url, alt, file }: { url: string; alt: string; file: SentFile }) {
  const [expired, markExpired] = useFileExpired(url, false);
  if (expired) return <FileCard name={file.name} mime={file.mime} detail={FILE_EXPIRED_TEXT} className="my-1.5 w-fit max-w-full" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" data-sent-image className="my-1.5 block w-fit max-w-full">
      <img src={url} alt={alt} loading="lazy" onError={markExpired} className="block max-h-[480px] max-w-full rounded-xl bg-muted object-contain ring-1 ring-black/5" />
    </a>
  );
}

/**
 * agent 发来的一个文件。图片语法 `![]()`（inline）写的、存了副本的图片：内联（宽同正文、最高 480px，点开看大图）；
 * 别的都是卡片：普通链接写的图片带缩略图，点了看大图；其他文件点了下载；没存下来的写原因。
 */
function SentFileView({ file, inline, alt }: { file: SentFile; inline: boolean; alt?: string }) {
  if (file.status === "saved" && file.id !== null) {
    const url = sentFileUrl({ id: file.id, name: file.name });
    if (inline && isSentImage(file)) return <InlineSentImage url={url} alt={alt || file.name} file={file} />;
    return <FileCard name={file.name} mime={file.mime} detail={file.size === null ? "" : formatBytes(file.size)} href={url} className="my-1.5 w-fit max-w-full" />;
  }
  return <FileCard name={file.name} mime={file.mime} detail={SENT_FILE_REASONS[file.status as Exclude<SentFile["status"], "saved">]} className="my-1.5 w-fit max-w-full" />;
}

function withoutNode<T extends object>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props as T & { node?: unknown };
  return rest;
}

/** 链接一律在新窗口打开；noopener noreferrer 防止新页面拿到当前页面的 window。对上 meta.files 的换成文件卡片。 */
function Link(props: ComponentProps<"a">) {
  const file = useSentFile(props);
  if (file !== undefined) return <SentFileView file={file} inline={false} />;
  return <a {...withoutNode(props)} target="_blank" rel="noopener noreferrer" />;
}

function Image(props: ComponentProps<"img">) {
  const file = useSentFile(props);
  if (file !== undefined) return <SentFileView file={file} inline alt={props.alt} />;
  return <img {...withoutNode(props)} />;
}

/** 模块级、引用不变：每次渲染都新建的话，父组件一重画（WS 推送）React 就当成新组件，内联图和卡片整个卸载重建、闪烁。 */
const COMPONENTS = { a: Link, img: Image };
const NO_FILES: SentFile[] = [];

/**
 * agent 消息的 Markdown。不加 rehype-raw：消息里的原始 HTML 不会变成元素，当字面文字显示；
 * 链接地址由 react-markdown 默认的过滤处理（javascript: 之类不会带 href）。
 * files：这条消息的 meta.files（agent 发来的文件），对上的图片内联、链接换成文件卡片；老消息没有，照原样显示。
 */
export function Markdown({ text, files = NO_FILES }: { text: string; files?: SentFile[] }) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkSentFiles(files)], [files]);
  return (
    <SentFilesContext value={files}>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </SentFilesContext>
  );
}
