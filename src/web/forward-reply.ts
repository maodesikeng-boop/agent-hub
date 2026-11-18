// 总助时间流里一条转交的回复（docs/router-forward-reply-design.md）：先看目标设备近窗里的消息，不在近窗才向那台设备补取。
// 本机和配对设备同一条路：近窗来自那台设备的 DeviceHub（实时推送、断线重连后重拉快照），补取走那台设备的 HubClient。
// 不变量：
// - 只认投递记录里的消息编号（RouterTurnDestination.forwardMessageId）和原消息上的 meta.replyId，不按时间、不按内容猜哪段话是回复。
// - 近窗里有原消息时以近窗为准；补取的结果只在近窗里没有原消息时用。
// - 同一台设备、同一个消息编号只补取一次；那台设备重拉快照（断线重连）后在途状态的补取结果作废、重新取。
import type { StoreApi } from "zustand";
import type { MessageId } from "../shared/domain.ts";
import type { TurnReplyState } from "../shared/turn-reply.ts";
import type { HubClient } from "./client.ts";
import type { RouterTurnDestination } from "./router-stream.ts";
import type { ConversationView, HubState } from "./state.ts";

/** 网页上一条转交的状态；unknown：近窗里没有、还没补取到，或那台设备离线。 */
export type ForwardReplyState = TurnReplyState | { kind: "unknown" };

/** 按设备键找那台设备的状态仓库；设备刚被删时是 null。 */
export type DeviceStoreLookup = (deviceKey: string) => StoreApi<HubState> | null;

/**
 * 后置：近窗里有 messageId 这条用户消息时返回它的状态；它有 replyId 但那条回复不在近窗里、或近窗里没有这条消息时返回 null（要补取）。
 * view 的 messages 数组没变时，同一个 messageId 返回同一个对象。
 */
export function forwardReplyOf(view: ConversationView | undefined, messageId: MessageId): TurnReplyState | null {
  throw new Error("未实现");
}

/**
 * 前置：dest.forwardMessageId 不是 null。
 * 后置：返回这条转交现在的状态。近窗能定的直接返回（会随那台设备的推送更新）；定不了时用 client 补取，取到前和设备离线时是 unknown，
 * 补取返回 404 时是 silent。同样的状态返回同一个对象，不让 memo 的组件白画。
 */
export function useForwardReply(dest: RouterTurnDestination, stores: DeviceStoreLookup, client: HubClient): ForwardReplyState {
  throw new Error("未实现");
}
