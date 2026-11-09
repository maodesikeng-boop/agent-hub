import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../device-scope.tsx";
import { formatQuotaReset } from "../format.ts";
import { fetchedQuotaUsage, type QuotaVendor, type QuotaWindowUsage } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

const QUOTA_REFETCH_INTERVAL_MS = 60_000;

function WindowRow({ window, exhausted }: { window: QuotaWindowUsage; exhausted: boolean }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-body">
        <span>{window.short}</span>
        <span className={cn("tabular-nums", exhausted ? "text-danger" : window.warning && "text-warn-foreground")}>{window.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.short} usage`}
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
      {window.resetsAt !== null && <span className="text-minor text-muted-foreground tabular-nums">Resets {formatQuotaReset(window.resetsAt)}</span>}
    </div>
  );
}

/** 16px 的小圆环：已用的部分画成弧，颜色跟着文字走（currentColor）。 */
function Ring({ percent }: { percent: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
      {percent > 0 && <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${(c * percent) / 100} ${c}`} />}
    </svg>
  );
}

/**
 * 左下角的额度按钮（docs/ui-standard.md 第 16 条）：ghost 图标按钮（size="icon-sm"），只显示小圆环图标（无旁白文字），
 * 快用完、用完换颜色，无障碍名称与悬停提示保留完整状态。点开按厂商分组看每个窗口。没有数据不显示。
 * fetchable：有厂商的额度要按需查（事件里没有，agy），没有别家的数据时按钮也在；
 * 每次点开向服务端要一次（服务端缓存 5 分钟）并在打开期间定时刷新，问不到、问失败就没有那几块。
 */
export function QuotaPopover({ quota, fetchable = false }: { quota: QuotaVendor[]; fetchable?: boolean }) {
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
  const head = quota[0];
  const window = head?.windows[0];
  if (!window && !fetchable) return null;
  const blocks = [...quota, ...fetched];
  const exhausted =
    quota.some((vendor) => vendor.exhausted) || fetched.some((vendor) => vendor.exhausted || vendor.windows.some((w) => w.percent >= 100));
  const warning = quota.some((vendor) => vendor.windows[0]?.warning);
  const label = exhausted ? "Usage limit reached" : window ? `${window.short} usage ${window.percent}%` : "Usage";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={cn("shrink-0", exhausted ? "text-danger hover:text-danger" : warning && "text-warn-foreground hover:text-warn-foreground")}
        >
          <Ring percent={exhausted ? 100 : (window?.percent ?? 0)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label="Usage">
        <div className="grid gap-5">
          {blocks.map((vendor) => (
            <section key={vendor.id} className="grid gap-4" aria-label={vendor.name}>
              <h3 className="text-minor font-medium text-muted-foreground">{vendor.name}</h3>
              {vendor.windows.map((w) => (
                <WindowRow key={w.key} window={w} exhausted={vendor.exhausted || w.percent >= 100} />
              ))}
            </section>
          ))}
          {loading && fetched.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
