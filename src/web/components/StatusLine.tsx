import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";

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
    <div className="status-line" role="status" aria-label="状态" data-busy={busy}>
      <span className="status-text">
        {waiting ? (
          <>
            等额度
            {resetsAt ? <span className="status-meta">{formatResetTime(resetsAt)} 恢复</span> : null}
          </>
        ) : activity === "stopping" ? (
          "正在停止"
        ) : session?.currentTool ? (
          <>
            {agentName} 正在运行 <code>{session.currentTool}</code>
          </>
        ) : (
          `${agentName} 正在处理`
        )}
      </span>
      {stopPhase === "failed" && <span className="status-error">停止失败</span>}
      {stoppable && (
        <button
          type="button"
          className="stop-button"
          disabled={activity === "stopping" || stopPhase === "sending" || stopPhase === "requested"}
          onClick={onStop}
        >
          停止
        </button>
      )}
    </div>
  );
}
