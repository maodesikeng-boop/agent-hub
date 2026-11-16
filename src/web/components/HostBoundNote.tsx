// Vendor sync 预览里「别家应用自带的 MCP」的来源与原因：来源厂商、所属应用各一个标签，下面一行原因。桌面弹窗与手机页共用。
import type { VendorSyncHostBound } from "../../shared/index.ts";

export function HostBoundNote({ hostBound }: { hostBound: VendorSyncHostBound }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        {hostBound.sources.map((source) => (
          <span key={source.vendor} className="rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium text-foreground/80">
            From {source.label}
          </span>
        ))}
        {hostBound.app && (
          <span className="rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium text-foreground/80">{hostBound.app} app</span>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{hostBound.reason}</span>
    </span>
  );
}
