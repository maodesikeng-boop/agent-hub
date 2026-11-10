// Cursor（cursor-agent）常驻 ACP 驱动与探测的超时及输出上限常量。

/**
 * ACP 会话冷启动超时预算（毫秒）：
 * 本机实测 cursor-agent acp 的 initialize (~0.8s) + session/new (~7.3s) 约 8s，
 * 磁盘缓存冷启动或网络波动时可达 15～25s，留足 45s 余量。
 */
export const CURSOR_START_TIMEOUT_MS = 45_000;

/**
 * 空闲/结束关闭 stdin 后等待进程有序退出的宽限期（毫秒）：
 * 实测 cursor-agent 关标准输入后最长约 4.4s 刷盘退出，设 8s 宽限期，超时再升级信号杀进程组。
 */
export const CURSOR_SHUTDOWN_GRACE_MS = 8_000;

/**
 * 发送 session/cancel 后等待服务端以 cancelled 结束当前轮的宽限期（毫秒）：
 * 超时后升级 SIGINT -> SIGKILL 清理整个进程组。
 */
export const CURSOR_INTERRUPT_GRACE_MS = 5_000;

/** 单次探测命令（cursor-agent models / status）标准输出与错误缓冲上限（512 KiB）。 */
export const CURSOR_PROBE_MAX_STDOUT_BYTES = 512 * 1024;

/** 静态扫描项目/用户目录下命令与技能文件的单目录最大文件数上限，防止异常大目录阻塞。 */
export const CURSOR_MAX_SCANNED_COMMAND_ENTRIES = 200;
