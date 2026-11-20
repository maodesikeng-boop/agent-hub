import { useMemo } from "react";
import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";
import { describeStep, rateLimitedText, STEP_TEXT } from "../step-labels.ts";
import { RetryNotice } from "./RetryNotice.tsx";

export function hasAgentStatus(session: SessionState | null): boolean {
  return (session?.activity ?? "idle") !== "idle" || isWaitingForQuota(session);
}

// Rebuild only when status fields change so streaming text deltas keep the same node reference.
export function useAgentStatusNode(session: SessionState | null): React.ReactNode {
  const statusKey = session === null ? "" : JSON.stringify([session.activity, session.step, session.apiRetry, session.rateLimit]);
  return useMemo(() => (hasAgentStatus(session) ? <AgentStatus session={session} /> : null), [statusKey]);
}

function Dots() {
  return <span aria-hidden="true">...</span>;
}

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
