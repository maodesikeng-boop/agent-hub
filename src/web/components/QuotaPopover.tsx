import { Hourglass } from "../ui/icons.ts";
import { memo } from "react";
import { formatQuotaReset } from "../format.ts";
import type { QuotaVendor, QuotaWindowUsage } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

const USAGE_BAR_COLORS = { normal: "bg-brand-ink", high: "bg-caution", full: "bg-danger" } as const;

function WindowRow({ window, exhausted }: { window: QuotaWindowUsage; exhausted: boolean }) {
  const level = exhausted ? "full" : window.warning || window.percent >= 80 ? "high" : "normal";
  const fillWidth = Math.min(100, Math.max(0, window.percent));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2 text-minor">
        <span className="shrink-0 font-medium text-foreground">{window.short}</span>
        {window.resetsAt !== null && (
          <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">Resets {formatQuotaReset(window.resetsAt)}</span>
        )}
        <span className={cn("ml-auto shrink-0 font-semibold tabular-nums", level === "full" ? "text-danger" : "text-foreground")}>
          {window.percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.short} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.percent}
        className="h-1.5 overflow-hidden rounded-xs bg-border"
      >
        <div className={cn("usage-fill h-full rounded-xs", USAGE_BAR_COLORS[level])} style={{ width: `${fillWidth}%` }} />
      </div>
    </div>
  );
}

function groupByVendor(blocks: readonly QuotaVendor[]): { name: string; blocks: QuotaVendor[] }[] {
  const sections: { name: string; blocks: QuotaVendor[] }[] = [];
  for (const block of blocks) {
    const last = sections[sections.length - 1];
    if (last?.name === block.name) last.blocks.push(block);
    else sections.push({ name: block.name, blocks: [block] });
  }
  return sections;
}

export const QuotaPopover = memo(function QuotaPopover({
  quota,
  loading = false,
  open,
  onOpenChange,
  placement = "sidebar",
  side,
  align,
  trigger,
}: {
  quota: readonly QuotaVendor[];
  loading?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: "sidebar" | "header";
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  trigger?: React.ReactNode;
}) {
  const inHeader = placement === "header";
  const head = quota[0];
  const window = head?.windows[0];
  if (!window && !loading && trigger === undefined) return null;
  const exhausted = quota.some((vendor) => vendor.exhausted);
  const label = exhausted ? "Usage limit reached" : window ? `${window.short} usage ${window.percent}%` : "Usage";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            variant="slot"
            size="icon"
            aria-label={label}
            title={label}
            className="shrink-0"
          >
            <Hourglass aria-hidden="true" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent side={side ?? (inHeader ? "bottom" : "top")} align={align ?? "end"} aria-label="Usage" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Hourglass className="size-pixel-md shrink-0 text-brand-ink" aria-hidden="true" />
          <h2 className="text-body font-semibold text-foreground">Usage</h2>
        </div>
        <div className="divide-y divide-border">
          {groupByVendor(quota).map((section) => (
            <section key={section.name} className="grid gap-3 px-4 py-3" aria-label={section.name}>
              <h3 className="text-minor font-semibold text-foreground">{section.name}</h3>
              <div className="grid gap-3">
                {section.blocks.map((vendor) => (
                  <div key={vendor.id} role={vendor.group ? "group" : undefined} aria-label={vendor.group} className="grid gap-2.5">
                    {vendor.group && <h4 className="text-xs font-medium text-muted-foreground">{vendor.group}</h4>}
                    {vendor.windows.map((w) => (
                      <WindowRow key={w.key} window={w} exhausted={w.percent >= 100 || (vendor.exhausted && !vendor.windows.some((x) => x.percent >= 100))} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {loading && <p className="px-4 py-3 text-xs text-muted-foreground">Loading…</p>}
          {!loading && quota.length === 0 && <p className="px-4 py-3 text-minor text-muted-foreground">No usage reported yet</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
});
