// 各块共用的数字和名字，定在这里免得各写各的。

/** 一次返回多少条消息（/api/state 里每个对话、/messages?before= 每页）。 */
export const MESSAGE_PAGE_SIZE = 100;
/** 一条用户消息最多 100 KB（按 UTF-8 字节算）。 */
export const MAX_MESSAGE_BYTES = 100 * 1024;
/** 账本在内存里留多少条变化，供 changesSince 补齐；更早的补不齐，要 resync。 */
export const CHANGE_BUFFER_SIZE = 1000;

/** 打断：控制消息 5 秒没回应就发 SIGINT。 */
export const INTERRUPT_GRACE_MS = 5_000;
/** 启动后 60 秒没有 system/init，结束进程。 */
export const START_TIMEOUT_MS = 60_000;
/** 一轮结束后空闲 10 分钟，关掉标准输入。 */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** 关机时最多等 10 秒，剩下的强制结束。 */
export const SHUTDOWN_GRACE_MS = 10_000;

/**
 * 界面登录后设的 cookie（HttpOnly、SameSite=Strict）。值就是界面用户令牌：
 * 令牌第一次启动时随机生成，存在数据目录的 state/ui-token（权限 UI_TOKEN_FILE_MODE），之后每次启动读同一个，
 * 所以守护进程重启后旧 cookie 仍然有效。删掉这个文件再启动就换新令牌，旧 cookie 全部失效。
 */
export const UI_COOKIE_NAME = "agent_hub_ui";
/** state/ui-token 的权限：只有自己能读写。启动时发现权限更宽要改回来。 */
export const UI_TOKEN_FILE_MODE = 0o600;

/** 环境变量。 */
export const ENV_HOME = "AGENT_HUB_HOME";
export const ENV_CLAUDE = "AGENT_HUB_CLAUDE";
/** 界面服务的端口，默认 DEFAULT_UI_PORT；0 表示由系统分配（测试用）。 */
export const ENV_PORT = "AGENT_HUB_PORT";
/** 第一次启动自动建项目经理时用的默认模型（如 claude-haiku-5-5，冒烟测试用）；不设就用 claude 自己的默认。 */
export const ENV_DEFAULT_MODEL = "AGENT_HUB_DEFAULT_MODEL";
/** 只给开发用：`pnpm dev` 时 vite 把 /api、/auth 和 WebSocket 代理到这个端口上的守护进程。 */
export const ENV_DEV_DAEMON_PORT = "AGENT_HUB_DAEMON_PORT";

/** 界面服务默认端口。固定端口：重启后浏览器刷新同一个地址就能接着用。 */
export const DEFAULT_UI_PORT = 4317;

/** 同一个模块连续失败几次就算“坏了”（界面标红）。 */
export const HEALTH_FAILURE_THRESHOLD = 3;
