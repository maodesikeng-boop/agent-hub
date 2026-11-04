import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";
import { describeStep, STEP_TEXT } from "../step-labels.ts";
import { RetryNotice } from "./RetryNotice.tsx";

/** agent 在忙，或在等额度：头像旁要显示状态。 */
export function hasAgentStatus(session: SessionState | null): boolean {
  return (session?.activity ?? "idle") !== "idle" || isWaitingForQuota(session);
}

/** 省略号：三个点依次淡入淡出（系统设了“减少动态效果”就不动）。 */
function Dots() {
  return (
    <span aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="motion-safe:animate-pulse" style={{ animationDelay: `${i * 200}ms` }}>
          .
        </span>
      ))}
    </span>
  );
}

/**
 * 头像旁的一小段状态：“在思考…”“在读 App.tsx…”“网络出错，正在重试（第 3/10 次）”“等额度，14:30 恢复”“正在停止…”“正在跑准备命令…”。
 * 文案映射在 step-labels.ts。老服务端没有 step 时只显示“在处理”。没有要显示的（空闲、没在等额度）返回 null。
 */
export function AgentStatus({ session }: { session: SessionState | null }) {
  if (!hasAgentStatus(session)) return null;
  const activity = session?.activity ?? "idle";
  const resetsAt = session?.rateLimit?.resetsAt;
  const waiting = isWaitingForQuota(session);
  let text: React.ReactNode;
  let animated = true;
  if (waiting) {
    text = resetsAt ? `等额度，${formatResetTime(resetsAt)} 恢复` : "等额度";
    animated = false;
  } else if (activity === "stopping") {
    text = STEP_TEXT.stopping;
  } else if (activity === "preparing") {
    text = STEP_TEXT.preparing;
  } else if (session?.apiRetry) {
    text = <RetryNotice info={session.apiRetry} />;
  } else {
    text = describeStep(session?.step);
  }
  return (
    <span role="status" aria-label="状态" data-busy={animated}>
      {text}
      {animated && <Dots />}
    </span>
  );
}
