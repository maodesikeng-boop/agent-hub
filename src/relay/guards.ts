// 中继入口的两道闸（Cloudflare 版和自建版共用，docs/account-mesh-design.md「中继」）：按客户端限流、验过的 GitHub token 短暂缓存。
// 只用 lru-cache 和 WebCrypto，两种运行时都能跑；时间一律由调用方传 now，不开定时器（Durable Object 和 Worker 空闲时要能休眠）。
import { LRUCache } from "lru-cache";
import type { AccountLogin } from "../shared/mesh.ts";

/**
 * 限流用的客户端键：IPv4 原样；IPv6 取前 64 位（一台主机能在自己的 /64 里随便换地址，按单个地址记等于不限）；
 * IPv4 映射的 IPv6（::ffff:a.b.c.d）按 IPv4 记。认不出的原样用。
 */
export function clientKeyOf(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped !== null) return mapped[1]!;
  const halves = raw.split("::");
  if (halves.length > 2) return raw;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return raw;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export interface IpRateLimiter {
  /** 这个客户端这次能不能放行；放行就计一次。 */
  allow(key: string, now: number): boolean;
}

export interface IpRateLimiterOptions {
  /** 一个窗口里最多放行几次。 */
  limit: number;
  windowMs: number;
  /** 计数表最多记几个客户端。 */
  max: number;
  /** 封禁表最多记几个客户端。 */
  blockedMax: number;
  /** 计数表满了时，最多隔多久清一次窗口已过的（清一次要扫整张表）。 */
  pruneIntervalMs: number;
}

/**
 * 固定窗口计数。超过上限的客户端挪进单独的封禁表，封到它这个窗口结束：
 * 大量新客户端挤满计数表只会挤掉还没超限的计数（LRU），挤不掉已经封住的；往封禁表里挤，每个键都得先打满一个窗口的上限。
 * 计数表满了先清窗口已过的再收新键，清理按 pruneIntervalMs 节流，持续挤满时也不会每个请求都扫一遍。
 */
export function createIpRateLimiter(options: IpRateLimiterOptions): IpRateLimiter {
  const windows = new LRUCache<string, { start: number; count: number }>({ max: options.max });
  const blocked = new LRUCache<string, number>({ max: options.blockedMax });
  let lastPrune = Number.NEGATIVE_INFINITY;

  const pruneExpired = (now: number) => {
    if (now - lastPrune < options.pruneIntervalMs) return;
    lastPrune = now;
    const expired: string[] = [];
    for (const [key, hit] of windows.entries()) if (now - hit.start >= options.windowMs) expired.push(key);
    for (const key of expired) windows.delete(key);
  };

  return {
    allow(key, now) {
      const until = blocked.get(key);
      if (until !== undefined) {
        if (now < until) return false;
        blocked.delete(key);
      }
      const hit = windows.get(key);
      if (hit !== undefined && now - hit.start < options.windowMs) {
        hit.count++;
        if (hit.count <= options.limit) return true;
        windows.delete(key);
        blocked.set(key, hit.start + options.windowMs);
        return false;
      }
      if (hit === undefined && windows.size >= options.max) pruneExpired(now);
      windows.set(key, { start: now, count: 1 });
      return true;
    },
  };
}

/** token 的 SHA-256（小写十六进制）：缓存只按它存，不留明文。 */
export async function tokenDigest(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifiedTokenCache {
  get(digest: string, now: number): AccountLogin | undefined;
  /** 只存验过的；验不过、GitHub 出错的不存。 */
  set(digest: string, login: AccountLogin, now: number): void;
}

/** 验过的 token（按摘要）→ 登录身份，ttlMs 内同一个 token 再登记不再问 GitHub；最多 max 个，满了淘汰最久没用的。 */
export function createVerifiedTokenCache(options: { max: number; ttlMs: number }): VerifiedTokenCache {
  const cache = new LRUCache<string, { login: AccountLogin; expires: number }>({ max: options.max });
  return {
    get(digest, now) {
      const hit = cache.get(digest);
      if (hit === undefined) return undefined;
      if (now >= hit.expires) {
        cache.delete(digest);
        return undefined;
      }
      return hit.login;
    },
    set(digest, login, now) {
      cache.set(digest, { login, expires: now + options.ttlMs });
    },
  };
}
