import { useEffect, useState } from "react";
import type { ApiRetryInfo } from "../../shared/index.ts";
import { retryCountdownText, retryText } from "../step-labels.ts";

const RETRY_TICK_MS = 1000;

/** 状态行里“Retrying 3/10”，带下次重试的倒计时“in 5s”；鼠标放上去是原始错误。 */
export function RetryNotice({ info }: { info: ApiRetryInfo }) {
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
  return (
    <span title={detail === "" ? undefined : detail}>
      {retryText(info.attempt, info.maxRetries)}
      {seconds > 0 ? <span className="ml-1.5">{retryCountdownText(seconds)}</span> : null}
    </span>
  );
}
