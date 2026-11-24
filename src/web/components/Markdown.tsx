import { createContext, memo, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import remarkGfm from "remark-gfm";
import {
  deliverableOriginOfFile,
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
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { ChartBlock } from "./ChartBlock.tsx";
import { codeElementOf, codeSource, CodeBlock, languageOf } from "./CodeBlock.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { useClient } from "../device-scope.tsx";

const SENT_FILE_ATTR = "data-sent-file";

// Unmatched local paths become plain text so the browser never requests them.
function flattenLocalLinks(tree: MdNode, unmatched: ReadonlySet<MdNode>): void {
  const definitions = new Map<string, string>();
  const collect = (node: MdNode) => {
    if (node.type === "definition" && node.identifier !== undefined && typeof node.url === "string") definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  };
  collect(tree);
  const isLocal = (node: MdNode) => {
    if (unmatched.has(node)) return true;
    if (node.type !== "imageReference" && node.type !== "linkReference") return false;
    const url = node.identifier === undefined ? undefined : definitions.get(node.identifier);
    return url !== undefined && parseLocalHref(url) !== null;
  };
  const flatten = (node: MdNode) => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (!isLocal(child)) {
        flatten(child);
        return [child];
      }
      if (child.type === "image" || child.type === "imageReference") return [{ type: "text", value: child.alt ?? "" }];
      flatten(child);
      return child.children ?? [];
    });
  };
  flatten(tree);
}

function remarkSentFiles(files: SentFile[], url: (path: string) => string) {
  const index = new Map(files.map((file, i) => [file.href, i]));
  return () => (tree: MdNode) => {
    const unmatched = new Set<MdNode>();
    for (const node of linkNodesOf(tree)) {
      const i = index.get(node.url!);
      const file = i === undefined ? undefined : files[i]!;
      if (file !== undefined) {
        node.url = file.id === null ? "" : url(sentFileUrl({ id: file.id, name: file.name }));
        node.data = { ...node.data, hProperties: { [SENT_FILE_ATTR]: String(i) } };
      } else if (parseLocalHref(node.url!) !== null) {
        unmatched.add(node);
      }
    }
    flattenLocalLinks(tree, unmatched);
  };
}

const SentFilesContext = createContext<{ files: SentFile[]; messageId: number | undefined }>({ files: [], messageId: undefined });

function useSentFile(props: object): { file: SentFile; index: number; messageId: number | undefined } | undefined {
  const { files, messageId } = useContext(SentFilesContext);
  const raw = (props as Record<string, unknown>)[SENT_FILE_ATTR];
  const index = typeof raw === "string" ? Number(raw) : -1;
  const file = files[index];
  return file === undefined ? undefined : { file, index, messageId };
}

function previewOf(file: SentFile, url: string, index: number, messageId: number | undefined): PreviewFile {
  const origin = deliverableOriginOfFile(file);
  const at = origin !== undefined ? origin : messageId === undefined ? null : { messageId, index };
  return { name: file.name, mime: file.mime, size: file.size, url, target: at === null ? null : { kind: "sent", messageId: at.messageId, index: at.index } };
}

function InlineSentImage({ alt, file, preview }: { alt: string; file: SentFile; preview: PreviewFile }) {
  const [open, setOpen] = useState(false);
  const [expired, markExpired] = useFileExpired(preview.url, false);
  if (expired) return <FileCard name={file.name} mime={file.mime} detail={FILE_EXPIRED_TEXT} className="my-1.5 w-fit max-w-full" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-sent-image className="my-2 block w-fit max-w-full cursor-zoom-in">
        <img src={preview.url} alt={alt} loading="lazy" onError={markExpired} className="block h-60 w-auto max-w-xs rounded-sm border border-border object-contain object-left" />
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

function SentFileLink({ preview, children }: { preview: PreviewFile; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-file-link onClick={() => setOpen(true)}>
        {children}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

function SentFileView({ sent, inline, alt, children }: { sent: NonNullable<ReturnType<typeof useSentFile>>; inline: boolean; alt?: string; children?: ReactNode }) {
  const { file, index, messageId } = sent;
  const client = useClient();
  const label = inline ? alt || file.name : children;
  if (file.status === "saved" && file.id !== null) {
    const url = client.url(sentFileUrl({ id: file.id, name: file.name }));
    const preview = previewOf(file, url, index, messageId);
    if (inline && isSentImage(file)) return <InlineSentImage alt={alt || file.name} file={file} preview={preview} />;
    return <SentFileLink preview={preview}>{label}</SentFileLink>;
  }
  return <>{label}</>;
}

function withoutNode<T extends object>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props as T & { node?: unknown };
  return rest;
}

function Link(props: ComponentProps<"a">) {
  const sent = useSentFile(props);
  if (sent !== undefined) {
    return (
      <SentFileView sent={sent} inline={false}>
        {props.children}
      </SentFileView>
    );
  }
  return <a {...withoutNode(props)} target="_blank" rel="noopener noreferrer" />;
}

function Image(props: ComponentProps<"img">) {
  const sent = useSentFile(props);
  if (sent !== undefined) return <SentFileView sent={sent} inline alt={props.alt} />;
  return <img {...withoutNode(props)} />;
}

function Table(props: ComponentProps<"table">) {
  return (
    <div data-md-table>
      <table {...withoutNode(props)} className="tabular-nums" />
    </div>
  );
}

function Pre(props: ComponentProps<"pre">) {
  const child = codeElementOf(props);
  const language = languageOf(child?.props.className);
  if (isChartLanguage(language) && (child?.props as Record<string, unknown> | undefined)?.[CHART_CLOSED_ATTR] === "true") {
    return <ChartBlock language={language.toLowerCase()} source={codeSource(child?.props.children)} />;
  }
  return <CodeBlock {...props} />;
}

// Module-level so parent rerenders do not remount inline images and cards.
const COMPONENTS = { a: Link, img: Image, pre: Pre, table: Table };
const NO_FILES: SentFile[] = [];

// remark-cjk-friendly must run after remarkGfm so emphasis next to CJK punctuation closes correctly.
export const Markdown = memo(function Markdown({ text, files = NO_FILES, messageId }: { text: string; files?: SentFile[]; messageId?: number }) {
  const client = useClient();
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough, remarkBreaks, remarkChartBlocks, remarkSentFiles(files, client.url)],
    [files, client],
  );
  const context = useMemo(() => ({ files, messageId }), [files, messageId]);
  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    ),
    [text, remarkPlugins],
  );
  return (
    <SentFilesContext value={context}>
      <div className="markdown">{rendered}</div>
    </SentFilesContext>
  );
});
