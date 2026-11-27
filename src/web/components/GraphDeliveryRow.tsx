import { memo } from "react";
import { formatDurationShort } from "../../shared/schedule.ts";
import { MINUTE_TICK_MS } from "../limits.ts";
import { cn } from "../lib/utils.ts";
import { useNow } from "../useNow.ts";
import type { GraphDelivery } from "../work-status.ts";
import { WorkStatusIcon } from "./WorkStatusIcon.tsx";

export const GraphDeliveryRow = memo(function GraphDeliveryRow({
  row,
  detail = false,
}: {
  row: NonNullable<GraphDelivery["row"]>;
  detail?: boolean;
}) {
  const now = useNow(MINUTE_TICK_MS);
  const elapsed = Math.max(0, now - row.since);
  return (
    <div
      data-graph-delivery
      className={cn(
        "flex min-w-0 items-center gap-2 text-minor",
        detail ? "rounded-sm border border-border bg-background px-3.5 py-2.5" : "mt-2 min-h-6.5",
      )}
    >
      <WorkStatusIcon status="waiting" />
      <span className="font-medium">Delivery</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {row.wait.kind === "pm" ? "Waiting for the PM" : `Waiting for #${row.wait.watchId}: ${row.wait.body}`}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {elapsed < MINUTE_TICK_MS ? "<1m" : formatDurationShort(Math.floor(elapsed / MINUTE_TICK_MS) * MINUTE_TICK_MS)}
      </span>
    </div>
  );
});
