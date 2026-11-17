import { Loader2, TriangleAlert, WifiOff } from "lucide-react";
import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import { cn } from "../lib/utils.ts";

// 提示条一律中性浅灰底（docs/ui-standard.md 第 4 条）：不加阴影、描边和彩色底；轻重只看图标的颜色（出错红、提醒琥珀、其余灰），字是前景色
const PILL = "flex w-fit max-w-full items-center gap-2 rounded-full bg-muted px-4 py-2 text-minor text-foreground";
const ICON = "size-4 shrink-0";
// 提示条里的动作：带下划线的文字按钮，和只读的那句分得开
const PILL_ACTION = "touch-target shrink-0 cursor-pointer rounded-full font-medium underline decoration-foreground/30 underline-offset-3 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * 顶部的提醒：守护进程报告的问题（比如找不到 claude）、断线重连、别的设备离线（offline 是那一句，联机第 4.3 节；不报错弹窗）。
 * 靠左放在对话列里，和消息同一条左边线。厂商没装、起不来这类要去设置里处理的，后面带 `Manage providers…`。
 */
export function Notices({
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
        // 和消息里的失败同一套说法（errors.ts）；健康状态按模块记、不属于某个会话，厂商看错误码（codex_not_found……）认
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
          <Loader2 className={cn(ICON, "animate-spin text-muted-foreground")} aria-hidden="true" />
          <span>Can't see other devices right now</span>
          <span className="text-muted-foreground">Retrying…</span>
        </div>
      )}
      {reconnecting && (
        <div className={PILL} data-severity="info">
          <Loader2 className={cn(ICON, "animate-spin text-muted-foreground")} aria-hidden="true" />
          <span>Reconnecting…</span>
        </div>
      )}
    </div>
  );
}
