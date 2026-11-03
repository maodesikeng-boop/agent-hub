import { Loader2, Square } from "lucide-react";
import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";
import { Button } from "../ui/button.tsx";

export type StopPhase = "idle" | "sending" | "requested" | "failed";

/** 消息流底部的一行：agent 在做什么、等额度，以及“停止”。 */
export function StatusLine({
  agentName,
  session,
  stopPhase,
  onStop,
}: {
  agentName: string;
  session: SessionState | null;
  stopPhase: StopPhase;
  onStop: () => void;
}) {
  const activity = session?.activity ?? "idle";
  const waiting = isWaitingForQuota(session);
  if (activity === "idle" && !waiting) return null;
  const resetsAt = session?.rateLimit?.resetsAt;
  const stoppable = activity !== "idle";
  const busy = activity === "working";
  return (
    <div
      className="flex min-h-11 items-center gap-2.5 rounded-full bg-muted py-1.5 pr-1.5 pl-4 text-[13.5px]"
      role="status"
      aria-label="状态"
      data-busy={busy}
    >
      {busy && <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">
        {waiting ? (
          <>
            等额度
            {resetsAt ? <span className="ml-2 text-muted-foreground">{formatResetTime(resetsAt)} 恢复</span> : null}
          </>
        ) : activity === "stopping" ? (
          "正在停止"
        ) : session?.currentTool ? (
          <>
            {agentName} 正在运行{" "}
            <code className="rounded-md bg-background px-1.5 py-0.5 ring-1 ring-black/5">{session.currentTool}</code>
          </>
        ) : (
          `${agentName} 正在处理`
        )}
      </span>
      {stopPhase === "failed" && <span className="shrink-0 text-danger">停止失败</span>}
      {stoppable && (
        <Button
          variant="outline"
          size="sm"
          className="border-primary/30 text-primary hover:bg-primary/5"
          disabled={activity === "stopping" || stopPhase === "sending" || stopPhase === "requested"}
          onClick={onStop}
        >
          <Square className="size-3 fill-current" aria-hidden="true" />
          停止
        </Button>
      )}
    </div>
  );
}
