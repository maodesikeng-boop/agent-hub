import { formatQuotaReset } from "../format.ts";
import type { QuotaVendor, QuotaWindowUsage } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

function WindowRow({ window, exhausted }: { window: QuotaWindowUsage; exhausted: boolean }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[15px]">
        <span>{window.label}</span>
        <span className={cn("tabular-nums", exhausted ? "text-danger" : window.warning && "text-warn-foreground")}>{window.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.label}额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", exhausted ? "bg-danger" : window.warning ? "bg-warn-foreground" : "bg-foreground/60")}
          style={{ width: `${window.percent}%` }}
        />
      </div>
      {window.resetsAt !== null && <span className="text-[13.5px] text-muted-foreground tabular-nums">{formatQuotaReset(window.resetsAt)} 重置</span>}
    </div>
  );
}

/** 左下角的额度标识：直接显示第一个厂商的第一个窗口（5 小时）已用的百分比，点开按厂商分组看每个窗口。没有数据不显示。 */
export function QuotaPopover({ quota }: { quota: QuotaVendor[] }) {
  const head = quota[0];
  const window = head?.windows[0];
  if (!head || !window) return null;
  const exhausted = quota.some((vendor) => vendor.exhausted);
  const warning = quota.some((vendor) => vendor.windows[0]?.warning);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={exhausted ? "额度已用完" : `${window.label}额度已用 ${window.percent}%`}
        className={cn(
          "h-8 shrink-0 cursor-pointer rounded-full px-3 text-[13px] font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          exhausted ? "bg-danger-soft text-danger" : warning ? "bg-warn text-warn-foreground" : "bg-sidebar-active text-foreground hover:bg-sidebar-hover",
        )}
      >
        {exhausted ? "已用完" : `${window.percent}%`}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="额度">
        <div className="grid gap-5">
          {quota.map((vendor) => (
            <section key={vendor.id} className="grid gap-4" aria-label={vendor.name}>
              <h3 className="text-[13.5px] font-medium text-muted-foreground">{vendor.name}</h3>
              {vendor.windows.map((w) => (
                <WindowRow key={w.key} window={w} exhausted={vendor.exhausted} />
              ))}
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
