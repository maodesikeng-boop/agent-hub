import { Loader2 } from "lucide-react";
import type { QuotaUsage } from "../selectors.ts";

/** 标题栏右边：额度已用的百分比、在跑的 Worker 数（m3-plan 2.7）。都没有就什么也不显示。 */
export function TopBarStats({ quota, running }: { quota: QuotaUsage; running: number }) {
  const parts = [
    quota.fiveHour === null ? null : `5 小时额度已用 ${quota.fiveHour}%`,
    quota.sevenDay === null ? null : `${quota.fiveHour === null ? "7 天额度已用" : "7 天"} ${quota.sevenDay}%`,
  ].filter((part) => part !== null);
  if (parts.length === 0 && running === 0) return null;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-4 text-[13px] text-muted-foreground" role="group" aria-label="额度和 Worker">
      {running > 0 && (
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden="true" />
          {running} 个 Worker 在跑
        </span>
      )}
      {parts.length > 0 && <span className="tabular-nums">{parts.join(" · ")}</span>}
    </div>
  );
}
