// 把接口、WebSocket 和 state.ts 接起来：先拉快照，再按 seq 接着收变化；收到 resync 重新拉。
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Change, ConversationId } from "../shared/index.ts";
import { ApiError, fetchOlderMessages, fetchState, postMessage, postStop } from "./client.ts";
import { openChangeStream, type ConnectionStatus } from "./connection.ts";
import { newClientId } from "./format.ts";
import { initialState, oldestMessageId, referencesUnknownConversation, reducer } from "./state.ts";

/** resync 拉快照失败后隔多久再试。 */
const RESYNC_RETRY_MS = 3_000;

export function useHub() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 已经交给界面的最后一个 seq；重连时从它之后补。 */
  const seqRef = useRef(0);
  /** 正在 resync 时到的变化先存在这里；null 表示没在 resync。 */
  const buffer = useRef<Change[] | null>(null);
  const streamStatus = useRef<ConnectionStatus>("connecting");
  const olderInFlight = useRef(new Set<ConversationId>());
  const alive = useRef(true);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyChange = useCallback((change: Change) => {
    if (change.seq <= seqRef.current) return;
    seqRef.current = change.seq;
    dispatch({ type: "change", change });
  }, []);

  const loadState = useCallback(async () => {
    dispatch({ type: "loading" });
    try {
      const snapshot = await fetchState();
      if (!alive.current) return;
      seqRef.current = snapshot.seq;
      dispatch({ type: "loaded", snapshot });
    } catch (err) {
      if (!alive.current) return;
      dispatch({ type: "loadFailed", unauthorized: err instanceof ApiError && err.status === 401 });
    }
  }, []);

  /** 重新拉快照；拉的时候到的变化先存着，快照之后的再补上。拉不到就一直重试。 */
  const resync = useCallback(async (first: Change[] = []) => {
    if (buffer.current) {
      buffer.current.push(...first);
      return;
    }
    buffer.current = [...first];
    while (alive.current) {
      try {
        const snapshot = await fetchState();
        if (!alive.current) return;
        const queued = buffer.current ?? [];
        buffer.current = null;
        seqRef.current = snapshot.seq;
        dispatch({ type: "loaded", snapshot });
        for (const change of queued.toSorted((a, b) => a.seq - b.seq)) applyChange(change);
        dispatch({ type: "connection", status: streamStatus.current });
        return;
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 401) {
          buffer.current = null;
          dispatch({ type: "loadFailed", unauthorized: true });
          return;
        }
        dispatch({ type: "connection", status: "reconnecting" });
        await new Promise<void>((resolve) => {
          retryTimer.current = setTimeout(resolve, RESYNC_RETRY_MS);
        });
      }
    }
  }, [applyChange]);

  useEffect(() => {
    alive.current = true;
    void loadState();
    return () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
    };
  }, [loadState]);

  const ready = state.phase === "ready";
  useEffect(() => {
    if (!ready) return;
    return openChangeStream({
      getSince: () => seqRef.current,
      onStatus: (status) => {
        streamStatus.current = status;
        // 重新拉快照的过程中一直显示“重连中”，拉完再按连接的真实状态显示
        dispatch({ type: "connection", status: buffer.current ? "reconnecting" : status });
      },
      onMessage: (message) => {
        if (message.type === "resync") {
          void resync();
        } else if (buffer.current) {
          buffer.current.push(message);
        } else if (referencesUnknownConversation(stateRef.current, message)) {
          void resync([message]);
        } else {
          applyChange(message);
        }
      },
    });
  }, [ready, resync, applyChange]);

  const submit = useCallback(async (conversationId: ConversationId, clientId: string, text: string) => {
    try {
      await postMessage(conversationId, { clientId, text });
    } catch {
      if (alive.current) dispatch({ type: "pendingPhase", clientId, phase: "failed" });
    }
  }, []);

  const send = useCallback(
    (conversationId: ConversationId, text: string) => {
      const clientId = newClientId();
      dispatch({
        type: "pendingAdd",
        pending: { clientId, conversationId, text, phase: "sending", createdAt: Date.now() },
      });
      void submit(conversationId, clientId, text);
    },
    [submit],
  );

  /** 重发：同一个 clientId，服务端按它去重。 */
  const retrySend = useCallback(
    (clientId: string) => {
      const pending = stateRef.current.pending.find((p) => p.clientId === clientId);
      if (!pending) return;
      dispatch({ type: "pendingPhase", clientId, phase: "sending" });
      void submit(pending.conversationId, clientId, pending.text);
    },
    [submit],
  );

  const stop = useCallback((conversationId: ConversationId) => postStop(conversationId), []);

  const loadOlder = useCallback(async (conversationId: ConversationId) => {
    const view = stateRef.current.conversations[conversationId];
    if (!view?.hasMore || olderInFlight.current.has(conversationId)) return;
    const before = oldestMessageId(view);
    if (before === null) return;
    olderInFlight.current.add(conversationId);
    dispatch({ type: "olderStart", conversationId });
    try {
      const page = await fetchOlderMessages(conversationId, before);
      if (alive.current) dispatch({ type: "olderDone", conversationId, messages: page.messages, hasMore: page.hasMore });
    } catch {
      if (alive.current) dispatch({ type: "olderFailed", conversationId });
    } finally {
      olderInFlight.current.delete(conversationId);
    }
  }, []);

  return { state, reload: loadState, send, retrySend, stop, loadOlder };
}
