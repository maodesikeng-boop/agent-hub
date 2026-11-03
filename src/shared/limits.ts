// 各块共用的数字和名字，定在这里免得各写各的。

/** 一次返回多少条消息（/api/state 里每个对话、/messages?before= 每页）。 */
export const MESSAGE_PAGE_SIZE = 100;
/** 一条用户消息最多 100 KB（按 UTF-8 字节算）。 */
export const MAX_MESSAGE_BYTES = 100 * 1024;
/** 账本在内存里留多少条变化，供 changesSince 补齐；更早的补不齐，要 resync。 */
export const CHANGE_BUFFER_SIZE = 1000;

// ---- M2：请求体的长度上限（界面服务、agent 接口校验请求体用，账本再查一遍）----

/** 项目名、项目经理名最多几个字符（按 Unicode 字符算，见 normalizeName）。 */
export const MAX_NAME_CHARS = 40;
/** 项目的一句话说明最多几个字符。 */
export const MAX_DESCRIPTION_CHARS = 200;
/** 性格设定正文最多 32 KB（UTF-8 字节）。 */
export const MAX_PERSONA_BYTES = 32 * 1024;
/** 交接正文最多 64 KB（UTF-8 字节）。 */
export const MAX_HANDOFF_BYTES = 64 * 1024;
/** 改性格设定的理由最多几个字符。 */
export const MAX_REASON_CHARS = 500;
/** 文件夹路径最多 4096 字节（macOS 的 PATH_MAX 是 1024，留余量）。 */
export const MAX_PATH_BYTES = 4096;
/** 模型名最多几个字符。 */
export const MAX_MODEL_CHARS = 100;
/**
 * agent 接口一个请求体最多多大（Fastify 的 bodyLimit）；比最长的字段大，字段超长由校验报 invalid。
 * 整个请求体超过它（Fastify 抛 FST_ERR_CTP_BODY_TOO_LARGE）也映射成 invalid、HTTP 400，不另开 413（见 hub.ts）。
 */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** hub_calls 里 args 的每个字符串字段、result 最多存多少字节，超了截断（见 domain.ts 的 HubCall）。 */
export const HUB_CALL_FIELD_MAX_BYTES = 2 * 1024;
/** PersonaView 里最多带几条修改记录。 */
export const PERSONA_CHANGES_LIMIT = 50;

/** 打断：控制消息 5 秒没回应就发 SIGINT。 */
export const INTERRUPT_GRACE_MS = 5_000;
/** 启动后 60 秒没有 system/init，结束进程。 */
export const START_TIMEOUT_MS = 60_000;
/** 一轮结束后空闲 10 分钟，关掉标准输入。 */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** 关机时最多等 10 秒，剩下的强制结束。 */
export const SHUTDOWN_GRACE_MS = 10_000;

// ---- 其他超时和间隔（可调的数都放这里；动作的重试次数和退避在 actions.ts 的 ACTION_RETRY，按动作类型和类型定义放一起）----

/** 驱动层：lastEventAt 最多每秒写一次库。 */
export const LAST_EVENT_WRITE_MS = 1_000;
/** 驱动层：进程退出后最多等多久把标准输出、标准错误读完；孙进程占着管道时到点强制关掉。 */
export const STDIO_DRAIN_MS = 300;
/** 驱动层：发了 SIGKILL 之后最多再等多久。 */
export const KILL_WAIT_MS = 2_000;
/** 驱动层：清理残留进程时多久看一次它还在不在。 */
export const STALE_POLL_MS = 50;
/** 处理函数：会话正忙、消息在驱动层排队（或交接后改指了新一代）时，隔多久再问一次。 */
export const QUEUED_RECHECK_MS = 1_000;
/** 处理函数：额度用完时最多推迟多久再看一次。 */
export const RATE_LIMIT_RECHECK_MAX_MS = 5 * 60_000;
/** agent 接口：一个请求从连上到收完的上限，半截请求挂着不放，到点就断。 */
export const HUB_REQUEST_TIMEOUT_MS = 15_000;
/** agent 接口：多久查一次有没有超时的请求（Node 的 connectionsCheckingInterval，默认 30 秒，太粗）。 */
export const HUB_TIMEOUT_CHECK_MS = 1_000;
/** agent 接口：启动时试连旧 socket 的上限，连得上说明有活实例。 */
export const HUB_SOCKET_PROBE_MS = 1_000;
/** hub 命令：连上之后多久没动静算守护进程没回应。 */
export const HUB_CLI_TIMEOUT_MS = 30_000;
/** hub 命令：--stdin 多久没收到数据就放弃。 */
export const HUB_CLI_STDIN_IDLE_MS = 60_000;
/** 关机：最多等执行器手上的动作多久；还没做完（比如在等 claude 启动）就先关驱动层，让它们结束。 */
export const EXECUTOR_STOP_GRACE_MS = 3_000;
/** 关机：关 agent 接口最多等多久（它不等还连着的请求，正常一下就关掉；超了不再等，接着关库）。 */
export const AGENT_API_CLOSE_MS = 3_000;

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
