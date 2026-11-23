import { Check, Copy } from "../ui/icons.ts";
import { Children, isValidElement, useEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { highlightHtml } from "../highlight.ts";
import { cn } from "../lib/utils.ts";

const PLAIN_LANGUAGES = new Set(["text", "txt", "plain", "plaintext"]);
const INITIAL_HIGHLIGHT_MS = 0;
const HIGHLIGHT_DEBOUNCE_MS = 120;
export const COPIED_RESET_MS = 1500;

export function languageOf(className: string | undefined): string {
  return /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? "";
}

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
    }, done === null ? INITIAL_HIGHLIGHT_MS : HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // done only gates the first delay; adding it as a dependency would re-run after highlighting.
  }, [code, language, enabled]);
  if (!enabled || done === null) return null;
  if (done.code === code) return done.html;
  if (!code.startsWith(done.code)) return null;
  const tail = escapeHtml(code.slice(done.code.length));
  return done.html.replace(/(<\/code>\s*<\/pre>\s*)$/, `${tail}$1`);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
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

export function BarButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "touch-target inline-flex size-7 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus",
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
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void copyText(code).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        });
      }}
    >
      <Icon className="size-pixel-sm" />
    </BarButton>
  );
}

export function codeElementOf(props: ComponentProps<"pre">): ReactElement<{ className?: string; children?: ReactNode }> | undefined {
  return Children.toArray(props.children).find((c) => isValidElement(c)) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
}

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

export function CodeBlock(props: ComponentProps<"pre">) {
  const child = codeElementOf(props);
  return <CodeView code={codeSource(child?.props.children ?? props.children)} language={languageOf(child?.props.className)} />;
}
