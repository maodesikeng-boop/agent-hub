import type { ApiRetryInfo } from "../../shared/index.ts";
import { SECOND_TICK_MS } from "../limits.ts";
import { retryCountdownText, retryText } from "../step-labels.ts";
import { useNow } from "../useNow.ts";
import { StatusShimmer } from "./StatusShimmer.tsx";

export function RetryNotice({ info, shimmer = false }: { info: ApiRetryInfo; shimmer?: boolean }) {
  const { retryAt } = info;
  const now = useNow(SECOND_TICK_MS, retryAt);
  const seconds = retryAt === null ? 0 : Math.ceil((retryAt - now) / SECOND_TICK_MS);
  const detail = [info.errorStatus, info.error].filter((x) => x !== null && x !== "").join(" ");
  const label = retryText(info.attempt, info.maxRetries);
  const countdown = seconds > 0 ? retryCountdownText(seconds) : null;
  return (
    <span title={detail === "" ? undefined : detail}>
      {shimmer ? <StatusShimmer text={label} /> : <span>{label}</span>}
      {countdown !== null ? (
        shimmer ? <StatusShimmer text={countdown} className="ml-1.5" /> : <span className="ml-1.5">{countdown}</span>
      ) : null}
    </span>
  );
}
