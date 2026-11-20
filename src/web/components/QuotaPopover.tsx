import { useQuery } from "@tanstack/react-query";
import { CircleGauge } from "../ui/icons.ts";
import { useState } from "react";
import { useClient } from "../device-scope.tsx";
import { formatQuotaReset } from "../format.ts";
import { fetchedQuotaUsage, type QuotaVendor, type QuotaWindowUsage } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

const QUOTA_REFETCH_INTERVAL_MS = 60_000;

const USAGE_BAR_COLORS = { normal: "bg-foreground/40", high: "bg-caution", full: "bg-foreground" } as const;

function WindowRow({ window, exhausted }: { window: QuotaWindowUsage; exhausted: boolean }) {
  const level = exhausted ? "full" : window.warning ? "high" : "normal";
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-4 text-body">
        <span>{window.short}</span>
        <span className="tabular-nums">{window.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.short} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.percent}
        className="h-1.5 overflow-hidden rounded-full bg-sidebar-active"
      >
        <div className={cn("h-full rounded-full", USAGE_BAR_COLORS[level])} style={{ width: `${window.percent}%` }} />
      </div>
      {window.resetsAt !== null && <span className="text-xs text-muted-foreground tabular-nums">Resets {formatQuotaReset(window.resetsAt)}</span>}
    </div>
  );
}

function groupByVendor(blocks: QuotaVendor[]): { name: string; blocks: QuotaVendor[] }[] {
  const sections: { name: string; blocks: QuotaVendor[] }[] = [];
  for (const block of blocks) {
    const last = sections[sections.length - 1];
    if (last?.name === block.name) last.blocks.push(block);
    else sections.push({ name: block.name, blocks: [block] });
  }
  return sections;
}

export function QuotaPopover({ quota, fetchable = false, placement = "sidebar" }: {
  quota: QuotaVendor[];
  fetchable?: boolean;
  placement?: "sidebar" | "header";
}) {
  const [open, setOpen] = useState(false);
  const client = useClient();
  const qc = useHubQueryClient();
  const { data: fetched = [], isFetching: loading } = useQuery(
    {
      queryKey: ["quota", client.device ?? ""] as const,
      queryFn: async () => {
        try {
          return fetchedQuotaUsage(await client.fetchQuota());
        } catch {
          return [];
        }
      },
      enabled: open && fetchable,
      staleTime: 0,
      refetchInterval: open && fetchable ? QUOTA_REFETCH_INTERVAL_MS : false,
    },
    qc,
  );
  const inHeader = placement === "header";
  const head = quota[0];
  const window = head?.windows[0];
  if (!window && !fetchable) return null;
  const blocks = [...quota, ...fetched];
  const exhausted =
    quota.some((vendor) => vendor.exhausted) || fetched.some((vendor) => vendor.exhausted || vendor.windows.some((w) => w.percent >= 100));
  const label = exhausted ? "Usage limit reached" : window ? `${window.short} usage ${window.percent}%` : "Usage";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="slot"
          size="icon"
          aria-label={label}
          title={label}
          className="shrink-0"
        >
          <CircleGauge aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side={inHeader ? "bottom" : "top"} align="end" aria-label="Usage">
        <div className="grid gap-6">
          {groupByVendor(blocks).map((section) => (
            <section key={section.name} className="grid gap-2" aria-label={section.name}>
              <h3 className="text-minor font-medium text-muted-foreground">{section.name}</h3>
              <div className="grid gap-4">
                {section.blocks.map((vendor) => (
                  <div key={vendor.id} role={vendor.group ? "group" : undefined} aria-label={vendor.group} className="grid gap-3">
                    {vendor.group && <h4 className="text-xs font-medium text-muted-foreground">{vendor.group}</h4>}
                    {vendor.windows.map((w) => (
                      <WindowRow key={w.key} window={w} exhausted={w.percent >= 100 || (vendor.exhausted && !vendor.windows.some((x) => x.percent >= 100))} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {loading && fetched.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
