import { Loader2, TriangleAlert, WifiOff } from "lucide-react";
import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeError } from "../format.ts";
import { cn } from "../lib/utils.ts";

// 只用底色，不加阴影和描边（docs/ui-standard.md 第 4 条）
const PILL = "flex w-fit max-w-full items-center gap-2 rounded-full px-4 py-2 text-[13.5px]";

/**
 * 顶部的提醒：守护进程报告的问题（比如找不到 claude）、断线重连、别的设备离线（offline 是那一句，联机第 4.3 节；不报错弹窗）。
 * 靠左放在对话列里，和消息同一条左边线。
 */
export function Notices({ health, reconnecting, offline = null, listFailed = false }: { health: HealthEntry[]; reconnecting: boolean; offline?: string | null; listFailed?: boolean }) {
  if (health.length === 0 && !reconnecting && offline === null && !listFailed) return null;
  return (
    <div className="chat-column flex flex-col items-start gap-2 pt-3">
      {health.map((entry) => {
        const { label, detail } = describeError(entry.lastError ?? "");
        const severity = entry.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ? "error" : "warn";
        return (
          <div
            key={entry.module}
            className={cn(PILL, severity === "error" ? "bg-danger-soft text-danger" : "bg-warn text-warn-foreground")}
            role="alert"
            data-severity={severity}
          >
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            <span className="shrink-0 font-semibold">{label}</span>
            {detail && <span className="min-w-0 truncate opacity-80">{detail}</span>}
          </div>
        );
      })}
      {offline !== null && (
        <div className={cn(PILL, "bg-muted text-muted-foreground")} role="status" data-severity="info">
          <WifiOff className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{offline}</span>
        </div>
      )}
      {listFailed && (
        <div className={cn(PILL, "bg-muted text-muted-foreground")} role="status" data-severity="info">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="font-semibold">暂时看不到其他设备</span>
          <span>Retrying…</span>
        </div>
      )}
      {reconnecting && (
        <div className={cn(PILL, "bg-muted text-muted-foreground")} data-severity="info">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="font-semibold">重连中</span>
        </div>
      )}
    </div>
  );
}
