// 分组列表（docs/ui-standard.md 第 9 条；资料页、新建项目经理、全局设置共用）：组标题在框外，框里一行一项，左边名字、右边控件。
// 颜色、圆角、字号跟左栏一致：浅灰底（bg-sidebar）、rounded-2xl、15px；文字左边和组标题都对齐在框内 16px（px-4）。
import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** 一组：小号灰色标题（可以没有）+ 圆角浅底的框，框里的直接子元素之间有细分隔线。aria-label 是标题。 */
export function SettingsGroup({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2">
      {(title || action) && (
        <div className="flex min-h-7 items-end justify-between gap-3 px-4">
          {title && <h2 className="text-[13.5px] font-medium text-muted-foreground">{title}</h2>}
          {action}
        </div>
      )}
      <div className="divide-y divide-sidebar-active overflow-hidden rounded-2xl bg-sidebar">{children}</div>
    </section>
  );
}

/**
 * 一行：左边名字（下面可以有一行小字），右边控件。控件通过 render 参数拿到要绑的 id（名字是它的 label）。
 * error：这一行出的错，显示在行下面。wide：控件可以收窄（长路径截断），名字不收。
 */
export function SettingsRow({
  label,
  detail,
  error,
  wide,
  children,
}: {
  label: string;
  detail?: ReactNode;
  error?: string | null;
  wide?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="px-4 py-2.5">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <div className={cn("min-w-0", wide && "shrink-0")}>
          <label htmlFor={id} className="text-[15px]">
            {label}
          </label>
          {detail && <div className="text-[13.5px] text-muted-foreground">{detail}</div>}
        </div>
        <div className={cn("flex min-w-0 items-center justify-end gap-2", !wide && "shrink-0")}>{children(id)}</div>
      </div>
      {error && <RowError>{error}</RowError>}
    </div>
  );
}

/** 行下面的错误。 */
export function RowError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-1 text-[13.5px] text-danger [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}
