-- 0015_browser_sessions：浏览器登录，每个浏览器一条（docs/multi-device-design.md 第 3.4 节；ui-server/sessions.ts）。
-- 约定同 0001～0014。只加一张新表，老数据一行不动。库里只存会话令牌的 sha256（token_hash），明文只在浏览器的 cookie 里；
-- id 是给界面列表、单个退出用的编号，和令牌无关（知道 id 登录不了）。
-- 单独一张表、用 IF NOT EXISTS：有的测试把 user_version 退回去再跑一遍迁移。
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL,
  -- 从哪台入口登的（登录请求的 Host 头）
  entry TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
