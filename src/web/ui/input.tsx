// 输入框、多行输入、下拉（docs/ui-standard.md 第 6、7 条）：高 36px（h-9）、rounded-xl、15px 字、白底细边框；
// 聚焦时样子不变（边框不加深、不加光圈），靠光标表示；不合规（aria-invalid）是红边框。
import { ChevronDown, ChevronsUpDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

const FIELD =
  "w-full rounded-xl border border-border bg-background px-3 text-body outline-none transition-colors placeholder:text-muted-foreground aria-invalid:border-danger disabled:cursor-default disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(FIELD, "min-h-24 resize-y py-2 leading-relaxed", className)} {...props} />;
}

/**
 * 下拉：用浏览器自带的 select（键盘、读屏、手机上都是原生的），只换外观：宽度跟着内容，最宽 260px。
 * - field（默认）：和输入框一样的白底细边框，右边一个向下箭头。表单里和输入框并排时用。
 * - plain：分组行里改了马上存的设置（第 9 条）：没有边框和底色，右边上下箭头，悬停、聚焦浅灰底，像 macOS 系统设置的弹出菜单。
 */
export function Select({ className, variant = "field", ...props }: React.ComponentProps<"select"> & { variant?: "field" | "plain" }) {
  const Icon = variant === "plain" ? ChevronsUpDown : ChevronDown;
  return (
    // plain 往右伸出 12px：箭头和行里别的只读值的右边对齐，悬停的浅灰底伸进行的内边距里（同 macOS）
    <span className={cn("relative inline-flex min-w-0", variant === "plain" && "-mr-3")}>
      <select
        data-slot="select"
        className={cn(
          variant === "plain"
            ? "field-sizing-content rounded-xl bg-transparent pr-8 pl-3 text-body outline-none transition-colors hover:bg-sidebar-hover focus-visible:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
            : cn(FIELD, "pr-8"),
          "h-9 w-auto max-w-65 min-w-0 cursor-pointer appearance-none truncate",
          className,
        )}
        {...props}
      />
      <Icon
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", variant === "plain" ? "right-3 size-3.5" : "right-2.5 size-4")}
        aria-hidden="true"
      />
    </span>
  );
}
