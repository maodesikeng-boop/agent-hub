import { Loader2, TriangleAlert, WifiOff } from "../ui/icons.ts";
import { memo } from "react";
import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import { cn } from "../lib/utils.ts";

const PILL = "flex w-fit max-w-full items-center gap-2 border-2 border-border-strong bg-panel px-4 py-2 text-minor text-foreground";
const ICON = "size-4 shrink-0";
const PILL_ACTION = "touch-target shrink-0 cursor-pointer font-medium text-rail-ink underline decoration-rail-ink/40 underline-offset-3 outline-none hover:decoration-rail-ink focus-visible:outline-2 focus-visible:outline-border-focus";

export const Notices = memo(function Notices({
  health,
  reconnecting,
  offline = null,
  listFailed = false,
  onManageProviders,
}: {
  health: HealthEntry[];
  reconnecting: boolean;
  offline?: string | null;
  listFailed?: boolean;
  onManageProviders?: () => void;
}) {
  if (health.length === 0 && !reconnecting && offline === null && !listFailed) return null;
  return (
    <div className="chat-column flex shrink-0 flex-col items-start gap-2 pt-3">
      {health.map((entry) => {
        const failure = describeFailure(entry.lastError ?? "", { unknown: "raw" });
        const severity = entry.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ? "error" : "warn";
        const fixable = onManageProviders !== undefined && (failure.kind === "missing" || failure.kind === "start");
        return (
          <div key={entry.module} className={PILL} role="alert" data-severity={severity}>
            <TriangleAlert className={cn(ICON, severity === "error" ? "text-danger" : "text-warn-foreground")} aria-hidden="true" />
            <span className="min-w-0 truncate" title={failure.raw}>
              {failure.text}
            </span>
            {fixable && (
              <button type="button" className={PILL_ACTION} onClick={onManageProviders}>
                Manage providers…
              </button>
            )}
          </div>
        );
      })}
      {offline !== null && (
        <div className={PILL} role="status" data-severity="info">
          <WifiOff className={cn(ICON, "text-muted-foreground")} aria-hidden="true" />
          <span className="min-w-0 truncate" title={offline}>{offline}</span>
        </div>
      )}
      {listFailed && (
        <div className={PILL} role="status" data-severity="info">
          <Loader2 className={cn(ICON, " text-muted-foreground")} aria-hidden="true" />
          <span>Can't see other devices right now</span>
          <span className="text-muted-foreground">Retrying…</span>
        </div>
      )}
      {reconnecting && (
        <div className={PILL} data-severity="info">
          <Loader2 className={cn(ICON, " text-muted-foreground")} aria-hidden="true" />
          <span>Reconnecting…</span>
        </div>
      )}
    </div>
  );
});
