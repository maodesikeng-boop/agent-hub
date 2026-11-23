import { ChevronDown } from "../ui/icons.ts";
import { useId, useState, type ReactNode } from "react";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

const GROUP_SHELL = "overflow-hidden border-2 border-border bg-background [contain:layout_style]";

const GROUP_BOX = `divide-y divide-border ${GROUP_SHELL}`;

const GROUP_TITLE = "text-minor font-medium text-muted-foreground";

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
    <section aria-label={label ?? title} className="grid grid-cols-1 gap-2">
      {(title || action) && (
        <div className={cn("flex min-h-8 items-center gap-3 px-4", title ? "justify-between" : "justify-end")}>
          {title && <h2 className={GROUP_TITLE}>{title}</h2>}
          {action}
        </div>
      )}
      <div className={GROUP_BOX}>{children}</div>
    </section>
  );
}

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
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== prevDefaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  return (
    <section aria-label={title}>
      <Collapsible open={open} onOpenChange={setOpen} className={GROUP_SHELL}>
        <h2>
          <CollapsibleTrigger className="group flex min-h-13 w-full cursor-pointer items-center gap-4 px-4 py-2 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]">
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {summary !== undefined && <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{summary}</span>}
            <ChevronDown
              className="size-pixel-sm shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="divide-y divide-border border-t border-border">{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function SettingsRow({
  label,
  badge,
  detail,
  icon,
  error,
  wide,
  stacked,
  children,
}: {
  label: string;
  badge?: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  error?: ErrorLike | null;
  wide?: boolean;
  stacked?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const labelText = (
    <label htmlFor={id} title={label} className="line-clamp-2 text-body">
      {label}
    </label>
  );
  return (
    <div data-slot="settings-row" className={cn("px-4", detail || stacked ? "py-3" : "py-2")}>
      <div className={cn("flex min-h-9 justify-between gap-x-4 gap-y-2", stacked ? "flex-col items-stretch" : cn("items-center", !wide && "flex-wrap"))}>
        <div className={cn("flex items-center gap-3", wide ? "min-w-0 shrink-0" : "min-w-32 flex-1")}>
          {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-pixel">{icon}</span>}
          <div className="min-w-0 flex-1 break-words">
            {badge === undefined ? labelText : <div className="flex min-w-0 items-center gap-2">{labelText}{badge}</div>}
            {detail && <div className="text-minor leading-snug text-muted-foreground">{detail}</div>}
          </div>
        </div>
        <div className={cn("flex max-w-full items-center gap-2", stacked ? "w-full" : cn("justify-end", wide ? "min-w-0" : "ml-auto shrink-0"))}>{children(id)}</div>
      </div>
      {error && <RowError error={error} />}
    </div>
  );
}

export function ReadonlyValue({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="truncate text-body text-muted-foreground">
      {children}
    </span>
  );
}

export function RowError({ error, children }: { error?: ErrorLike; children?: ReactNode }) {
  return (
    <p role="alert" title={error === undefined ? undefined : errorTitle(error)} className="mt-1 text-minor text-danger [overflow-wrap:anywhere]">
      {error === undefined ? children : errorLine(error)}
    </p>
  );
}
