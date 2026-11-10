// 分组列表（docs/ui-standard.md 第 9 条；资料页、新建项目经理、设置弹窗共用，照 Grok Bot 设置页）：
// 组标题在框外（13.5px 灰，px-4），框是白底 1px 浅边框圆角（GROUP_BOX），行间 1px divide-border。
// 低频、会越来越长的组用 CollapsibleGroup：框里第一行是标题 + 摘要（个数或状态词）+ 箭头，点开才列出下面的行。
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

/** 分组框的外壳样子：白底、1px 浅边框、圆角。 */
const GROUP_SHELL = "overflow-hidden rounded-2xl border border-border bg-background";

/** 普通分组框：外壳 + 行间细线。 */
const GROUP_BOX = `divide-y divide-border ${GROUP_SHELL}`;

/** 组标题：13.5px、500、灰。 */
const GROUP_TITLE = "text-minor font-medium text-muted-foreground";

/**
 * 一组：小号灰色标题（可以没有）+ 白底细框，框里的直接子元素之间有细分隔线。
 * 读屏名字是 title；没有标题的组（资料页头部下面第一组）用 label。
 */
export function SettingsGroup({
  title,
  label,
  action,
  children,
}: {
  title?: string;
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title ?? label} className="grid grid-cols-1 gap-2">
      {(title || action) && (
        <div className="flex min-h-7 items-end justify-between gap-3 px-4">
          {title && <h2 className={GROUP_TITLE}>{title}</h2>}
          {action}
        </div>
      )}
      <div className={GROUP_BOX}>{children}</div>
    </section>
  );
}

/**
 * 能收起的一组（已登录的浏览器、公网入口、修改记录）：收起时只剩框里一行“标题 …… 摘要 ⌄”，点开才列出下面的行。
 * 标题行是 h2 里的按钮（WAI-ARIA 折叠面板的写法），摘要是个数（“4 个”）或英文状态词（Off）。
 * defaultOpen：一开始开不开；可以跟着数据变（比如来了待批准的浏览器），变成 true 时自己展开。
 */
export function CollapsibleGroup({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // defaultOpen 变成 true（来了待批准的浏览器、公网入口开了）时展开一次；变回 false 不自己收起，用户收起的也不再弹开
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== prevDefaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  return (
    <section aria-label={title}>
      <Collapsible open={open} onOpenChange={setOpen} className={GROUP_SHELL}>
        <h2>
          <CollapsibleTrigger className="group flex min-h-13 w-full cursor-pointer items-center gap-4 px-4 py-2 text-left text-body transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {summary !== undefined && <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{summary}</span>}
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="divide-y divide-border border-t border-border">{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/**
 * 一行：左边名字（下面可以有一行小字），右边控件。控件通过 render 参数拿到要绑的 id（名字是它的 label）。
 * 一行 52px（py-2 + 36px，px-4）；有小字的行 py-3，跟着长高。
 * icon：名字左边 16px 线条图标（设备行的电脑、手机）。error：这一行出的错，显示在行下面。wide：控件可以收窄（长内容截断），名字不收。
 * 宽度（任何宽度下右边的按钮都完整可见）：左边至少留 8rem、其余让给控件，名字最多两行（再长截断，悬停看全名）、小字超出换行（含长域名、路径）；
 * 左右两块放不下时控件换到下一行靠右（wide 的行不换，控件自己截断）；控件整块不比这一行宽（里面的输入框跟着收窄）。
 */
export function SettingsRow({
  label,
  detail,
  icon,
  error,
  wide,
  children,
}: {
  label: string;
  detail?: ReactNode;
  icon?: ReactNode;
  error?: ErrorLike | null;
  wide?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div data-slot="settings-row" className={cn("px-4", detail ? "py-3" : "py-2")}>
      <div className={cn("flex min-h-9 items-center justify-between gap-x-4 gap-y-2", !wide && "flex-wrap")}>
        <div className={cn("flex items-center gap-3", wide ? "min-w-0 shrink-0" : "min-w-32 flex-1")}>
          {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4 [&_svg]:stroke-[1.5]">{icon}</span>}
          <div className="min-w-0 flex-1 break-words">
            <label htmlFor={id} title={label} className="line-clamp-2 text-body">
              {label}
            </label>
            {detail && <div className="text-minor leading-snug text-muted-foreground">{detail}</div>}
          </div>
        </div>
        <div className={cn("flex max-w-full items-center justify-end gap-2", wide ? "min-w-0" : "ml-auto shrink-0")}>{children(id)}</div>
      </div>
      {error && <RowError error={error} />}
    </div>
  );
}

/** 行右边的只读值（厂商只有一家时的厂商名）：15px 灰。 */
export function ReadonlyValue({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="truncate text-body text-muted-foreground">
      {children}
    </span>
  );
}

/** 行下面的错误：接口错误传 error（text 后面接 hint，raw 放 title），自己写的一句话传 children。 */
export function RowError({ error, children }: { error?: ErrorLike; children?: ReactNode }) {
  return (
    <p role="alert" title={error === undefined ? undefined : errorTitle(error)} className="mt-1 text-minor text-danger [overflow-wrap:anywhere]">
      {error === undefined ? children : errorLine(error)}
    </p>
  );
}
