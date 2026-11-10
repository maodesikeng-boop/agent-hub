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

/** 用量条的颜色（docs/ui-standard.md 第 11 条）：正常中性灰、偏高（快用完）琥珀色、用满前景色实心；用满不用红色，不像报错。 */
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

/** 同一家厂商的相邻块并成一组：厂商名做组标题，按需查的那几块（Gemini、Claude and GPT）各带一行小标题。 */
function groupByVendor(blocks: QuotaVendor[]): { name: string; blocks: QuotaVendor[] }[] {
  const sections: { name: string; blocks: QuotaVendor[] }[] = [];
  for (const block of blocks) {
    const last = sections[sections.length - 1];
    if (last?.name === block.name) last.blocks.push(block);
    else sections.push({ name: block.name, blocks: [block] });
  }
  return sections;
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
        <div className="grid gap-6">
          {groupByVendor(blocks).map((section) => (
            <section key={section.name} className="grid gap-2" aria-label={section.name}>
              <h3 className="text-minor font-medium text-muted-foreground">{section.name}</h3>
              <div className="grid gap-4">
                {section.blocks.map((vendor) => (
                  <div key={vendor.id} role={vendor.group ? "group" : undefined} aria-label={vendor.group} className="grid gap-3">
                    {vendor.group && <h4 className="text-xs font-medium text-muted-foreground">{vendor.group}</h4>}
                    {vendor.windows.map((w) => (
                      <WindowRow key={w.key} window={w} exhausted={vendor.exhausted || w.percent >= 100} />
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
