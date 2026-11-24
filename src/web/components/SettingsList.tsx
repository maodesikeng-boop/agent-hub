import { ChevronDown } from "../ui/icons.ts";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

const GROUP_SHELL = "overflow-hidden rounded-sm border border-border bg-background [contain:layout_style]";

const GROUP_BOX = `divide-y divide-border ${GROUP_SHELL}`;

const GROUP_FLAT = "divide-y divide-border [contain:layout_style]";

type GroupLayout = "box" | "flat" | "page";

// Panels, dialogs, and phone pages keep each group in one hairline box; a sheet lays its sections flat, and the Settings
// page also turns every section into a title column beside its rows once the sheet is wide enough to hold both.
const GroupLayoutContext = createContext<GroupLayout>("box");

export function FlatSettingsGroups({ page = false, children }: { page?: boolean; children: ReactNode }) {
  return <GroupLayoutContext.Provider value={page ? "page" : "flat"}>{children}</GroupLayoutContext.Provider>;
}

const GROUP_TITLE = "text-minor font-medium text-muted-foreground";

// Only the Settings page body declares the `settings` container, so these never reach a dialog opened from the page.
const PAGE_SECTION = "@min-[52rem]/settings:grid-cols-[12rem_minmax(0,1fr)] @min-[52rem]/settings:gap-x-6 @min-[52rem]/settings:gap-y-0";
const PAGE_HEADING =
  "@min-[52rem]/settings:min-h-0 @min-[52rem]/settings:flex-col @min-[52rem]/settings:items-start @min-[52rem]/settings:justify-start @min-[52rem]/settings:pt-3.5";
const PAGE_ROWS = "@min-[52rem]/settings:col-start-2 @min-[52rem]/settings:row-start-1";

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
  const layout = useContext(GroupLayoutContext);
  const page = layout === "page";
  return (
    <section aria-label={label ?? title} className={cn("grid grid-cols-1", layout === "box" ? "gap-2" : "gap-0", page && PAGE_SECTION)}>
      {(title || action) && (
        <div className={cn("flex min-h-8 items-center gap-3 px-4", title ? "justify-between" : "justify-end", page && PAGE_HEADING)}>
          {title && <h2 className={GROUP_TITLE}>{title}</h2>}
          {action}
        </div>
      )}
      <div className={cn(layout === "box" ? GROUP_BOX : GROUP_FLAT, page && PAGE_ROWS)}>{children}</div>
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
  const layout = useContext(GroupLayoutContext);
  const [open, setOpen] = useState(defaultOpen);
  const [prevDefaultOpen, setPrevDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== prevDefaultOpen) {
    setPrevDefaultOpen(defaultOpen);
    if (defaultOpen) setOpen(true);
  }
  return (
    // On the Settings page a collapsed list closes the section above it, sharing its hairline instead of opening a gap.
    <section
      aria-label={title}
      className={cn(layout === "page" && "@min-[0rem]/settings:-mt-8 @min-[52rem]/settings:-mt-10 @min-[52rem]/settings:ml-54")}
    >
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={layout === "box" ? GROUP_SHELL : layout === "page" ? "border-t border-border" : "border-y border-border"}
      >
        <h2>
          <CollapsibleTrigger className="group flex min-h-13 w-full cursor-pointer items-center gap-4 rounded-none px-4 py-2 text-left text-body transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]">
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
