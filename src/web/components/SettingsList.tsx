import { ChevronDown } from "../ui/icons.ts";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

export const INFO_ROW = "info-row min-h-7.5 pointer-coarse:min-h-11";

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
  const name = label ?? title;
  const body = (
    <>
      {(title || action) && (
        <div className={cn("info-heading", title ? "justify-between" : "justify-end")}>
          {title && <h2 className="min-w-0 truncate">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </>
  );
  return name === undefined ? (
    <div className="info-sec">{body}</div>
  ) : (
    <section aria-label={name} className="info-sec">
      {body}
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
      <Collapsible open={open} onOpenChange={setOpen}>
        <h2>
          <CollapsibleTrigger className={cn("group", INFO_ROW, "h-7.5")}>
            <span className="min-w-0 flex-1 truncate text-minor text-foreground">{title}</span>
            {summary !== undefined && <span className="info-val shrink-0 text-minor tabular-nums">{summary}</span>}
            <ChevronDown
              className="info-chevron size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="pl-4">{children}</CollapsibleContent>
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
    <label htmlFor={id} title={label} className="truncate text-minor text-foreground">
      {label}
    </label>
  );
  return (
    <div
      data-slot="settings-row"
      className={cn(
        INFO_ROW,
        "flex-wrap justify-between gap-x-4",
        stacked ? "flex-col items-stretch gap-y-1.5 py-1.5" : detail ? "py-1" : undefined,
      )}
    >
      <div className={cn("flex items-center gap-2", wide ? "min-w-0 shrink-0" : "min-w-28 flex-1")}>
        {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-col">
          {badge === undefined ? labelText : <div className="flex min-w-0 items-center gap-2">{labelText}{badge}</div>}
          {detail && <div className="text-xs leading-snug text-muted-foreground">{detail}</div>}
        </div>
      </div>
      <div className={cn("flex max-w-full items-center gap-2", stacked ? "w-full" : cn("justify-end", wide ? "min-w-0 flex-1" : "ml-auto shrink-0"))}>{children(id)}</div>
      {error && (
        <div className="basis-full">
          <RowError error={error} />
        </div>
      )}
    </div>
  );
}

export function InfoAction({ danger = false, className, ...props }: ComponentProps<"button"> & { danger?: boolean }) {
  return <button type="button" className={cn("info-action touch-target", danger && "info-action-danger", className)} {...props} />;
}

export function ReadonlyValue({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="info-val truncate text-minor tabular-nums">
      {children}
    </span>
  );
}

export function RowError({ error, children }: { error?: ErrorLike; children?: ReactNode }) {
  return (
    <p role="alert" title={error === undefined ? undefined : errorTitle(error)} className="mt-0.5 mb-1 text-xs text-danger [overflow-wrap:anywhere]">
      {error === undefined ? children : errorLine(error)}
    </p>
  );
}
