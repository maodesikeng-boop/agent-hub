import { describe, expect, it } from "vitest";
import type { AccountLogin } from "../shared/mesh.ts";
import { clientKeyOf, createIpRateLimiter, createVerifiedTokenCache, tokenDigest } from "./guards.ts";

describe("clientKeyOf", () => {
  it("IPv4 原样，IPv6 取 /64，IPv4 映射地址按 IPv4", () => {
    expect(clientKeyOf(" 198.51.100.7 ")).toBe("198.51.100.7");
    expect(clientKeyOf("2001:db8:77:1:abcd::1")).toBe("2001:db8:77:1::/64");
    expect(clientKeyOf("2001:0DB8:0077:0001:ffff:ffff:ffff:ffff")).toBe("2001:db8:77:1::/64");
    expect(clientKeyOf("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(clientKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(clientKeyOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKeyOf("unknown")).toBe("unknown");
    expect(clientKeyOf("1::2::3")).toBe("1::2::3");
  });
});

describe("createIpRateLimiter", () => {
  const options = { limit: 3, windowMs: 1_000, max: 4, blockedMax: 4, pruneIntervalMs: 100 };

  it("窗口内超过上限拒绝，直到这个窗口结束", () => {
    const limiter = createIpRateLimiter(options);
    expect([0, 1, 2, 3].map((t) => limiter.allow("a", t))).toEqual([true, true, true, false]);
    expect(limiter.allow("a", 999)).toBe(false);
    expect(limiter.allow("a", 1_000)).toBe(true);
  });

  it("新键挤满计数表只挤掉没超限的计数，封住的键照样封着", () => {
    const limiter = createIpRateLimiter(options);
    for (let i = 0; i < 4; i++) limiter.allow("abuser", i);
    expect(limiter.allow("abuser", 5)).toBe(false);
    for (let i = 0; i < 100; i++) expect(limiter.allow(`k${i}`, 10)).toBe(true);
    expect(limiter.allow("abuser", 11)).toBe(false);
  });

  it("计数表满了先清窗口已过的，还在窗口里的计数不被冲掉", () => {
    const limiter = createIpRateLimiter({ ...options, max: 3 });
    limiter.allow("old1", 0);
    limiter.allow("old2", 0);
    limiter.allow("live", 900);
    limiter.allow("live", 900);
    limiter.allow("live", 900);
    // old1、old2 的窗口已过：清掉它们腾位置，live 的计数（已经 3 次）留着
    expect(limiter.allow("new", 1_100)).toBe(true);
    expect(limiter.allow("live", 1_100)).toBe(false);
  });
});

describe("createVerifiedTokenCache", () => {
  const login: AccountLogin = { provider: "github", userId: "1", login: "alice" };

  it("按摘要存、到期作废、满了淘汰最久没用的", async () => {
    const cache = createVerifiedTokenCache({ max: 2, ttlMs: 1_000 });
    const a = await tokenDigest("tok_a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("tok_a");
    cache.set(a, login, 0);
    expect(cache.get(a, 999)).toEqual(login);
    expect(cache.get(a, 1_000)).toBeUndefined();
    cache.set(a, login, 2_000);
    cache.set(await tokenDigest("tok_b"), login, 2_000);
    cache.set(await tokenDigest("tok_c"), login, 2_000);
    expect(cache.get(a, 2_001)).toBeUndefined();
  });
});
