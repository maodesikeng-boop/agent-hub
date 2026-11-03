// 驱动层（W2 实现）对外的接口：执行器调它，它把事件交给账本，它自己读写 SessionStore。
import type { AgentSessionRow, MessageId, RateLimitInfo, SessionId, Unsubscribe } from "./domain.ts";
import type { SessionStore } from "./store.ts";

export type MessageSource = "user" | "system";

export interface DriverSendInput {
  /** 这条文字对应的消息编号（驱动层把忙时连发的用户消息拼成一条时，会一起带上它们的编号）。 */
  messageIds: MessageId[];
  source: MessageSource;
  text: string;
  /** 重启后重发（SessionSendParams.resend）：前面加 RESEND_NOTE。 */
  resend?: boolean;
}

/**
 * send 的结果：
 * - written：写进标准输入成功（这一次，或者之前一次带同样 messageIds 的 send）。处理函数返回 done。
 * - queued：会话正忙，消息在驱动层的待发队列里还没写。处理函数返回 { kind: "later" }，过一会儿再调 send；
 *   同样的 messageIds 再调不会重复排队，写进去之后再调返回 written。
 * - rejected：写入前校验没过，没写，也不会再写；驱动层已经出了 driver.error(invalid_input, messageIds)，
 *   账本据此标 failed。处理函数返回 done。
 */
export type DriverSendResult = { kind: "written" } | { kind: "queued" } | { kind: "rejected" };

/** 重启后恢复会话（start 的 recovery）时，加在下一条写进去的消息前面（设计第 5.4 节第 4 步）。 */
export const RESTART_RECOVERY_NOTE = "【系统】守护进程重启，你上一轮被打断了。请先看一下工作区现在的状态，再接着做。";
/** 重发（DriverSendInput.resend）时加在消息前面（设计第 12.1 节）。 */
export const RESEND_NOTE = "【系统】下面这条消息之前可能已经发给过你。如果你已经处理过这条，忽略它。";

/**
 * 去重：
 * - agent.text、agent.tool 一定带 uuid，账本按 agentMessageDedupeKey 去重（工具再带 toolUseId）。
 *   Claude 原始事件有 uuid 就照抄；没有的话驱动层用 `line:<原始那一行的 sha256 十六进制前 32 位>`，
 *   这样重放日志得到的键不变。同一个 assistant 事件里的几段文字拼成一个 agent.text。
 * - 其他事件 uuid 可有可无，账本不靠它去重，靠消息状态只按 MESSAGE_STATUS_TRANSITIONS 走来保证重复无害。
 * `at` 是驱动层收到它的毫秒时间。
 */
export interface DriverEventBase {
  uuid?: string;
  at: number;
}

/**
 * 会话状态（agent_sessions.status：running、idle……）由驱动层通过 SessionStore 写进那一行，事件里不带。
 * 账本不依赖“写库”和“发事件”这两步的先后顺序：每处理一个事件都按那一行重新算出会话状态，
 * 和上次推给网页的比，变了就推，不会漏推。先发事件后写库时，新状态在下一个事件时推出去。
 */

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
  uuid: string;
  text: string;
}

/** 一次工具调用（调用开始时出一个）。Message.text 的一行摘要由账本生成。 */
export interface AgentToolEvent extends DriverEventBase {
  type: "agent.tool";
  uuid: string;
  toolUseId: string;
  name: string;
  input: unknown;
}

/**
 * 一轮结束（result）。messageIds：这一轮处理的用户消息。ok 的 turn.ended 之前一定先出过这些消息的
 * message.processing（delivered → replied 不是合法的状态变化，账本会忽略）。账本这样标：
 * - interrupted（这一轮里出现过 `[Request interrupted by user]`）→ stopped；
 * - 否则 ok → replied；
 * - 否则（ok=false 且不是打断）→ failed，failureReason 取 error。
 */
export interface TurnEndedEvent extends DriverEventBase {
  type: "turn.ended";
  ok: boolean;
  interrupted: boolean;
  messageIds: MessageId[];
  durationMs: number | null;
  /** ok=false 时 result 里的错误：subtype 照抄（如 "error_during_execution"），message 是能给人看的一句。 */
  error?: { subtype: string; message: string };
}

export interface RateLimitEvent extends DriverEventBase {
  type: "rate_limit";
  info: RateLimitInfo;
}

/**
 * 进程为什么退出：
 * - idle：空闲关掉标准输入后正常退出；
 * - interrupt：打断时控制消息没回应，发了 SIGINT；
 * - shutdown：守护进程关机；
 * - crash：其他意外退出（这一轮没有 result）；
 * - startup_failed：没等到 init 就退出了（或者启动超时被结束）。
 */
export const SESSION_EXIT_REASONS = ["idle", "interrupt", "shutdown", "crash", "startup_failed"] as const;
export type SessionExitReason = (typeof SESSION_EXIT_REASONS)[number];

/**
 * 进程退出。hadResult 为 false 表示这一轮没有 result。
 * messageIds：退出时在途的消息（已经写进去、还没等到 result），账本据 reason 标：
 * interrupt、shutdown → stopped；crash、startup_failed → failed（failureReason 写退出码或信号）；idle 时应为空。
 * 还在驱动层待发队列里没写的消息不算在途，不在这里；它们的 send 动作还是 later，下次会话起来照常写。
 */
export interface SessionExitedEvent extends DriverEventBase {
  type: "session.exited";
  reason: SessionExitReason;
  exitCode: number | null;
  signal: string | null;
  hadResult: boolean;
  messageIds: MessageId[];
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

/**
 * 这些错误由 start、send 抛 DriverError 交给执行器：按退避重试，次数用完执行器调 ledger.onActionFailed，
 * 账本把消息标 failed、failureReason 写 error.message。期间每次失败都记 health，界面实时显示原因。
 */
export const RETRYABLE_DRIVER_ERRORS: readonly DriverErrorCode[] = [
  "start_timeout",
  "claude_not_found",
  "spawn_failed",
  "start_args_conflict",
];

/** start、send 抛的错误。message 以错误码开头，账本和 health 可以原样显示。 */
export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly retryable: boolean;
  constructor(code: DriverErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "DriverError";
    this.code = code;
    this.retryable = RETRYABLE_DRIVER_ERRORS.includes(code);
  }
}

/**
 * 不能重试、也不属于哪次 start、send 调用的错误，以事件交给账本：
 * - invalid_input：带 messageIds，账本把它们标 failed；
 * - bad_output_line 等：不带 messageIds，只记 health。
 * 可重试的错误（RETRYABLE_DRIVER_ERRORS）不出这个事件，messageIds 只给 invalid_input 这类用。
 */
export interface DriverErrorEvent extends DriverEventBase {
  type: "driver.error";
  code: DriverErrorCode;
  message: string;
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

export interface DriverStartOptions {
  /** 守护进程重启后恢复被打断的会话：下一条写进去的消息前加 RESTART_RECOVERY_NOTE；没有待发消息就单独写一条。 */
  recovery?: boolean;
}

/** 执行器 ↔ 驱动层。 */
export interface Driver {
  /**
   * “启动或恢复会话”：进程已经在跑就直接返回；第一次用 --session-id，之后 --resume。
   * 等到 system/init 才 resolve；起不来抛 DriverError（可重试的那几种）。
   */
  start(sessionId: SessionId, options?: DriverStartOptions): Promise<void>;
  /**
   * 会话没起来会先起（起不来抛 DriverError）。只有写进标准输入成功才 resolve 成 written；
   * 会话正忙就放进驱动层自己的待发队列，resolve 成 queued（见 DriverSendResult）。
   * 忙时用户消息排在系统消息前面，用户连发的拼成一条。
   */
  send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult>;
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
