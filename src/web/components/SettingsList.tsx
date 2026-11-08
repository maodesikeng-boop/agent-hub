// 分组列表（docs/ui-standard.md 第 9 条；资料页、新建项目经理、全局设置共用）：组标题在框外，框里一行一项，左边名字、右边控件。
// 颜色、圆角、字号跟左栏一致：浅灰底（bg-sidebar）、rounded-2xl、15px；文字左边和组标题都对齐在框内 16px（px-4）。
import { useId, type ReactNode } from "react";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";

/**
 * 一组：小号灰色标题（可以没有）+ 圆角浅底的框，框里的直接子元素之间有细分隔线。
 * 读屏名字是 title；没有标题的组（资料页头部下面第一组）用 label。
 */
export function SettingsGroup({ title, label, action, children }: { title?: string; label?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title ?? label} className="grid gap-2">
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
 * 一行 52px（py-2 + 36px）；有小字的行 py-3，跟着长高。
 * error：这一行出的错（保存失败、表单里填得不对），显示在行下面。wide：控件可以收窄（长内容截断），名字不收。
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
  error?: ErrorLike | null;
  wide?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div data-slot="settings-row" className={cn("px-4", detail ? "py-3" : "py-2")}>
      <div className="flex min-h-9 items-center justify-between gap-4">
        <div className={cn("min-w-0", wide && "shrink-0")}>
          <label htmlFor={id} className="block text-[15px]">
            {label}
          </label>
          {detail && <div className="text-[13.5px] leading-snug text-muted-foreground">{detail}</div>}
        </div>
        <div className={cn("flex min-w-0 items-center justify-end gap-2", !wide && "shrink-0")}>{children(id)}</div>
      </div>
      {error && <RowError error={error} />}
    </div>
  );
}

/** 行右边的只读值（厂商只有一家时的厂商名）：15px 灰。 */
export function ReadonlyValue({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="truncate text-[15px] text-muted-foreground">
      {children}
    </span>
  );
}

/** 行下面的错误：接口错误传 error（text 后面接 hint，raw 放 title），自己写的一句话传 children。 */
export function RowError({ error, children }: { error?: ErrorLike; children?: ReactNode }) {
  return (
    <p role="alert" title={error === undefined ? undefined : errorTitle(error)} className="mt-1 text-[13.5px] text-danger [overflow-wrap:anywhere]">
      {error === undefined ? children : errorLine(error)}
    </p>
  );
}
