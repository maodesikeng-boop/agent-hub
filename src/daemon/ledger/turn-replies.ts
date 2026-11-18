// 项目经理一轮的正式回复挂回它处理的用户消息（docs/router-forward-reply-design.md，规则见 shared/turn-reply.ts 顶部）。
// ledger.ts 的 applyDriverEvent 在 messages.applyEvent 之后、同一个事务里调 afterDriverEvent；界面服务的 GET /api/messages/:id/turn-reply 调 turnReplyOf。
// 不变量：
// - 只看项目经理会话（role pm）；Worker、总助单轮会话的事件直接跳过。
// - 内存里只记在途的东西（每个会话这一轮最后一段顶层文字、每条在途消息送达时的最大消息编号），这一轮结束或会话退出就清掉。
//   守护进程重启后在途的轮次本来就会被标成已停止或重新排队，不需要恢复。
import type { DriverEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, MessageId } from "../../shared/domain.ts";
import type { TurnReplyView } from "../../shared/turn-reply.ts";
import type { LedgerContext, Pending } from "./context.ts";

export interface LedgerTurnReplies {
  /**
   * 前置：在 applyDriverEvent 的写事务里、messages.applyEvent 之后调。
   * 后置：turn.ended 里状态变成 replied 的用户消息，若这一轮在它送达之后写过顶层文字，meta.replyId 记成最后那一段的编号，
   * 并推一条 message.updated；已经有 replyId 的不改。别的事件不写库。
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  /**
   * 后置：messageId 是项目经理对话里的用户消息时返回它和 replyId 指向的回复（没有 replyId 或回复已被清理时 reply 是 null）；
   * 不存在、不是用户消息、不在项目经理对话里返回 null（界面服务回 404）。
   */
  turnReplyOf(messageId: MessageId): TurnReplyView | null;
}

export function createLedgerTurnReplies(ctx: LedgerContext): LedgerTurnReplies {
  throw new Error("未实现");
}
