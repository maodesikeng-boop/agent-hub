import { useEffect, useState } from "react";
import type { ApiRetryInfo } from "../../shared/index.ts";
import { retryCountdownText, retryText } from "../step-labels.ts";
import { ShimmerOverlay } from "./StatusShimmer.tsx";

const RETRY_TICK_MS = 1000;

export function RetryNotice({ info, shimmer = false }: { info: ApiRetryInfo; shimmer?: boolean }) {
  const [, tick] = useState(0);
  const { retryAt } = info;
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      tick((n) => n + 1);
      if (retryAt <= Date.now()) clearInterval(timer);
    }, RETRY_TICK_MS);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = retryAt === null ? 0 : Math.ceil((retryAt - Date.now()) / RETRY_TICK_MS);
  const detail = [info.errorStatus, info.error].filter((x) => x !== null && x !== "").join(" ");
  const label = retryText(info.attempt, info.maxRetries);
  const countdown = seconds > 0 ? retryCountdownText(seconds) : null;
  return (
    <span title={detail === "" ? undefined : detail}>
      <span className="relative inline-block">
        {label}
        {shimmer && <ShimmerOverlay text={label} />}
      </span>
      {countdown !== null ? (
        <span className="relative ml-1.5 inline-block">
          {countdown}
          {shimmer && <ShimmerOverlay text={countdown} />}
        </span>
      ) : null}
    </span>
  );
}
