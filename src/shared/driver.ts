// 驱动层（M1 W2 实现，M2 W3 扩展）对外的接口：执行器调它，它把事件交给账本，它自己读写 SessionStore。
import type { AgentSessionRow, ApiRetryInfo, MessageId, RateLimitInfo, SessionId, Unsubscribe } from "./domain.ts";
import type { SessionStore } from "./store.ts";

export type MessageSource = "user" | "system";

export interface DriverSendInput {
  /**
   * 这条文字对应的消息编号（驱动层把忙时连发的用户消息拼成一条时，会一起带上它们的编号）。
   * 至少一个；空数组按 invalid_input 拒绝（返回 rejected）。
   */
  messageIds: MessageId[];
  source: MessageSource;
  /**
   * 原样写进去的文字，驱动层不加来源标签。约定（设计第 7.3 节）：用户消息不加标签；系统消息由调用方
   * 自己在开头带 `【…】` 标签（如“【Worker #12 · 修 X 的汇报】”）；驱动层加的恢复说明、重发说明都以 `【系统】` 开头。
   */
  text: string;
  /** 重启后重发（SessionSendParams.resend）：前面加 RESEND_NOTE。 */
  resend?: boolean;
  /**
   * 重启恢复这个会话的第一条（SessionSendParams.recovery）：之后写进去的第一行最前面加 RESTART_RECOVERY_NOTE，
   * 顺序是“恢复说明、重发说明、原文”，同一行。同样的 messageIds 再调（还在待发队列里）不会再加一次。
   */
  recovery?: boolean;
}

/**
 * send 的结果：
 * - written：写进标准输入成功（这一次，或者之前一次带同样 messageIds 的 send）。处理函数返回 done。
 *   那一轮出错（turn.ended ok=false）或进程崩溃、启动失败之后，这些消息不再算写过，重发会真的再写一次。
 * - queued：会话正忙，消息在驱动层的待发队列里还没写。处理函数返回 { kind: "later" }，过一会儿再调 send；
 *   同样的 messageIds 再调不会重复排队，写进去之后再调返回 written。
 * - rejected：写入前校验没过，没写，也不会再写；驱动层已经出了 driver.error(invalid_input, messageIds)，
 *   账本据此标 failed。处理函数返回 done。
 */
export type DriverSendResult = { kind: "written" } | { kind: "queued" } | { kind: "rejected" };

/**
 * 重启后恢复会话（DriverSendInput.recovery）时，加在之后写进去的第一行最前面，和那条消息在同一行（设计第 5.4 节第 4 步）。
 * 不单独写一行：单独一行会自己占一轮，agent 在那一轮把活干完、写了汇报，这一轮却不对应任何消息，汇报就丢了。
 */
export const RESTART_RECOVERY_NOTE = "【系统】守护进程重启，你上一轮被打断了。请先看一下工作区现在的状态，再接着做。";
/** 重发（DriverSendInput.resend）时加在消息前面（设计第 12.1 节）。 */
export const RESEND_NOTE = "【系统】下面这条消息之前可能已经发给过你。如果你已经处理过这条，忽略它。";
/**
 * 两轮之间因为设置变了自动重启之后（见下面“两轮之间自动重启”），加在下一条写进去的消息前面。
 * 项目经理自己调 hub 改了设置（挂、移除文件夹，改性格设定、模式）时，账本不再单独给它发【系统】消息，靠这一句告诉它
 * 新设置已经生效（见 domain.ts 的 SystemMessageMeta）。
 */
export const RELAUNCH_NOTE = "【系统】你的设置（性格设定、模式、文件夹或管着的项目）刚更新过，已经按新设置重新启动，最新的设置见系统提示词。";
/** 进程上一轮没等到 result 就退出了（崩溃）：加在下一条写进去的消息前面。 */
export const CRASH_RECOVERY_NOTE = "【系统】你的进程上一轮意外退出了，那一轮可能没做完。请先看一下工作区现在的状态，再接着做。";

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

/** 进程起来、收到第一个 system/init。resumed：这次是 --resume。model：claude 实际报回来的模型（只在这里，不写会话那一行）。 */
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
 * shutdown 的一轮（M3）：Worker 的消息不标，留着重启后接着做（见 ledger/messages.ts 的 applyEvent）。
 */
export interface TurnEndedEvent extends DriverEventBase {
  type: "turn.ended";
  ok: boolean;
  interrupted: boolean;
  /** 这一轮是守护进程关机时发 SIGINT 结束的（不是用户点停止）：只在关机中、而且这一轮 !ok 或 interrupted 时出现；关机中正常做完的一轮不带。 */
  shutdown?: true;
  messageIds: MessageId[];
  durationMs: number | null;
  /** ok=false 时 result 里的错误：subtype 照抄（如 "error_during_execution"），message 是能给人看的一句。 */
  error?: { subtype: string; message: string };
}

export interface RateLimitEvent extends DriverEventBase {
  type: "rate_limit";
  info: RateLimitInfo;
}

/** system/api_retry：claude 因为网络出错、服务过载在自己重试。不改消息状态，只让会话状态带上重试信息，下一个正常事件清掉。 */
export interface ApiRetryEvent extends DriverEventBase {
  type: "api_retry";
  info: ApiRetryInfo;
}

/**
 * 出错的一轮给人看的原因：subtype 加 claude 给的话（“error_during_execution: …”）。
 * claude 重试用完（断网）时 result 的 subtype 还是 "success"、只是 is_error，这时前缀会误导，只留 claude 给的话。
 */
export function turnFailureReason(error: { subtype: string; message: string }): string {
  return error.subtype === "success" ? error.message : `${error.subtype}: ${error.message}`;
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
  "internal_error", // 驱动层自己出错（写库、写日志、监听者抛错、找不到会话那一行），不可重试
  "session_ended", // 会话已经 end 过、或正在 end（M2），不会再起来，不可重试；处理函数不把它当失败，见 Driver.end
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
 * - bad_output_line、internal_error 等：不带 messageIds，只记 health。
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
  | ApiRetryEvent
  | SessionExitedEvent
  | DriverErrorEvent;

export type DriverEventType = DriverEvent["type"];

export type DriverEventListener = (sessionId: SessionId, event: DriverEvent) => void;

/**
 * 进程组（m2-plan 第 6 节第 4 条）：claude 用 detached 起在自己的进程组里。正常停止（打断、空闲关、关机先发的那一下）
 * 仍然只给 claude 本身发 SIGINT；强制结束（关机超时、启动超时、cleanupStale）给整个进程组发 SIGKILL，
 * 把它起的 pnpm test、开发服务器之类一起结束。
 *
 * 两轮之间自动重启（m2-plan 第 6 节第 3 条）：每次要往一个已经在跑、空闲的进程写下一条之前，驱动层先调一次 prepareLaunch，
 * 下面任何一样和这个进程启动时不一样，就关标准输入、等它退出，再用 --resume 起一个新的，然后才写这条：
 * - LaunchFiles.fingerprint；
 * - 会话那一行的 cwd、addDirs、model、effort（配置的模型、思考程度，驱动层只读不写）。
 * env 不参与比较。正在跑的这一轮不打断，等它结束再比。消息不丢、不重复（还是同一次 send，只是先重启）。
 * 重启时用的是重启前调的那次 prepareLaunch 的结果，不再调第二次。重启后写进去的第一条消息前面加 RELAUNCH_NOTE。
 */

/** 执行器 ↔ 驱动层。 */
export interface Driver {
  /**
   * “启动或恢复会话”：进程已经在跑就直接返回；第一次用 --session-id，之后 --resume。
   * 没有要写的消息时，进程 spawn 成功就返回；有待发消息时，等到 init 再返回，
   * 起不来抛 DriverError（可重试的那几种）。启动后马上退出只通过 session.exited(startup_failed) 反映，
   * start 不会因此抛错。
   */
  start(sessionId: SessionId): Promise<void>;
  /**
   * 会话没起来会先起（起不来抛 DriverError）。只有写进标准输入成功才 resolve 成 written；
   * 会话正忙就放进驱动层自己的待发队列，resolve 成 queued（见 DriverSendResult）。
   * 忙时用户消息排在系统消息前面，用户连发的拼成一条。
   * 这个会话已经调过 end（哪怕 end 还在等这一轮回完、还没 resolve）：直接抛 DriverError("session_ended")，不排队。
   */
  send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult>;
  /** 先写 interrupt 控制消息，5 秒没回应发 SIGINT。 */
  interrupt(sessionId: SessionId): Promise<void>;
  /**
   * 结束会话（M2，session.end 动作调）：
   * - 正在跑一轮：不打断，等这一轮的 result，然后关标准输入、等进程退出；
   * - 空闲或没有进程：不启动进程，直接结束。
   * end 一被调用（同步地，在第一个 await 之前）就把这个会话标成“正在结束”：从这一刻起新的 start、send 都抛
   * DriverError("session_ended")，不会因为 end 还在等这一轮而被排进待发队列。
   * 驱动层自己的待发队列里还没写的消息丢掉，不再写。最后把那一行 status 写成 ended、pid 置空，然后 resolve。
   * 已经 ended 的再调直接 resolve（动作重试无害）。
   * 进程退出照常出 session.exited（reason: idle）。
   *
   * session_ended 不是故障，处理函数（W6，handlers.ts）这样接：
   * - 不计入 driver 的 health（不抛给执行器，执行器就不会记）；
   * - session.start 遇到 session_ended → 返回 done；
   * - session.send 遇到 session_ended → 返回 done：这条消息发不出去了。已经写进去一半（已送达、处理中，重启恢复时会遇到）的
   *   按“这一轮被打断”标已停止；还在排队的调 ledger.onActionFailed 标失败（老的项目群升级后会遇到：迁移 0003 把群里的会话标了 ended）。
   */
  end(sessionId: SessionId): Promise<void>;
  /** 守护进程关机：给所有 claude 发 SIGINT，空闲的关掉标准输入，最多等 10 秒，剩下的按进程组强制结束。 */
  shutdown(): Promise<void>;
  /**
   * 清理上次守护进程留下的 claude（组装代码启动时调）。对 SessionStore.listWithProcess() 的每一行：先用 ps 确认
   * 那个 pid 的命令行确实是 claude、并且带着这个会话的 vendorSessionId（防 pid 被复用），确认了发 SIGINT，
   * 等 interruptGraceMs 还没退就给它的进程组发 SIGKILL；最后不管确认没确认，都把那一行 pid 置空、
   * status 置 idle（已经是 ended 的保持 ended）。
   */
  cleanupStale(): Promise<void>;
  onEvent(listener: DriverEventListener): Unsubscribe;
}

/** 每次启动前由组装代码（prepareLaunch）生成的文件和环境变量（设计第 7.2 节）。 */
export interface LaunchFiles {
  promptFile: string;
  /**
   * --settings 的文件。M2 起项目经理的会话都有（M3 起 Worker 也有）：默认档、放行 `Bash(hub:*)` 和 hub.sock 的真实路径
   * （内容见 policy.ts 的 buildSessionSettings）。
   */
  settingsFile?: string;
  /**
   * 这一次启动额外的环境变量（M2）：ENV_HUB_TOKEN、ENV_HUB_SOCK、PATH（hub 外壳所在的 run/bin 放最前面，后面接守护进程自己的 PATH）。
   * 合并顺序：守护进程的 process.env < DriverOptions.env < 这里，同名的后者覆盖前者（PATH 整个替换）。
   * 不参与是否重启的判断（见上面“两轮之间自动重启”）。
   */
  env: Record<string, string>;
  /**
   * 提示词、设置文件内容的摘要：用 src/shared/launch.ts 的 launchFingerprint 算。内容一样就一样，变了就不一样。
   * 只算实际写进文件的内容，不含时间、随机数、令牌。驱动层只比较它是否相等。
   */
  fingerprint: string;
}

export interface DriverOptions {
  /** claude 程序路径（AGENT_HUB_CLAUDE）。 */
  claudePath: string;
  /** logs/sessions/ 所在目录。 */
  sessionLogsDir: string;
  store: SessionStore;
  /**
   * 每次启动前调用，生成提示词和设置文件；两轮之间判断要不要重启时也调（见上面“两轮之间自动重启”）。
   * 所以它要能反复调：同一个会话每次给的令牌一样（SessionTokens.issue 的约定），文件内容没变就给一样的 fingerprint。
   */
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  /** 所有会话共用的额外环境变量（如 CLAUDE_CONFIG_DIR）。每个会话自己的在 LaunchFiles.env。 */
  env?: Record<string, string>;
  /** 以下都有默认值，见 limits.ts；测试可以改小。 */
  idleCloseMs?: number;
  interruptGraceMs?: number;
  startTimeoutMs?: number;
  shutdownGraceMs?: number;
}
