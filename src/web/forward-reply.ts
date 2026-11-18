// 总助时间流里一条转交的回复（docs/router-forward-reply-design.md）：先看目标设备近窗里的消息，不在近窗才向那台设备补取。
// 本机和配对设备同一条路：近窗来自那台设备的 DeviceHub（实时推送、断线重连后重拉快照），补取走那台设备的 HubClient。
// 不变量：
// - 只认投递记录里的消息编号（RouterTurnDestination.forwardMessageId）和原消息上的 meta.replyId，不按时间、不按内容猜哪段话是回复。
// - 近窗里有原消息时以近窗为准；补取的结果只在近窗里没有原消息时用。
// - 同一台设备、同一个消息编号只补取一次；在途状态的补取结果在三种情况下作废重取：那台设备重新连上、重拉了快照（HubState.snapshotRev），
//   或那台设备推来的这条消息所在对话的更新被近窗丢掉了（ConversationView.outsideRev：消息已滑出近窗，状态变化只有重取才看得到）。
// - 那台设备的首份快照到了（phase ready）才补取：快照一到，近窗里多半就有这条消息，不用先发请求。
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand";
import { ROUTER_FORWARD_REPLY_MISS_RETRY_MS } from "../shared/limits.ts";
import type { DeviceKey } from "./devices.ts";
import type { Message, MessageId } from "../shared/domain.ts";
import { replyIdOf, turnReplyStateOf } from "../shared/turn-reply.ts";
import type { TurnReplyState, TurnReplyView } from "../shared/turn-reply.ts";
import { ApiError } from "./client.ts";
import type { HubClient } from "./client.ts";
import { useHubQueryClient } from "./query-client.ts";
import type { RouterTurnDestination } from "./router-stream.ts";
import type { ConversationView, HubState } from "./state.ts";

/** 网页上一条转交的状态；unknown：近窗里没有、还没补取到，或那台设备离线。 */
export type ForwardReplyState = TurnReplyState | { kind: "unknown" };

/** 按设备键找那台设备的状态仓库；设备刚被删时是 null。 */
export type DeviceStoreLookup = (deviceKey: string) => StoreApi<HubState> | null;

const UNKNOWN: ForwardReplyState = { kind: "unknown" };
const SILENT: ForwardReplyState = { kind: "silent" };
const SETTLED_STATUSES: ReadonlySet<Message["status"]> = new Set(["replied", "stopped", "cancelled", "failed"]);
const noopSubscribe = () => () => {};

/** 消息按编号从小到大：二分找一条，近窗最多 MAX_LIVE_MESSAGES 条，每次重画都找也不贵。 */
function findById(messages: readonly Message[], id: MessageId): Message | undefined {
  let lo = 0;
  let hi = messages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = messages[mid]!;
    if (m.id === id) return m;
    if (m.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * 后置：近窗里有 messageId 这条用户消息时返回它的状态；它有 replyId 但那条回复不在近窗里、或近窗里没有这条消息时返回 null（要补取）。
 * 对话里来了无关的新消息，已定的状态对象不变（turnReplyStateOf 按原消息和回复对象缓存）。
 */
export function forwardReplyOf(view: ConversationView | undefined, messageId: MessageId): TurnReplyState | null {
  if (view === undefined) return null;
  const request = findById(view.messages, messageId);
  if (request === undefined || request.sender !== "user") return null;
  const replyId = request.status === "replied" ? replyIdOf(request) : null;
  if (replyId === null) return turnReplyStateOf(request, null);
  const reply = findById(view.messages, replyId);
  return reply === undefined ? null : turnReplyStateOf(request, reply);
}

type Fetched = { outcome: "ok"; view: TurnReplyView } | { outcome: "missing" } | { outcome: "failed" };

/** 补取结果缓存在 react-query 里，键带设备键：本机和配对设备上编号相同的两条消息互不串。 */
export const forwardReplyQueryKey = (deviceKey: DeviceKey, messageId: MessageId) => ["router-forward-reply", deviceKey, messageId] as const;

const isSettled = (data: Fetched | undefined) => data?.outcome === "ok" && SETTLED_STATUSES.has(data.view.request.status);

/**
 * 前置：dest.forwardMessageId 不是 null。
 * 后置：返回这条转交现在的状态。近窗能定的直接返回（会随那台设备的推送更新）；定不了时用 client 补取，取到前和设备离线时是 unknown，
 * 补取返回 404 时是 silent。同样的状态返回同一个对象，不让 memo 的组件白画。
 */
export function useForwardReply(dest: RouterTurnDestination, stores: DeviceStoreLookup, client: HubClient): ForwardReplyState {
  const messageId = dest.forwardMessageId!;
  const { deviceKey, conversationId } = dest;
  const qc = useHubQueryClient();
  const store = stores(deviceKey);
  const subscribe = useCallback((listener: () => void) => (store === null ? noopSubscribe() : store.subscribe(listener)), [store]);
  const windowed = useSyncExternalStore(subscribe, () => (store === null ? null : forwardReplyOf(store.getState().conversations[conversationId], messageId)));
  const ready = useSyncExternalStore(subscribe, () => store !== null && store.getState().phase === "ready");
  const needFetch = windowed === null && ready;

  const { data } = useQuery(
    {
      queryKey: forwardReplyQueryKey(deviceKey, messageId),
      enabled: needFetch,
      queryFn: async (): Promise<Fetched> => {
        try {
          return { outcome: "ok", view: await client.fetchTurnReply(messageId) };
        } catch (err) {
          return err instanceof ApiError && err.status === 404 ? { outcome: "missing" } : { outcome: "failed" };
        }
      },
      // 已经定了的（有回复、已停止、已失败）不再取；没取到、404 只短暂记；还在处理中的每次挂载都重取
      staleTime: (query) => (isSettled(query.state.data) ? Infinity : query.state.data?.outcome === "ok" ? 0 : ROUTER_FORWARD_REPLY_MISS_RETRY_MS),
    },
    qc,
  );

  // 在途状态的补取结果什么时候作废：重新连上、重拉了快照，或这条消息所在对话有被近窗丢掉的更新（断线期间错过的推送不会补发给近窗以外的消息）
  useEffect(() => {
    if (store === null || !needFetch || isSettled(data)) return;
    const signalOf = (state: HubState) => ({ open: state.connection === "open", snapshotRev: state.snapshotRev, outsideRev: state.conversations[conversationId]?.outsideRev ?? 0 });
    let last = signalOf(store.getState());
    return store.subscribe((state) => {
      const now = signalOf(state);
      const changed = (now.open && !last.open) || now.snapshotRev !== last.snapshotRev || now.outsideRev !== last.outsideRev;
      last = now;
      if (changed) void qc.invalidateQueries({ queryKey: forwardReplyQueryKey(deviceKey, messageId) });
    });
  }, [needFetch, data, store, qc, deviceKey, messageId, conversationId]);

  if (windowed !== null) return windowed;
  if (data?.outcome === "ok") return turnReplyStateOf(data.view.request, data.view.reply);
  if (data?.outcome === "missing") return SILENT;
  return UNKNOWN;
}
