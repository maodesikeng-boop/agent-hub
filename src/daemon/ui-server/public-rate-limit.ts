// 公网入口 /auth 失败双层限流器（docs/mac-app-and-mobile-design.md 第 2.2 节防线 3、第 3.2 节）：
// - 只对 entry.kind === "public" 的 /auth 失败请求计数；
// - 单 IP 每分钟最多失败 PUBLIC_AUTH_IP_MAX_FAILURES（5）次；
// - 全局每小时最多失败 PUBLIC_AUTH_GLOBAL_MAX_FAILURES（30）次；
// - 任一阈值触发后锁定公网 /auth PUBLIC_AUTH_LOCKOUT_MS（15 分钟）；
// - IP 桶数量上限 MAX_PUBLIC_AUTH_IP_BUCKETS（1000），超限时先清过期桶，仍满则按插入顺序淘汰最旧桶（O(1)）。
import {
  MAX_PUBLIC_AUTH_IP_BUCKETS,
  PUBLIC_AUTH_GLOBAL_MAX_FAILURES,
  PUBLIC_AUTH_GLOBAL_WINDOW_MS,
  PUBLIC_AUTH_IP_MAX_FAILURES,
  PUBLIC_AUTH_IP_WINDOW_MS,
  PUBLIC_AUTH_LOCKOUT_MS,
} from "../../shared/index.ts";

export interface PublicAuthRateLimiterOptions {
  now?: () => number;
  onLockout?: (reason: string) => void;
}

export interface PublicAuthRateLimiter {
  /** 当前公网 /auth 是否处于锁定状态。 */
  isLocked(): boolean;
  /** 记录一次公网 /auth 失败；若本次触发锁定或已在锁定中返回 true。 */
  recordFailure(clientIp: string): boolean;
  /** 当前保存的 IP 计数桶个数（测试验证上限用）。 */
  bucketCount(): number;
}

/** 取 x-forwarded-for 首段作为公网客户端标识；没带或为空时归入 "public"。 */
export function extractPublicClientIp(forwardedFor: string | string[] | undefined): string {
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof raw !== "string") return "public";
  const first = raw.split(",", 1)[0]?.trim() ?? "";
  return first !== "" ? first : "public";
}

export function createPublicAuthRateLimiter(options: PublicAuthRateLimiterOptions = {}): PublicAuthRateLimiter {
  const now = options.now ?? Date.now;
  const ipBuckets = new Map<string, { count: number; resetAt: number }>();
  let globalBucket = { count: 0, resetAt: 0 };
  let lockedUntil = 0;

  return {
    isLocked() {
      return now() < lockedUntil;
    },
    recordFailure(clientIp) {
      const at = now();
      const ip = clientIp.trim() || "public";

      if (at >= globalBucket.resetAt) {
        globalBucket = { count: 1, resetAt: at + PUBLIC_AUTH_GLOBAL_WINDOW_MS };
      } else {
        globalBucket.count += 1;
      }

      const existing = ipBuckets.get(ip);
      let ipCount: number;
      if (existing !== undefined && at < existing.resetAt) {
        existing.count += 1;
        ipCount = existing.count;
      } else {
        if (existing !== undefined) ipBuckets.delete(ip);
        if (ipBuckets.size >= MAX_PUBLIC_AUTH_IP_BUCKETS) {
          for (const [key, bucket] of ipBuckets) {
            if (at >= bucket.resetAt) ipBuckets.delete(key);
          }
          while (ipBuckets.size >= MAX_PUBLIC_AUTH_IP_BUCKETS) {
            const oldestKey = ipBuckets.keys().next().value;
            if (oldestKey === undefined) break;
            ipBuckets.delete(oldestKey);
          }
        }
        ipBuckets.set(ip, { count: 1, resetAt: at + PUBLIC_AUTH_IP_WINDOW_MS });
        ipCount = 1;
      }

      if (ipCount >= PUBLIC_AUTH_IP_MAX_FAILURES || globalBucket.count >= PUBLIC_AUTH_GLOBAL_MAX_FAILURES) {
        lockedUntil = at + PUBLIC_AUTH_LOCKOUT_MS;
        const ipTriggered = ipCount >= PUBLIC_AUTH_IP_MAX_FAILURES;
        const reason = ipTriggered
          ? `单 IP（${ip}）1 分钟内失败 ${ipCount} 次`
          : `全局 1 小时内失败 ${globalBucket.count} 次`;
        if (ipTriggered) ipBuckets.delete(ip);
        if (globalBucket.count >= PUBLIC_AUTH_GLOBAL_MAX_FAILURES) globalBucket = { count: 0, resetAt: 0 };
        options.onLockout?.(reason);
        return true;
      }
      return at < lockedUntil;
    },
    bucketCount() {
      return ipBuckets.size;
    },
  };
}
