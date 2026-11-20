// Callers pass `now` and nothing starts timers, so Workers and Durable Objects can hibernate.
import { LRUCache } from "lru-cache";
import type { AccountLogin } from "../shared/mesh.ts";

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
  allow(key: string, now: number): boolean;
}

export interface IpRateLimiterOptions {
  limit: number;
  windowMs: number;
  max: number;
  blockedMax: number;
  pruneIntervalMs: number;
}

export function createIpRateLimiter(options: IpRateLimiterOptions): IpRateLimiter {
  const fresh = new LRUCache<string, number>({ max: options.max });
  const counting = new Map<string, { start: number; count: number }>();
  const blocked = new LRUCache<string, number>({ max: options.blockedMax });
  let lastPrune = Number.NEGATIVE_INFINITY;

  const pruneExpired = (now: number) => {
    if (now - lastPrune < options.pruneIntervalMs) return;
    lastPrune = now;
    for (const [key, hit] of counting) if (now - hit.start >= options.windowMs) counting.delete(key);
  };
  const count = (key: string, hit: { start: number; count: number }): boolean => {
    if (hit.count <= options.limit) {
      counting.set(key, hit);
      return true;
    }
    counting.delete(key);
    blocked.set(key, hit.start + options.windowMs);
    return false;
  };

  return {
    allow(key, now) {
      const until = blocked.get(key);
      if (until !== undefined) {
        if (now < until) return false;
        blocked.delete(key);
      }
      const live = (start: number) => now - start < options.windowMs;
      const hit = counting.get(key);
      if (hit !== undefined) {
        if (live(hit.start)) return count(key, { start: hit.start, count: hit.count + 1 });
        counting.delete(key);
      }
      const start = fresh.get(key);
      if (start === undefined || !live(start)) {
        fresh.set(key, now);
        return true;
      }
      if (counting.size >= options.max) pruneExpired(now);
      if (counting.size >= options.max) return false;
      fresh.delete(key);
      return count(key, { start, count: 2 });
    },
  };
}

export async function tokenDigest(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifiedTokenCache {
  get(digest: string, now: number): AccountLogin | undefined;
  set(digest: string, login: AccountLogin, now: number): void;
}

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
