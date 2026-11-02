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

/** 界面登录后设的 cookie（HttpOnly、SameSite=Strict）。 */
export const UI_COOKIE_NAME = "agent_hub_ui";

/** 环境变量。 */
export const ENV_HOME = "AGENT_HUB_HOME";
export const ENV_CLAUDE = "AGENT_HUB_CLAUDE";

/** 同一个模块连续失败几次就算“坏了”（界面标红）。 */
export const HEALTH_FAILURE_THRESHOLD = 3;
