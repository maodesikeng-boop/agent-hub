import { HEALTH_FAILURE_THRESHOLD, type HealthEntry } from "../../shared/index.ts";
import { describeError } from "../format.ts";

/** 顶部的提醒：守护进程报告的问题（比如找不到 claude）和断线重连。 */
export function Notices({ health, reconnecting }: { health: HealthEntry[]; reconnecting: boolean }) {
  if (health.length === 0 && !reconnecting) return null;
  return (
    <div className="notices">
      {health.map((entry) => {
        const { label, detail } = describeError(entry.lastError ?? "");
        return (
          <div
            key={entry.module}
            className="notice"
            role="alert"
            data-severity={entry.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ? "error" : "warn"}
          >
            <span className="notice-label">{label}</span>
            {detail && <span className="notice-detail">{detail}</span>}
          </div>
        );
      })}
      {reconnecting && (
        <div className="notice" data-severity="info">
          <span className="notice-label">重连中</span>
        </div>
      )}
    </div>
  );
}
