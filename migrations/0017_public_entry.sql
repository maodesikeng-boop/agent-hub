-- 0017_public_entry：公网入口（run/public.sock）浏览器会话附属信息（docs/mac-app-and-mobile-design.md 第 2.2 节）。
-- 单独建表并用 IF NOT EXISTS，保证把 user_version 退回再重跑 migrate() 时幂等。
-- 凡在 browser_session_public 中有记录的会话即为 viaPublic = true，status 为 'pending_approval' | 'active'；
-- 不在该表中的会话即普通本机/tailnet 会话（viaPublic = false, status = 'active'）。
CREATE TABLE IF NOT EXISTS browser_session_public (
  session_id TEXT PRIMARY KEY REFERENCES browser_sessions (id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  client_ip  TEXT NOT NULL
) STRICT;
