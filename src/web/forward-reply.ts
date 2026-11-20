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

export type ForwardReplyState = TurnReplyState | { kind: "unknown" };

export type DeviceStoreLookup = (deviceKey: string) => StoreApi<HubState> | null;

const UNKNOWN: ForwardReplyState = { kind: "unknown" };
const SILENT: ForwardReplyState = { kind: "silent" };
const SETTLED_STATUSES: ReadonlySet<Message["status"]> = new Set(["replied", "stopped", "cancelled", "failed"]);
const noopSubscribe = () => () => {};

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

export const forwardReplyQueryKey = (deviceKey: DeviceKey, messageId: MessageId) => ["router-forward-reply", deviceKey, messageId] as const;

const isSettled = (data: Fetched | undefined) => data?.outcome === "ok" && SETTLED_STATUSES.has(data.view.request.status);

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
      staleTime: (query) => (isSettled(query.state.data) ? Infinity : query.state.data?.outcome === "ok" ? 0 : ROUTER_FORWARD_REPLY_MISS_RETRY_MS),
    },
    qc,
  );

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
