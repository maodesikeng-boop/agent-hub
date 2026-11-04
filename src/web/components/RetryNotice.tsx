import { useEffect, useState } from "react";
import type { ApiRetryInfo } from "../../shared/index.ts";

/** 状态行里“网络出错，正在重试（第 3/10 次）”，带下次重试的倒计时；鼠标放上去是 Claude 给的原始错误。 */
export function RetryNotice({ info }: { info: ApiRetryInfo }) {
  const [, tick] = useState(0);
  const { retryAt } = info;
  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      tick((n) => n + 1);
      if (retryAt <= Date.now()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = retryAt === null ? 0 : Math.ceil((retryAt - Date.now()) / 1000);
  const detail = [info.errorStatus, info.error].filter((x) => x !== null && x !== "").join(" ");
  return (
    <span title={detail === "" ? undefined : detail}>
      网络出错，正在重试（第 {info.attempt}/{info.maxRetries} 次）
      {seconds > 0 ? <span className="ml-2 text-muted-foreground">{seconds} 秒后重试</span> : null}
    </span>
  );
}
