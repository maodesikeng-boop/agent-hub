// 驱动层（M1 W2 实现，M2 W3 扩展）对外的接口：执行器调它，它把事件交给账本，它自己读写 SessionStore。
import type { ComposerCommand } from "./api.ts";
import type { AgentSessionRow, AgentStep, AgentStepInput, ApiRetryInfo, MessageId, RateLimitInfo, SessionId, Unsubscribe } from "./domain.ts";
import type { SessionStore } from "./store.ts";
import { HUB_COMMAND } from "./names.ts";

export type { AgentStep, AgentStepInput } from "./domain.ts";

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
  /**
   * 调用方加在 text 前面的标签（如 Worker 对话里的“【用户直接对你说】”），不给就是没有。
   * 写进去的格式（docs/composer-commands.md 的 T4）：我们加的字（恢复、重启、重发说明，这些标签，“【用户连发了 N 条】”）
   * 每项一个 text 块放在前面，用户原文单独放最后一块，这样以 / 开头的原文照样被 agent 当命令展开。
   * 以命令开头的消息（厂商的 isCommand）不和别的用户消息拼在一起，单独写一行。
   */
  prefixes?: string[];
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
 *   midTurn：会话正忙，这条在这一轮中途交给了 agent（claude、codex；agy 做不到，一律 queued），agent 之后会读到（已送达）。
 * - queued：会话正忙，消息在驱动层的待发队列里还没写。处理函数返回 { kind: "later" }，过一会儿再调 send；
 *   同样的 messageIds 再调不会重复排队，写进去之后再调返回 written。
 * - cancelled：一轮中途交给 agent 时用户点了停止，agent 没看到过；驱动层已经出了 message.cancelled，不会再写。处理函数返回 done。
 * - rejected：写入前校验没过，没写，也不会再写；驱动层已经出了 driver.error(invalid_input, messageIds)，
 *   账本据此标 failed。处理函数返回 done。
 */
export type DriverSendResult = { kind: "written"; midTurn?: true } | { kind: "queued" } | { kind: "cancelled" } | { kind: "rejected" };

/**
 * 重启后恢复会话（DriverSendInput.recovery）时，加在之后写进去的第一行最前面，和那条消息在同一行（设计第 5.4 节第 4 步）。
 * 不单独写一行：单独一行会自己占一轮，agent 在那一轮把活干完、写了汇报，这一轮却不对应任何消息，汇报就丢了。
 */
export const RESTART_RECOVERY_NOTE = "【系统】守护进程重启，你上一轮被打断了。请先看一下工作区现在的状态，再接着做。";
/** 重发（DriverSendInput.resend）时加在消息前面（设计第 12.1 节）。 */
export const RESEND_NOTE = "【系统】下面这条消息之前可能已经发给过你。如果你已经处理过这条，忽略它。";
/**
 * 两轮之间因为设置变了自动重启之后（见下面“两轮之间自动重启”），加在下一条写进去的消息前面。
 * 项目经理自己调 hub 改了设置（挂、移除文件夹）时，账本不再单独给它发【系统】消息，靠这一句告诉它
 * 新设置已经生效（见 domain.ts 的 SystemMessageMeta）。性格设定、模式变了不重启，说明见 PersonaNote。
 * 不说“见系统提示词”：claude --resume 沿用会话最初的系统提示词（driver/persona-note.ts），里面的项目、文件夹可能是旧的。
 */
export const RELAUNCH_NOTE = `【系统】你的设置（文件夹、管着的项目、模型或思考程度）刚更新过，已经按新设置重新启动。系统提示词里的项目和文件夹可能是旧的，最新的以 \`${HUB_COMMAND} status\`、\`${HUB_COMMAND} persona show\` 为准。`;
/** 后台任务被结束时说明里最多列几个任务、每个任务的 description 最多几个字符。 */
const KILLED_NOTE_MAX_TASKS = 5;
const KILLED_NOTE_MAX_DESC_CHARS = 80;
/**
 * 进程被我们关掉时会话里还有后台任务（它们跟着进程一起被结束）：下一条写进去的消息前面加这一句，让 agent 知道，需要的话重新启动。
 * relaunch：两轮之间因为设置变了重启；hold_max：后台任务超过 BACKGROUND_TASKS_HOLD_MAX_MS 没结束，空闲关闭照常关。
 * 停止、end、关机也会结束后台任务，但那之后不再有 agent 在等它们的结果，不加这句。
 */
export function backgroundTasksKilledNote(reason: "relaunch" | "hold_max", descriptions: string[]): string {
  const shown = descriptions
    .slice(0, KILLED_NOTE_MAX_TASKS)
    .map((d) => (d.length > KILLED_NOTE_MAX_DESC_CHARS ? `${d.slice(0, KILLED_NOTE_MAX_DESC_CHARS)}…` : d) || "（没有描述）");
  const more = descriptions.length - shown.length;
  const list = `${shown.join("；")}${more > 0 ? `；等共 ${descriptions.length} 个` : ""}`;
  const why = reason === "relaunch" ? "为了让新设置生效重启了" : "后台任务太久没结束，进程被关闭了";
  return `【系统】${why}，正在跑的 ${descriptions.length} 个后台任务（${list}）被结束了，需要的话重新启动。`;
}
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

/**
 * agent 的命令列表变了（claude 的 system/commands_changed，带完整名单）：已经换成通用形状，没去掉隐藏的。
 * 账本不管它；命令列表的缓存（daemon/commands-catalog.ts）用它更新。
 */
export interface CommandsChangedEvent extends DriverEventBase {
  type: "commands.changed";
  commands: ComposerCommand[];
}

/**
 * 会话里的后台任务个数变了（claude 的 system/background_tasks_changed，count 是现在还在跑的个数）。
 * 只有 claude 有这个信号，别家不出这个事件。账本记在内存里，hub worker show 显示；不入库、不推给网页。
 */
export interface BackgroundChangedEvent extends DriverEventBase {
  type: "background.changed";
  count: number;
}

/**
 * 上下文压缩完了（claude 的 system/compact_boundary：用户发了 /compact，或者 claude 自动压缩）。
 * 账本在对话里记一条“已压缩上下文”的系统消息；这一轮照常以 turn.ended 结束（/compact 没有文字回复）。
 */
export interface ContextCompactedEvent extends DriverEventBase {
  type: "context.compacted";
  uuid: string;
  /** manual：用户发的 /compact；auto：claude 自己压缩的；认不出是 null。 */
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
}

/** 进程起来、收到第一个 system/init。resumed：这次是 --resume。model：claude 实际报回来的模型（只在这里，不写会话那一行）。 */
export interface SessionStartedEvent extends DriverEventBase {
  type: "session.started";
  resumed: boolean;
  model: string | null;
  tools: string[];
}

/** 写进标准输入成功（codex：turn/start、turn/steer 收下了）→ 已送达。 */
export interface MessageDeliveredEvent extends DriverEventBase {
  type: "message.delivered";
  messageIds: MessageId[];
  /** 会话正忙时在这一轮中途交给 agent 的（不是开一轮的那条）：账本不拿它当“这一轮从这里开始”。 */
  midTurn?: true;
}

/** agent 取走了这些消息（claude 的 command_lifecycle started 或回显、codex 的 userMessage、agy 的 user_input）→ 处理中。 */
export interface MessageProcessingEvent extends DriverEventBase {
  type: "message.processing";
  messageIds: MessageId[];
}

/**
 * 已写给 agent、agent 还没取走的消息不会再被处理了 → 已取消（账本 delivered → cancelled，不自动重发）：
 * reason 只有 stop：用户点了停止（三家统一：claude 带 cancel_queued 的打断、codex 的 turn/completed interrupted、agy 打断时进程退出）。
 */
export interface MessageCancelledEvent extends DriverEventBase {
  type: "message.cancelled";
  messageIds: MessageId[];
  reason: "stop";
}

/**
 * 已写给 agent、agent 还没取走的消息被驱动层收回（进程崩溃、关机，或这一轮没读它就结束了且厂商不自己排下一轮）：
 * agent 没看到过，账本放回排队中（delivered → queued）、重新登记 session.send，驱动层下次照常写（不加崩溃说明）。
 */
export interface MessageRequeuedEvent extends DriverEventBase {
  type: "message.requeued";
  messageIds: MessageId[];
}

/**
 * claude 自己开了一轮（后台任务完成等，没有我们写的消息触发）：进程里已经有 init 了、手上又没有在途的消息时，这一轮的 init 就是它。
 * 这一轮结束时照常出 turn.ended，messageIds 是空的。
 */
export interface TurnStartedEvent extends DriverEventBase {
  type: "turn.started";
}

/**
 * 子任务（Agent / Task 工具派出去的）里的事件，原始事件的 parent_tool_use_id 照抄过来；主 agent 自己的事件没有这个字段。
 * 账本照常入库，但不拿它改“在做什么”（那是主 agent 的状态）。
 */
export interface SubtaskField {
  parentToolUseId?: string;
}

/** assistant 的一段文字。 */
export interface AgentTextEvent extends DriverEventBase, SubtaskField {
  type: "agent.text";
  uuid: string;
  text: string;
}

/** assistant 的一个 thinking 块（内容不带，只告诉账本“在思考”）。 */
export interface AgentThinkingEvent extends DriverEventBase, SubtaskField {
  type: "agent.thinking";
  uuid: string;
}

/** 工具结果回来了（user 事件里的 tool_result 块）：toolUseIds 是对应的 tool_use 的 id。 */
export interface AgentToolResultEvent extends DriverEventBase, SubtaskField {
  type: "agent.tool_result";
  toolUseIds: string[];
}

/** 一次工具调用（调用开始时出一个）。Message.text 的一行摘要由账本生成。 */
export interface AgentToolEvent extends DriverEventBase, SubtaskField {
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

/** 会话不存在或状态不合法时抛出的错误（继承 DriverError，不可重试）。 */
export class DriverSessionError extends DriverError {
  readonly reason: string;
  readonly sessionId: SessionId;
  constructor(reason: string, sessionId: SessionId) {
    super("internal_error", `${reason}: session ${sessionId}`);
    this.name = "DriverSessionError";
    this.reason = reason;
    this.sessionId = sessionId;
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
  | MessageCancelledEvent
  | MessageRequeuedEvent
  | TurnStartedEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | TurnEndedEvent
  | RateLimitEvent
  | ApiRetryEvent
  | SessionExitedEvent
  | DriverErrorEvent
  | CommandsChangedEvent
  | BackgroundChangedEvent
  | ContextCompactedEvent;

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
 *
 * 性格设定、模式变了不重启（不进 fingerprint）：系统提示词在整段对话最前面，一改整段缓存就失效，所以开头不动，
 * 在后面追加说明（照 Claude Code 发现 CLAUDE.md 改了的做法）：
 * - 每个会话记着 agent 已经看到的那一版（persona_changes 的编号），写进会话那一行（AgentSessionRow.personaRevision），守护进程重启也接得上；
 * - 写每一行（空闲时写、一轮中途写、排队的）之前调 DriverOptions.personaNote，变了就把说明放在前面的 text 块里，
 *   记下新的版本号，同一版只带一次；连改几次只带最新的；命令那一行不带（同别的说明，留给下一条）；没写成、agent 没读到的退回去，下一行再带；
 * - 新起的进程算不算按最新的拼过（driver/persona-note.ts）：新会话（--session-id、thread/start）、agy 每个新进程（第一条前面重新带系统指令）算，
 *   记下 LaunchFiles.personaRevision、不再带说明；claude --resume、codex thread/resume 都沿用会话最初的（实测，见 docs/persona-updates.md），
 *   空闲关闭、换模型、崩溃之后恢复的进程照样靠说明。
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
   * 会话正忙：厂商能在一轮中途收（claude 看 init 的 capabilities、codex 用 turn/steer）、进程起好了、不在关闭、不是命令，
   * 就在这一轮中途交给 agent，resolve 成 written（midTurn）；交出去的那一刻用户点了停止，resolve 成 cancelled；
   * 否则放进驱动层自己的待发队列，resolve 成 queued（见 DriverSendResult）。
   * 待发队列里用户消息排在系统消息前面，用户连发的拼成一条（只在自己排队时才拼）。
   * 这个会话已经调过 end（哪怕 end 还在等这一轮回完、还没 resolve）：直接抛 DriverError("session_ended")，不排队。
   */
  send(sessionId: SessionId, input: DriverSendInput): Promise<DriverSendResult>;
  /**
   * 先写 interrupt 控制消息，5 秒没回应发 SIGINT。已写给 agent、还没被取走的消息一律出 message.cancelled（reason stop），
   * 不自动重发（停止时厂商会接着跑、静默丢掉还是进程没了，差别由驱动层抹平）。
   */
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
  /**
   * 问正在跑的会话要命令列表（claude：往进程里再写一次 initialize 控制请求，实测约 10 毫秒，一轮进行中也行）。
   * 不起进程：没有进程、正在退出、超时、回了错误都返回 null，调用方另起一个进程问（daemon/commands-catalog.ts）。
   * 返回的已经换成通用形状，没去掉隐藏的。
   */
  queryCommands(sessionId: SessionId): Promise<ComposerCommand[] | null>;
  isRunning?(sessionId: SessionId): boolean;
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
  /**
   * 拼进提示词的性格设定、模式是哪一版（LaunchContext 的 personaRevision）。不进 fingerprint：变了不重启，
   * 见上面“两轮之间自动重启”的性格设定那段。没有（Worker）就不比。
   */
  personaRevision?: number;
}

/** personaNote 的结果：revision 是现在最新的版本号；note 是要加在前面的【系统】说明，只是版本号变了、内容没变是 null。 */
export interface PersonaNote {
  revision: number;
  note: string | null;
}

export interface DriverOptions {
  /** claude 程序路径（AGENT_HUB_CLAUDE）。 */
  claudePath: string;
  /** 数据目录 state/ 的路径（Worker 记忆保护判断用）。 */
  stateDir: string;
  store: SessionStore;
  /**
   * 每次启动前调用，生成提示词和设置文件；两轮之间判断要不要重启时也调（见上面“两轮之间自动重启”）。
   * 所以它要能反复调：同一个会话每次给的令牌一样（SessionTokens.issue 的约定），文件内容没变就给一样的 fingerprint。
   */
  prepareLaunch: (session: AgentSessionRow) => Promise<LaunchFiles>;
  /**
   * 往进程写一行之前调（同步）：sinceRevision 是 agent 已经看到的那一版。没变、不是项目经理的会话返回 null。
   * 抛错当没变（记 internal_error），照常写。不给就不比（老测试）。
   */
  personaNote?: (sessionId: SessionId, sinceRevision: number) => PersonaNote | null;
  /** 所有会话共用的额外环境变量（如 CLAUDE_CONFIG_DIR）。每个会话自己的在 LaunchFiles.env。 */
  env?: Record<string, string>;
  /** 记日志（不进 health 的事，比如 claude 出了 conversation_reset）。默认写标准错误。 */
  log?: (line: string) => void;
  /** 以下都有默认值，见 limits.ts；测试可以改小。 */
  idleCloseMs?: number;
  /** 有后台任务时最多不关多久（默认 BACKGROUND_TASKS_HOLD_MAX_MS）。 */
  backgroundHoldMaxMs?: number;
  interruptGraceMs?: number;
  /** 问正在跑的会话要命令列表最多等多久（queryCommands）。 */
  commandsTimeoutMs?: number;
  startTimeoutMs?: number;
  shutdownGraceMs?: number;
}
