// 后台写交接（docs/background-handover-design.md）：账本（ledger/handover.ts，同步、只做判断）和跑腿的（daemon/handover/runner.ts，
// 异步、只干活）之间的约定。一次交接是 handovers 表的一行（0013），状态见 HANDOVER_STATUSES。
// 跑腿的一次活：claimHandover 领 → 按 FORKERS 的清单 fork → handoverForked → write → handoverWritten（出错 handoverFailed）
// → 复制那份 remove → handoverCleaned。守护进程启动时 uncleanedHandovers 补清上次没清掉的。
// 判断（能不能开始、换不换代、算不算失败次数、退避、作废）全在账本；跑腿的报什么就是什么，不自己判断。
import type { AgentSessionRow, ConversationId, TokenUsage } from "./domain.ts";

export type HandoverId = number;

/**
 * queued：到门槛了，等旧会话两轮之间的空当；forking：跑腿的领走了，正在复制；writing：复制那份在写交接；
 * ready：交接写好了，等旧会话这一轮结束换代；switched：换代了；failed：没写成（按退避再来）；abandoned：作废（ready 放太久等，不算失败次数）。
 */
export const HANDOVER_STATUSES = ["queued", "forking", "writing", "ready", "switched", "failed", "abandoned"] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];
/** 不在终态的：每个对话同时最多一行（0013 的部分唯一索引 handovers_active）。 */
export const ACTIVE_HANDOVER_STATUSES: readonly HandoverStatus[] = ["queued", "forking", "writing", "ready"];

/** 复制的办法：native 厂商自带（claude --fork-session、codex thread/fork）；copy 自己造的（agy 拷库，靠没公开的格式）。 */
export type ForkerKind = "native" | "copy";
/** handovers.method：用的哪个办法（排查用）。in_session 是清单走完都不支持时的兜底：本会话写交接 + 用户一发消息就打断。 */
export type HandoverMethod = ForkerKind | "in_session";

/** 复制那份的身份，由厂商的 SessionForker.fork 给。remove 只拿得到它（重启后从 fork_ref 读回来），清理要用的路径等都放进 extra。 */
export interface ForkHandle {
  forkId: string;
  extra?: Record<string, string>;
}

/** handovers.fork_ref 存的 JSON：哪个办法（SessionForker.id）复制的 + 它给的 handle。重启后凭 forker 找回同一个办法来 remove。 */
export interface ForkRef {
  forker: string;
  handle: ForkHandle;
}

/** claimHandover 领到的一次活。 */
export interface HandoverJob {
  handoverId: HandoverId;
  conversationId: ConversationId;
  /** 旧会话（复制的来源）：跑腿的拿它 prepareLaunch、拼 ForkSource（daemon/handover/forker.ts 的 forkSourceOf）。 */
  session: AgentSessionRow;
  auto: boolean;
  /** 发给复制那份的交接提示词，账本拼好（提示词集中在 ledger/handover.ts）。 */
  prompt: string;
}

/**
 * 跑腿的报的失败：
 * - unsupported：这家的办法清单是空的，或清单里每个办法都抛了 ForkUnsupportedError → 账本退回 in_session，不算失败次数；
 * - error：进程起不来、退出码非 0、网络等 → 算一次失败，按退避再来；
 * - timeout：从领到起超过 HANDOVER_TIMEOUT_MS，跑腿的已经 abort → 算一次失败；
 * - shutdown：守护进程在关，跑腿的取消了 → 同重启，不算失败次数。
 * 写出来是空的不在这里：照常调 handoverWritten，空不空由账本判断（handover_empty）。
 */
export interface HandoverFailure {
  kind: "unsupported" | "error" | "timeout" | "shutdown";
  /** 写进 failure_reason 和日志的原因（错误消息、哪几个办法不支持）。 */
  detail: string;
}

/** 要补清的复制那份：终态（或已 ready）、有 fork_ref、没 cleaned_at 的行。 */
export interface HandoverCleanJob {
  handoverId: HandoverId;
  /** 旧会话的厂商（AgentSessionRow.vendor）。 */
  vendor: string;
  ref: ForkRef;
}

/**
 * 账本给跑腿的用的几个方法（ledger/handover.ts 实现，Ledger 接口 extends 它）。都是同步的、各自一个事务；
 * 对不上的报告（这一行已经不在对应状态：被作废了、重启时记了失败、报过一次了）一律静默忽略，不抛错，跑腿的照常往下清理。
 */
export interface LedgerHandoverWork {
  /**
   * 领一次活：挑一行能开始的 queued（旧会话空闲、没有发给它还在路上的消息、过了退避），改成 forking，记切点 cut_message_id、
   * started_at；没有就返回 null。跑腿的有空位（HANDOVER_CONCURRENCY）就领，领到 null 为止；
   * 账本有行可以领时调 LedgerOptions.onHandoverClaimable 叫醒它，跑腿的自己也每 AUTO_RENEW_TICK_MS 领一次兜底。
   */
  claimHandover(): HandoverJob | null;
  /**
   * 复制好了：不管怎样都存 fork_ref 和 method（之后凭它清理）。这一行还是 forking → 改成 writing，返回 true（接着 write）；
   * 已经不是了（作废、记了失败）→ 返回 false：别写了，直接 remove 再 handoverCleaned。
   */
  handoverForked(handoverId: HandoverId, fork: { kind: ForkerKind; ref: ForkRef }): boolean;
  /** 写完了：存 text、usage（复制那份的用量，不进项目经理会话），之后 ready 或直接换代；text 空白记 failed（handover_empty）。 */
  handoverWritten(handoverId: HandoverId, result: { text: string; usage: TokenUsage }): void;
  /** forking、writing 时出错（见 HandoverFailure）：记 failed（或退回 in_session），算不算次数、退避由账本定。 */
  handoverFailed(handoverId: HandoverId, failure: HandoverFailure): void;
  /** 复制那份删掉了（或本来就没留下）：记 cleaned_at。幂等。跑腿的在 handoverWritten / handoverFailed 之后马上清，不等换代。 */
  handoverCleaned(handoverId: HandoverId): void;
  /** 守护进程启动时：有 fork_ref、没 cleaned_at、不在 forking / writing 的行（账本启动时先把 forking / writing 记成 failed(restart)）。 */
  uncleanedHandovers(): HandoverCleanJob[];
}
