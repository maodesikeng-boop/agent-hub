import { createHash, randomBytes } from "node:crypto";
import {
  LOGIN_LINK_TTL_MS,
  MAX_BROWSER_SESSIONS,
  MAX_PENDING_LOGIN_LINKS,
  MAX_USER_AGENT_CHARS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type BrowserSessionInfo,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";

type Clock = { now?: () => number };

const newSecret = () => randomBytes(32).toString("base64url");
const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

export interface BrowserSessions {
  create(input: { userAgent: string; entry: string }): { id: string; token: string; evicted: string[] };
  authenticate(token: string | undefined): { id: string } | null;
  list(): Array<Omit<BrowserSessionInfo, "current">>;
  revoke(id: string): boolean;
  revokeAll(): void;
}

function cleanUserAgent(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "")].slice(0, MAX_USER_AGENT_CHARS).join("");
}

export function createBrowserSessions(db: Db, options: Clock = {}): BrowserSessions {
  const now = options.now ?? Date.now;
  const deleteById = (id: string): boolean => db.run("DELETE FROM browser_sessions WHERE id = ?", id).changes > 0;

  return {
    create({ userAgent, entry }) {
      const id = randomBytes(16).toString("base64url");
      const token = newSecret();
      const at = now();
      let evicted: string[] = [];
      db.transaction(() => {
        db.run(
          "INSERT INTO browser_sessions (id, token_hash, user_agent, entry, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          hashOf(token),
          cleanUserAgent(userAgent),
          entry,
          at,
          at,
        );
        const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM browser_sessions")?.n ?? 0;
        if (total > MAX_BROWSER_SESSIONS) {
          evicted = db
            .all<{ id: string }>("SELECT id FROM browser_sessions ORDER BY last_seen_at ASC, created_at ASC, rowid ASC LIMIT ?", total - MAX_BROWSER_SESSIONS)
            .map((r) => r.id);
          for (const evictedId of evicted) deleteById(evictedId);
        }
      });
      return { id, token, evicted };
    },
    authenticate(token) {
      if (typeof token !== "string" || token === "") return null;
      const row = db.get<{ id: string; last_seen_at: number }>("SELECT id, last_seen_at FROM browser_sessions WHERE token_hash = ?", hashOf(token));
      if (row === undefined) return null;
      const at = now();
      if (at - row.last_seen_at > SESSION_MAX_AGE_MS) {
        deleteById(row.id);
        return null;
      }
      if (at - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
        db.run("UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?", at, row.id);
      }
      return { id: row.id };
    },
    list() {
      return db
        .all<{ id: string; user_agent: string; created_at: number; last_seen_at: number }>(
          "SELECT id, user_agent, created_at, last_seen_at FROM browser_sessions ORDER BY last_seen_at DESC, created_at DESC, rowid DESC",
        )
        .map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
    },
    revoke(id) {
      return deleteById(id);
    },
    revokeAll() {
      db.run("DELETE FROM browser_sessions");
    },
  };
}

export interface LoginLinks {
  issue(): { code: string; expiresAt: number };
  /** Delete the code before checking it so each code gets exactly one attempt. */
  consume(code: unknown): boolean;
  clear(): void;
}

export function createLoginLinks(options: Clock = {}): LoginLinks {
  const now = options.now ?? Date.now;
  const pending = new Map<string, number>();
  return {
    issue() {
      const at = now();
      for (const [hash, expiresAt] of pending) if (expiresAt <= at) pending.delete(hash);
      while (pending.size >= MAX_PENDING_LOGIN_LINKS) pending.delete(pending.keys().next().value!);
      const code = newSecret();
      const expiresAt = at + LOGIN_LINK_TTL_MS;
      pending.set(hashOf(code), expiresAt);
      return { code, expiresAt };
    },
    consume(code) {
      if (typeof code !== "string" || code === "") return false;
      const hash = hashOf(code);
      const expiresAt = pending.get(hash);
      pending.delete(hash);
      return expiresAt !== undefined && now() < expiresAt;
    },
    clear() {
      pending.clear();
    },
  };
}
