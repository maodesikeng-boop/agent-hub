// 会话令牌（hub.ts 的 SessionTokens）：只在内存里，盘上不落；守护进程重启后全部作废。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HUB_TOKEN_BYTES, SessionTokenRevokedError, type SessionId, type SessionTokens } from "../../shared/index.ts";

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createSessionTokens(): SessionTokens {
  /** 会话 → 令牌原文（issue 要返回同一个）和它的摘要（resolve 比的是摘要）。 */
  const live = new Map<SessionId, { token: string; digest: Buffer }>();
  /** revoke 过的会话：再 issue 就抛错。 */
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
      // 定长比较：各取 sha256 再逐个 timingSafeEqual，不提前退出，不泄露长度和前缀。
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
