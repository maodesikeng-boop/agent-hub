// Pi 专属可调常量（集中在一处，方便以后调整）。

/**
 * 轮末 agent_settled 到达后等待 get_session_stats 回应的宽限时间（毫秒）。
 * 本地进程内计算通常 < 5ms；超时则直接用流式累计的 assistant usage 结算本轮，绝不卡死 turn.ended。
 */
export const PI_SESSION_STATS_TIMEOUT_MS = 500;

/**
 * 兜底扫描 <sessionsDir> 下最多检查多少个子目录（按跑了一个月 300 个已收工 Worker + 多项目算，防止异常巨型目录无界遍历）。
 */
export const MAX_PI_SESSION_SUBDIRS_SCAN = 500;

/**
 * 探测命令（`pi --offline --list-models`、空闲 `get_commands`、写交接单行缓冲）标准输出最多累计多少字符，防止异常输出撑爆内存。
 */
export const MAX_PI_PROBE_STDOUT_CHARS = 2 * 1024 * 1024;
