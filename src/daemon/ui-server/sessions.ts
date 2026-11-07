// 浏览器登录（联机 P6，docs/multi-device-design.md 第 3.4 节）：
// - 会话：每个浏览器一条，存在库里（migrations/0015）。令牌是随机的，只存它的 sha256；id 是列表和单个退出用的编号，和令牌无关。
// - 登录链接：给手机扫的一次性链接，5 分钟有效、用一次就失效。只放内存（守护进程一重启就都作废，本来也只有 5 分钟），也只存哈希。
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

/** 令牌和链接码：32 字节随机，base64url 编码成 43 个字符。 */
const newSecret = () => randomBytes(32).toString("base64url");
const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** 列表里的一条（没有 current：那取决于是谁在问）。 */
export type StoredBrowserSession = Omit<BrowserSessionInfo, "current">;

export interface BrowserSessions {
  /** 新登录一个浏览器：返回要放进 cookie 的令牌（明文只此一次）和会话 id。满了挤掉最久没用的。 */
  create(input: { userAgent: string; entry: string }): { id: string; token: string };
  /** 按 cookie 里的令牌找会话：认不出（没有、被退出了、太久没用）是 null。最后活动按 SESSION_TOUCH_INTERVAL_MS 更新。 */
  authenticate(token: string | undefined): { id: string } | null;
  /** 按最后活动从新到旧。 */
  list(): StoredBrowserSession[];
  /** 退出一个：没有这个 id 是 false。下一个请求就认不出它的 cookie。 */
  revoke(id: string): boolean;
  /** 全部退出。 */
  revokeAll(): void;
}

interface Row {
  id: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
}

/** User-Agent 是浏览器自己报的：去掉控制字符，按字符截到上限。 */
function cleanUserAgent(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "")].slice(0, MAX_USER_AGENT_CHARS).join("");
}

export function createBrowserSessions(db: Db, options: Clock = {}): BrowserSessions {
  const now = options.now ?? Date.now;
  return {
    create({ userAgent, entry }) {
      const id = randomBytes(16).toString("base64url");
      const token = newSecret();
      const at = now();
      db.transaction(() => {
        db.run("INSERT INTO browser_sessions (id, token_hash, user_agent, entry, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)", id, hashOf(token), cleanUserAgent(userAgent), entry, at, at);
        db.run(
          "DELETE FROM browser_sessions WHERE id IN (SELECT id FROM browser_sessions ORDER BY last_seen_at DESC, created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
          MAX_BROWSER_SESSIONS,
        );
      });
      return { id, token };
    },
    authenticate(token) {
      if (typeof token !== "string" || token === "") return null;
      const row = db.get<Row>("SELECT id, user_agent, created_at, last_seen_at FROM browser_sessions WHERE token_hash = ?", hashOf(token));
      if (row === undefined) return null;
      const at = now();
      if (at - row.last_seen_at > SESSION_MAX_AGE_MS) {
        db.run("DELETE FROM browser_sessions WHERE id = ?", row.id);
        return null;
      }
      if (at - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) db.run("UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?", at, row.id);
      return { id: row.id };
    },
    list() {
      return db
        .all<Row>("SELECT id, user_agent, created_at, last_seen_at FROM browser_sessions ORDER BY last_seen_at DESC, created_at DESC, rowid DESC")
        .map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
    },
    revoke(id) {
      return db.run("DELETE FROM browser_sessions WHERE id = ?", id).changes > 0;
    },
    revokeAll() {
      db.run("DELETE FROM browser_sessions");
    },
  };
}

export interface LoginLinks {
  /** 发一个新的：code 放进链接，expiresAt 是毫秒时间戳。 */
  issue(): { code: string; expiresAt: number };
  /** 用掉一个：对、没过期、没用过才是 true，用过就作废（对不对都先删，同一个码不会有第二次机会）。 */
  consume(code: unknown): boolean;
  /** 全部作废（换主钥匙时）。 */
  clear(): void;
}

export function createLoginLinks(options: Clock = {}): LoginLinks {
  const now = options.now ?? Date.now;
  // 哈希 → 过期时间；Map 按插入顺序，最早发的在最前
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
