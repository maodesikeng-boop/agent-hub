-- 0039_drop_public_entry：手机公网入口退役（docs/account-mesh-design.md「删掉什么」，手机改用飞书）。
-- 公网扫码登录的会话一并删掉：界面服务不再认“待批准”，留着的话待批准的会话会变成已登录。
DELETE FROM browser_sessions WHERE id IN (SELECT session_id FROM browser_session_public);
DROP TABLE IF EXISTS browser_session_public;
