import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";
import { describeStep, rateLimitedText, STEP_TEXT } from "../step-labels.ts";
import { RetryNotice } from "./RetryNotice.tsx";

/** agent 在忙，或在等额度：消息流里要显示状态。 */
export function hasAgentStatus(session: SessionState | null): boolean {
  return (session?.activity ?? "idle") !== "idle" || isWaitingForQuota(session);
}

/** 省略号（装饰，读屏不读）。动效只靠整句的流光（styles.css 的 .status-shimmer），点本身不另外动。 */
function Dots() {
  return <span aria-hidden="true">...</span>;
}

/**
 * 消息流里这一轮最下面那一行状态（英文）：“Thinking…”“Reading App.tsx…”“Retrying 3/10 in 5s”“Usage limit reached, resets 14:30”
 * “Stopping…”“Running setup…”“Waiting for background command…”。文案在 step-labels.ts。老服务端没有 step 时只显示“Working…”。没有要显示的（空闲、没在等额度）返回 null。
 */
export function AgentStatus({ session }: { session: SessionState | null }) {
  if (!hasAgentStatus(session)) return null;
  const activity = session?.activity ?? "idle";
  const resetsAt = session?.rateLimit?.resetsAt;
  const waiting = isWaitingForQuota(session);
  let text: React.ReactNode;
  let animated = true;
  if (waiting) {
    text = rateLimitedText(resetsAt ? formatResetTime(resetsAt) : null);
    animated = false;
  } else if (activity === "stopping") {
    text = STEP_TEXT.stopping;
  } else if (activity === "preparing") {
    text = STEP_TEXT.preparing;
  } else if (activity === "background") {
    text = STEP_TEXT.background;
  } else if (session?.apiRetry) {
    text = <RetryNotice info={session.apiRetry} />;
  } else {
    text = describeStep(session?.step);
  }
  return (
    <span role="status" aria-label="Status" data-busy={animated} className={animated ? "status-shimmer" : undefined}>
      {text}
      {animated && <Dots />}
    </span>
  );
}
