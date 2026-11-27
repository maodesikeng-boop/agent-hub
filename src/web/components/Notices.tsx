import { Loader2, TriangleAlert, WifiOff } from "../ui/icons.ts";
import { memo } from "react";
import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import { offlineNoticeText, type OfflineNotice } from "../devices.ts";
import { MINUTE_TICK_MS } from "../limits.ts";
import { cn } from "../lib/utils.ts";
import { useNow } from "../useNow.ts";

const PILL = "flex w-fit max-w-full items-center gap-2 rounded-sm border border-border bg-panel px-4 py-2 text-minor text-foreground";
const ICON = "size-4 shrink-0";
const PILL_ACTION = "touch-target shrink-0 cursor-pointer font-medium text-brand-ink underline decoration-brand-ink/40 underline-offset-3 hover:decoration-brand-ink focus-visible:outline-2 focus-visible:outline-border-focus";

function OfflinePill({ notice }: { notice: OfflineNotice }) {
  const text = offlineNoticeText(notice, useNow(MINUTE_TICK_MS));
  return (
    <div className={PILL} role="status" data-severity="info">
      <WifiOff className={cn(ICON, "text-muted-foreground")} aria-hidden="true" />
      <span className="min-w-0 truncate" title={text}>{text}</span>
    </div>
  );
}

export const Notices = memo(function Notices({
  health,
  reconnecting,
  offline = null,
  listFailed = false,
  onManageProviders,
}: {
  health: HealthEntry[];
  reconnecting: boolean;
  offline?: OfflineNotice | null;
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
      {offline !== null && <OfflinePill notice={offline} />}
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
