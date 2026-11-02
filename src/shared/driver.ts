// 驱动层（W2 实现）对外的接口：执行器调它，它把事件交给账本，它自己读写 SessionStore。
import type { AgentSessionRow, MessageId, RateLimitInfo, SessionId, Unsubscribe } from "./domain.ts";
import type { SessionStore } from "./store.ts";

export type MessageSource = "user" | "system";

export interface DriverSendInput {
  /** 这条文字对应的消息编号（驱动层把忙时连发的用户消息拼成一条时，会一起带上它们的编号）。 */
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
}

/**
 * 每个事件都带 Claude 原始的 uuid（有的话）；账本按（会话，uuid）去重。
 * `at` 是驱动层收到它的毫秒时间。
 */
export interface DriverEventBase {
  uuid?: string;
  at: number;
}

/** 进程起来、收到第一个 system/init。resumed：这次是 --resume。 */
export interface SessionStartedEvent extends DriverEventBase {
  type: "session.started";
  resumed: boolean;
  model: string | null;
  tools: string[];
}

/** 写进标准输入成功 → 已送达。 */
export interface MessageDeliveredEvent extends DriverEventBase {
  type: "message.delivered";
  messageIds: MessageId[];
}

/** 收到 --replay-user-messages 的回显 → 处理中。 */
export interface MessageProcessingEvent extends DriverEventBase {
  type: "message.processing";
  messageIds: MessageId[];
}

/** assistant 的一段文字。 */
export interface AgentTextEvent extends DriverEventBase {
  type: "agent.text";
  text: string;
}

/** 一次工具调用（调用开始时出一个）。 */
export interface AgentToolEvent extends DriverEventBase {
  type: "agent.tool";
  toolUseId: string;
  name: string;
  input: unknown;
}

/**
 * 一轮结束（result）。
 * - interrupted：这一轮里出现过 `[Request interrupted by user]`，算“已停止”，不算正常结束；
 * - ok：result 成功且没被打断。
 * messageIds：这一轮处理的用户消息，账本据此标“已回复”或“已停止”。
 */
export interface TurnEndedEvent extends DriverEventBase {
  type: "turn.ended";
  ok: boolean;
  interrupted: boolean;
  messageIds: MessageId[];
  durationMs: number | null;
}

export interface RateLimitEvent extends DriverEventBase {
  type: "rate_limit";
  info: RateLimitInfo;
}

/** 进程退出。hadResult 为 false 表示这一轮没有 result，按崩溃处理。 */
export interface SessionExitedEvent extends DriverEventBase {
  type: "session.exited";
  exitCode: number | null;
  signal: string | null;
  hadResult: boolean;
}

export const DRIVER_ERROR_CODES = [
  "start_timeout", // 启动 60 秒没有 init
  "claude_not_found", // 找不到 claude 程序
  "spawn_failed", // 其他原因起不来
  "invalid_input", // 写入前校验没过，没写
  "bad_output_line", // 输出了一行不是 JSON 的东西，已跳过
  "start_args_conflict", // --session-id / --resume 选错且重试一次也不行
] as const;
export type DriverErrorCode = (typeof DRIVER_ERROR_CODES)[number];

export interface DriverErrorEvent extends DriverEventBase {
  type: "driver.error";
  code: DriverErrorCode;
  message: string;
  /** 受影响的消息（起不来、写不进去时）；账本据此标“失败”。 */
  messageIds?: MessageId[];
}

export type DriverEvent =
  | SessionStartedEvent
  | MessageDeliveredEvent
  | MessageProcessingEvent
  | AgentTextEvent
  | AgentToolEvent
  | TurnEndedEvent
  | RateLimitEvent
  | SessionExitedEvent
  | DriverErrorEvent;

export type DriverEventType = DriverEvent["type"];

export type DriverEventListener = (sessionId: SessionId, event: DriverEvent) => void;

/** 执行器 ↔ 驱动层。 */
export interface Driver {
  /** “启动或恢复会话”：进程已经在跑就直接返回；第一次用 --session-id，之后 --resume。 */
  start(sessionId: SessionId): Promise<void>;
  /** 进驱动层自己的待发队列；会话没起来会先起。忙时用户消息排在系统消息前面，用户连发的拼成一条。 */
  send(sessionId: SessionId, input: DriverSendInput): Promise<void>;
  /** 先写 interrupt 控制消息，5 秒没回应发 SIGINT。 */
  interrupt(sessionId: SessionId): Promise<void>;
  /** 守护进程关机：给所有 claude 发 SIGINT，空闲的关掉标准输入，最多等 10 秒，剩下的强制结束。 */
  shutdown(): Promise<void>;
  onEvent(listener: DriverEventListener): Unsubscribe;
}

/** 每次启动前由 W5 生成的文件（设计第 7.2 节）。 */
export interface LaunchFiles {
  promptFile: string;
  settingsFile?: string;
  /** 空的 MCP 配置，配合 --strict-mcp-config。 */
  mcpConfigFile: string;
}

export interface DriverOptions {
  /** claude 程序路径（AGENT_HUB_CLAUDE）。 */
  claudePath: string;
  /** logs/sessions/ 所在目录。 */
  sessionLogsDir: string;
  store: SessionStore;
  /** 每次启动前调用，生成提示词和设置文件。 */
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  /** 额外的环境变量（如 CLAUDE_CONFIG_DIR）。 */
  env?: Record<string, string>;
  /** 以下都有默认值，见 limits.ts；测试可以改小。 */
  idleCloseMs?: number;
  interruptGraceMs?: number;
  startTimeoutMs?: number;
  shutdownGraceMs?: number;
}
