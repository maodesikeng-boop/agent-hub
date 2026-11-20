import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HUB_TOKEN_BYTES, SessionTokenRevokedError, type SessionId, type SessionTokens } from "../../shared/index.ts";

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createSessionTokens(): SessionTokens {
  const live = new Map<SessionId, { token: string; digest: Buffer }>();
  const revoked = new Set<SessionId>();

  return {
    issue(sessionId) {
      if (revoked.has(sessionId)) throw new SessionTokenRevokedError(sessionId);
      const existing = live.get(sessionId);
      if (existing !== undefined) return existing.token;
      const token = randomBytes(HUB_TOKEN_BYTES).toString("base64url");
      live.set(sessionId, { token, digest: digest(token) });
      return token;
    },

    resolve(token) {
      if (typeof token !== "string" || token.length === 0) return null;
      const given = digest(token);
      let found: SessionId | null = null;
      for (const [sessionId, entry] of live) {
        if (timingSafeEqual(entry.digest, given)) found = sessionId;
      }
      return found;
    },

    revoke(sessionId) {
      live.delete(sessionId);
      revoked.add(sessionId);
    },
  };
}
