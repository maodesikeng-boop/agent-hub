import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

/** 链接一律在新窗口打开；noopener noreferrer 防止新页面拿到当前页面的 window。 */
function Link(props: ComponentProps<"a">) {
  const { node: _node, ...rest } = props as ComponentProps<"a"> & { node?: unknown };
  return <a {...rest} target="_blank" rel="noopener noreferrer" />;
}

/**
 * agent 消息的 Markdown。不加 rehype-raw：消息里的原始 HTML 不会变成元素，当字面文字显示；
 * 链接地址由 react-markdown 默认的过滤处理（javascript: 之类不会带 href）。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={{ a: Link }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
