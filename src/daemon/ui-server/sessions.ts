// 浏览器登录（联机 P6，docs/multi-device-design.md 第 3.4 节；公网入口防线 docs/mac-app-and-mobile-design.md 第 2.2 节）：
// - 会话：每个浏览器一条，存在库里（migrations/0015 与 0017）。令牌是随机的，只存它的 sha256；id 是列表和单个退出用的编号，和令牌无关。
// - 公网会话（viaPublic）：在附属表 browser_session_public 记录 status（'pending_approval' | 'active'）与 client_ip；
//   扫码后先处于 pending_approval（10 分钟内须已登录设备点“允许”），不活动有效期 30 天，满 100 条淘汰时优先淘汰 pending_approval。
// - 登录链接：给手机扫的一次性链接，5 分钟有效、用一次就失效。只放内存（守护进程一重启就都作废，本来也只有 5 分钟），也只存哈希。
import { createHash, randomBytes } from "node:crypto";
import {
  LOGIN_LINK_TTL_MS,
  MAX_BROWSER_SESSIONS,
  MAX_PENDING_LOGIN_LINKS,
  MAX_USER_AGENT_CHARS,
  PENDING_SESSION_TTL_MS,
  PUBLIC_SESSION_MAX_AGE_MS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type BrowserSessionInfo,
  type BrowserSessionStatus,
} from "../../shared/index.ts";
import type { Db } from "../store/index.ts";

type Clock = { now?: () => number };

/** 令牌和链接码：32 字节随机，base64url 编码成 43 个字符。 */
const newSecret = () => randomBytes(32).toString("base64url");
const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

export interface CreateBrowserSessionOptions {
  viaPublic?: boolean;
  clientIp?: string;
}

export interface CreateBrowserSessionInput extends CreateBrowserSessionOptions {
  userAgent: string;
  entry: string;
}

export interface AuthenticatedBrowserSession {
  id: string;
  status: BrowserSessionStatus;
  viaPublic: boolean;
}

/** 列表里的一条（没有 current：那取决于是谁在问）。 */
export interface StoredBrowserSession extends Omit<BrowserSessionInfo, "current" | "status" | "viaPublic"> {
  status: BrowserSessionStatus;
  viaPublic: boolean;
}

export interface BrowserSessions {
  /** 新登录一个浏览器：返回要放进 cookie 的令牌（明文只此一次）和会话 id。满了优先淘汰 pending_approval，其次最久没用的，被挤掉的 id 放在 evicted 里（调用方要当成被撤销处理：关它的 WebSocket）。 */
  create(
    inputOrUserAgent: CreateBrowserSessionInput | string,
    entryOrOpts?: string | CreateBrowserSessionOptions,
    opts?: CreateBrowserSessionOptions,
  ): { id: string; token: string; status: BrowserSessionStatus; viaPublic: boolean; evicted: string[] };
  /** 按 cookie 里的令牌找会话：认不出（没有、被退出了、太久没用、待批准超时）是 null。最后活动按 SESSION_TOUCH_INTERVAL_MS 更新。 */
  authenticate(token: string | undefined): AuthenticatedBrowserSession | null;
  /** 将公网待批准（pending_approval）会话改为 active。不存在或已超时返回 false。 */
  approve(id: string): boolean;
  /** 删除全部公网（viaPublic）会话并返回被删的 sessionId 列表（供 server.ts 调 closeSockets 当场掐断 WebSocket）。 */
  revokePublic(): string[];
  /** 按最后活动从新到旧。 */
  list(): StoredBrowserSession[];
  /** 退出一个：没有这个 id 是 false。下一个请求就认不出它的 cookie。 */
  revoke(id: string): boolean;
  /** 全部退出。 */
  revokeAll(): void;
}

interface JoinedRow {
  id: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  public_status: string | null;
  client_ip: string | null;
}

/** User-Agent 是浏览器自己报的：去掉控制字符，按字符截到上限。 */
function cleanUserAgent(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "")].slice(0, MAX_USER_AGENT_CHARS).join("");
}

function normalizeCreateArgs(
  inputOrUserAgent: CreateBrowserSessionInput | string,
  entryOrOpts?: string | CreateBrowserSessionOptions,
  opts?: CreateBrowserSessionOptions,
): { userAgent: string; entry: string; viaPublic: boolean; clientIp: string } {
  if (typeof inputOrUserAgent === "string") {
    const entry = typeof entryOrOpts === "string" ? entryOrOpts : "";
    return {
      userAgent: inputOrUserAgent,
      entry,
      viaPublic: opts?.viaPublic === true,
      clientIp: opts?.clientIp ?? "",
    };
  }
  const extra = typeof entryOrOpts === "object" && entryOrOpts !== null ? entryOrOpts : opts;
  return {
    userAgent: inputOrUserAgent.userAgent,
    entry: inputOrUserAgent.entry,
    viaPublic: (extra?.viaPublic ?? inputOrUserAgent.viaPublic) === true,
    clientIp: extra?.clientIp ?? inputOrUserAgent.clientIp ?? "",
  };
}

export function createBrowserSessions(db: Db, options: Clock = {}): BrowserSessions {
  const now = options.now ?? Date.now;

  const deleteById = (id: string): boolean =>
    db.transaction(() => {
      db.run("DELETE FROM browser_session_public WHERE session_id = ?", id);
      return db.run("DELETE FROM browser_sessions WHERE id = ?", id).changes > 0;
    });

  return {
    create(inputOrUserAgent, entryOrOpts, opts) {
      const { userAgent, entry, viaPublic, clientIp } = normalizeCreateArgs(inputOrUserAgent, entryOrOpts, opts);
      const id = randomBytes(16).toString("base64url");
      const token = newSecret();
      const at = now();
      const status: BrowserSessionStatus = viaPublic ? "pending_approval" : "active";
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
        if (viaPublic) {
          db.run("INSERT INTO browser_session_public (session_id, status, client_ip) VALUES (?, 'pending_approval', ?)", id, clientIp);
        }
        const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM browser_sessions")?.n ?? 0;
        if (total > MAX_BROWSER_SESSIONS) {
          // 优先淘汰 status = 'pending_approval' 的待批准会话，防止公网恶意扫码挤掉已登录的正式会话
          evicted = db
            .all<{ id: string }>(
              `SELECT s.id
               FROM browser_sessions s
               LEFT JOIN browser_session_public p ON p.session_id = s.id
               ORDER BY CASE WHEN p.status = 'pending_approval' THEN 0 ELSE 1 END ASC, s.last_seen_at ASC, s.created_at ASC, s.rowid ASC
               LIMIT ?`,
              total - MAX_BROWSER_SESSIONS,
            )
            .map((r) => r.id);
          for (const evictedId of evicted) {
            db.run("DELETE FROM browser_session_public WHERE session_id = ?", evictedId);
            db.run("DELETE FROM browser_sessions WHERE id = ?", evictedId);
          }
        }
      });
      return { id, token, status, viaPublic, evicted };
    },
    authenticate(token) {
      if (typeof token !== "string" || token === "") return null;
      const row = db.get<JoinedRow>(
        `SELECT s.id, s.user_agent, s.created_at, s.last_seen_at, p.status AS public_status, p.client_ip
         FROM browser_sessions s
         LEFT JOIN browser_session_public p ON p.session_id = s.id
         WHERE s.token_hash = ?`,
        hashOf(token),
      );
      if (row === undefined) return null;
      const at = now();
      const viaPublic = row.public_status !== null;
      const status: BrowserSessionStatus = row.public_status === "pending_approval" ? "pending_approval" : "active";
      if (viaPublic && status === "pending_approval" && at - row.created_at > PENDING_SESSION_TTL_MS) {
        deleteById(row.id);
        return null;
      }
      const maxAge = viaPublic ? PUBLIC_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS;
      if (at - row.last_seen_at > maxAge) {
        deleteById(row.id);
        return null;
      }
      if (at - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
        db.run("UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?", at, row.id);
      }
      return { id: row.id, status, viaPublic };
    },
    approve(id) {
      const row = db.get<{ created_at: number }>(
        `SELECT s.created_at
         FROM browser_sessions s
         JOIN browser_session_public p ON p.session_id = s.id
         WHERE s.id = ?`,
        id,
      );
      if (row === undefined) return false;
      if (now() - row.created_at > PENDING_SESSION_TTL_MS) {
        deleteById(id);
        return false;
      }
      db.run("UPDATE browser_session_public SET status = 'active' WHERE session_id = ?", id);
      return true;
    },
    revokePublic() {
      let ids: string[] = [];
      db.transaction(() => {
        ids = db.all<{ session_id: string }>("SELECT session_id FROM browser_session_public").map((r) => r.session_id);
        if (ids.length === 0) return;
        db.run("DELETE FROM browser_session_public");
        for (const id of ids) db.run("DELETE FROM browser_sessions WHERE id = ?", id);
      });
      return ids;
    },
    list() {
      return db
        .all<JoinedRow>(
          `SELECT s.id, s.user_agent, s.created_at, s.last_seen_at, p.status AS public_status, p.client_ip
           FROM browser_sessions s
           LEFT JOIN browser_session_public p ON p.session_id = s.id
           ORDER BY s.last_seen_at DESC, s.created_at DESC, s.rowid DESC`,
        )
        .map((r) => {
          const viaPublic = r.public_status !== null;
          const status: BrowserSessionStatus = r.public_status === "pending_approval" ? "pending_approval" : "active";
          return {
            id: r.id,
            userAgent: r.user_agent,
            createdAt: r.created_at,
            lastSeenAt: r.last_seen_at,
            status,
            viaPublic,
            ...(viaPublic && r.client_ip ? { clientIp: r.client_ip } : {}),
          };
        });
    },
    revoke(id) {
      return deleteById(id);
    },
    revokeAll() {
      db.transaction(() => {
        db.run("DELETE FROM browser_session_public");
        db.run("DELETE FROM browser_sessions");
      });
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
