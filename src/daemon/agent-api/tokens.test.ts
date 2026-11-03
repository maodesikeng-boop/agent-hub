import { describe, expect, it } from "vitest";
import { HUB_TOKEN_BYTES, SessionTokenRevokedError } from "../../shared/index.ts";
import { createSessionTokens } from "./tokens.ts";

describe("SessionTokens", () => {
  it("issues a base64url token of HUB_TOKEN_BYTES random bytes that resolves to its session", () => {
    const tokens = createSessionTokens();
    const token = tokens.issue(7);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(HUB_TOKEN_BYTES);
    expect(tokens.resolve(token)).toBe(7);
  });

  it("returns the same token when the same session is issued again", () => {
    const tokens = createSessionTokens();
    const first = tokens.issue(1);
    expect(tokens.issue(1)).toBe(first);
    expect(tokens.resolve(first)).toBe(1);
  });

  it("gives different sessions different tokens", () => {
    const tokens = createSessionTokens();
    const a = tokens.issue(1);
    const b = tokens.issue(2);
    expect(a).not.toBe(b);
    expect(tokens.resolve(a)).toBe(1);
    expect(tokens.resolve(b)).toBe(2);
  });

  it("resolves unknown, empty and near-miss tokens to null", () => {
    const tokens = createSessionTokens();
    const token = tokens.issue(1);
    expect(tokens.resolve("")).toBeNull();
    expect(tokens.resolve("nope")).toBeNull();
    expect(tokens.resolve(`${token}x`)).toBeNull();
    expect(tokens.resolve(token.slice(0, -1))).toBeNull();
  });

  it("revoke makes the token stop resolving and leaves other sessions alone", () => {
    const tokens = createSessionTokens();
    const a = tokens.issue(1);
    const b = tokens.issue(2);
    tokens.revoke(1);
    expect(tokens.resolve(a)).toBeNull();
    expect(tokens.resolve(b)).toBe(2);
  });

  it("throws when a revoked session is issued again", () => {
    const tokens = createSessionTokens();
    tokens.issue(1);
    tokens.revoke(1);
    expect(() => tokens.issue(1)).toThrow(SessionTokenRevokedError);
  });

  it("remembers a revoke even if the session never had a token", () => {
    const tokens = createSessionTokens();
    tokens.revoke(3);
    expect(() => tokens.issue(3)).toThrow();
  });

  it("separate instances do not share tokens (a restart invalidates everything)", () => {
    const before = createSessionTokens();
    const token = before.issue(1);
    const after = createSessionTokens();
    expect(after.resolve(token)).toBeNull();
    expect(after.issue(1)).not.toBe(token);
  });
});
