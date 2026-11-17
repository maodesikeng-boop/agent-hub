import type * as React from "react";
import { cn } from "../lib/utils.ts";

/**
 * 提问卡里的一个预设选项（docs/ui-standard.md 第 17、21 条）：对话里的提问卡和 Router 的待拍板卡共用这一行。
 * 平时就有细边框（触屏没有悬停，不带框看着像一行普通文字）；左边字母徽标，`Recommended` 紧跟在选项文字后面（隔 12px），不甩到卡片最右端。
 * 选中（已回答的卡）是 bg-sidebar-active、不带边框。
 */
export function OptionRow({
  index,
  recommended = false,
  chosen = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & {
  /** 第几个选项（0 起），徽标显示 A、B、C…… */
  index: number;
  recommended?: boolean;
  chosen?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-body leading-6 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default",
        chosen ? "border-transparent bg-sidebar-active" : "border-border bg-background hover:bg-sidebar-hover disabled:opacity-60 disabled:hover:bg-background",
        className,
      )}
      {...props}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-xl border border-border bg-sidebar text-xs font-medium text-muted-foreground">
        {String.fromCharCode(65 + index)}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 [overflow-wrap:anywhere] [&_p]:m-0">{children}</span>
        {recommended && <span className="shrink-0 text-xs text-muted-foreground">Recommended</span>}
      </span>
    </button>
  );
}
