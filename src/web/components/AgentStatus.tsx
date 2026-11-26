import { useMemo } from "react";
import type { SessionState } from "../../shared/index.ts";
import { formatResetTime } from "../format.ts";
import { isWaitingForQuota } from "../selectors.ts";
import { describeStep, rateLimitedText, STEP_TEXT } from "../step-labels.ts";
import { RetryNotice } from "./RetryNotice.tsx";
import { ShimmerOverlay } from "./StatusShimmer.tsx";

export function hasAgentStatus(session: SessionState | null): boolean {
  return (session?.activity ?? "idle") !== "idle" || isWaitingForQuota(session);
}

export function actionStartedAt(session: SessionState | null): number | null {
  if (!hasAgentStatus(session) || isWaitingForQuota(session) || session?.apiRetry) return null;
  const at = session?.stepStartedAt;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

// Rebuild only when status fields change so streaming text deltas keep the same node reference.
export function useAgentStatusNode(session: SessionState | null): React.ReactNode {
  const statusKey = session === null ? "" : JSON.stringify([session.activity, session.step, session.stepStartedAt ?? null, session.apiRetry, session.rateLimit]);
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
  let shimmerText: string | null = null;
  let animated = true;
  if (waiting) {
    text = rateLimitedText(resetsAt ? formatResetTime(resetsAt) : null);
    animated = false;
  } else if (activity === "stopping") {
    shimmerText = STEP_TEXT.stopping;
    text = shimmerText;
  } else if (activity === "preparing") {
    shimmerText = STEP_TEXT.preparing;
    text = shimmerText;
  } else if (activity === "background") {
    shimmerText = STEP_TEXT.background;
    text = shimmerText;
  } else if (session?.apiRetry) {
    text = <RetryNotice info={session.apiRetry} shimmer />;
  } else {
    shimmerText = describeStep(session?.step);
    text = shimmerText;
  }
  return (
    <span role="status" aria-label="Status" data-busy={animated} className={animated ? "status-shimmer" : undefined}>
      {text}
      {animated && <Dots />}
      {animated && shimmerText !== null && <ShimmerOverlay text={`${shimmerText}...`} />}
    </span>
  );
}
