import type { VendorSyncHostBound } from "../../shared/index.ts";

export function HostBoundNote({ hostBound }: { hostBound: VendorSyncHostBound }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        {hostBound.sources.map((source) => (
          <span key={source.vendor} className="rounded-sm border border-border bg-panel px-2.5 py-0.5 text-xs font-medium text-foreground">
            From {source.label}
          </span>
        ))}
        {hostBound.app && (
          <span className="rounded-sm border border-border bg-panel px-2.5 py-0.5 text-xs font-medium text-foreground">{hostBound.app} app</span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{hostBound.reason}</span>
    </span>
  );
}
