import { Loader2, TriangleAlert } from "lucide-react";
import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeError } from "../format.ts";
import { cn } from "../lib/utils.ts";

const PILL = "flex w-fit max-w-full items-center gap-2 rounded-full px-4 py-2 text-[13.5px] shadow-sm ring-1 ring-black/5";

/** 顶部的提醒：守护进程报告的问题（比如找不到 claude）和断线重连。 */
export function Notices({ health, reconnecting }: { health: HealthEntry[]; reconnecting: boolean }) {
  if (health.length === 0 && !reconnecting) return null;
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-3">
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
      {reconnecting && (
        <div className={cn(PILL, "bg-muted text-muted-foreground")} data-severity="info">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="font-semibold">重连中</span>
        </div>
      )}
    </div>
  );
}
