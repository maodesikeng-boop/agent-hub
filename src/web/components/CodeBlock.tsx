import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { highlightHtml } from "../highlight.ts";
import { cn } from "../lib/utils.ts";

/** 不上色的语言写法：和没写语言一样，直接纯文本。 */
const PLAIN_LANGUAGES = new Set(["text", "txt", "plain", "plaintext"]);
/** 流式输出时，内容停多久才重新上色（毫秒）。 */
const INITIAL_HIGHLIGHT_MS = 0;
const HIGHLIGHT_DEBOUNCE_MS = 120;
export const COPIED_RESET_MS = 1500;

/** 代码块的语言：fence 上写的第一个词（remark 给 <code> 的 class 是 language-xxx）。 */
export function languageOf(className: string | undefined): string {
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
export const codeSource = (node: ReactNode) => plainTextOf(node).replace(/\n$/, "");

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 上色：先显示纯文本，Shiki 加载好换成上过色的（不认识的语言一直是纯文本）。
 * 流式输出时 code 一直在变：每次变化停 HIGHLIGHT_DEBOUNCE_MS 才重新上色；等的时候保留上一版的颜色，
 * 新来的尾巴先用纯文本接在后面（只对“在原来内容后面追加”这种情况），不闪回灰色。
 */
export function useHighlightedHtml(code: string, language: string): string | null {
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
    }, done === null ? INITIAL_HIGHLIGHT_MS : HIGHLIGHT_DEBOUNCE_MS);
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

/** 工具条上的图标按钮（docs/ui-standard.md 第 15 条）：size-7、无底色，悬停 bg-accent。 */
export function BarButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "touch-target inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
    />
  );
}

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const Icon = copied ? Check : Copy;
  return (
    <BarButton
      aria-label={copied ? "已复制" : "复制代码"}
      onClick={() => {
        void copyText(code).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        });
      }}
    >
      <Icon className="size-3.5" />
    </BarButton>
  );
}

/** 代码块里的 <code> 元素（react-markdown 的 <pre> 的子节点）。 */
export function codeElementOf(props: ComponentProps<"pre">): ReactElement<{ className?: string; children?: ReactNode }> | undefined {
  return Children.toArray(props.children).find((c) => isValidElement(c)) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
}

/** 代码本体：先纯文本，Shiki 加载好换成上色的。图表块切到“源码”时也用它。 */
export function CodeBody({ code, language }: { code: string; language: string }) {
  const html = useHighlightedHtml(code, language);
  return html !== null ? (
    <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="md-code-body">
      <code>{code}</code>
    </pre>
  );
}

/** 代码块外壳：右上角语言名 + 复制。图表块失败时显示的“普通代码块”也是它。 */
export function CodeView({ code, language }: { code: string; language: string }) {
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
      <CodeBody code={code} language={language} />
    </div>
  );
}

/** 代码块：覆盖 react-markdown 的 <pre>（模块级、引用不变，流式重渲染不卸载）。 */
export function CodeBlock(props: ComponentProps<"pre">) {
  const child = codeElementOf(props);
  return <CodeView code={codeSource(child?.props.children ?? props.children)} language={languageOf(child?.props.className)} />;
}
