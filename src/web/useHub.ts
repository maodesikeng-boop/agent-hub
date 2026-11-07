// 把接口、WebSocket 和 state.ts 接起来：先拉快照，再按 seq 接着收变化；收到 resync 重新拉。
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ATTACHMENTS_MISSING_MESSAGE, type Attachment, type Change, type ConversationId, type MessageId, userMessageDedupeKey } from "../shared/index.ts";
import { ApiError, fetchOlderMessages, fetchState, postMessage, postRetryMessage, postStop } from "./client.ts";
import { openChangeStream, type ConnectionStatus } from "./connection.ts";
import { newClientId } from "./format.ts";
import { uploadFiles } from "./upload.ts";
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
      reportPresence: true,
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

  const submit = useCallback(async (conversationId: ConversationId, clientId: string, text: string, attachmentIds: string[]) => {
    try {
      await postMessage(conversationId, { clientId, text, ...(attachmentIds.length > 0 ? { attachmentIds } : {}) });
    } catch (err) {
      // 400：服务端拒绝了这条消息（同一个 clientId 重发还是会被拦，重试永远不会成功）：带的文件找不到了要重新添加，
      // 别的原因（比如手打了不能用的命令）把服务端的 error 原样显示
      const rejected = err instanceof ApiError && err.status === 400;
      const missing = rejected && err.message === ATTACHMENTS_MISSING_MESSAGE;
      if (alive.current) {
        dispatch({
          type: "pendingPhase",
          clientId,
          phase: "failed",
          ...(missing ? { failure: "attachments_missing" as const } : rejected ? { failure: "rejected" as const, reason: err.message } : {}),
        });
      }
    }
  }, []);

  /** 消息先显示出来（排队中），再发给服务端。 */
  const post = useCallback(
    (conversationId: ConversationId, text: string, attachments: Attachment[]) => {
      const clientId = newClientId();
      dispatch({
        type: "pendingAdd",
        pending: { clientId, conversationId, text, attachments, phase: "sending", createdAt: Date.now() },
      });
      void submit(conversationId, clientId, text, attachments.map((a) => a.id));
    },
    [submit],
  );

  const send = useCallback((conversationId: ConversationId, text: string) => post(conversationId, text, []), [post]);

  /**
   * 先发、等接口回应再显示（以 / 开头的消息：手打的命令可能被拦）：被拦（400，Error.message 是原因）reject，什么都没留下，
   * 输入框那边显示原因、原文不动；发出去了就显示成排队中；网络、服务出错和普通消息一样变成可重试的待发消息。
   */
  const sendChecked = useCallback(
    async (conversationId: ConversationId, text: string) => {
      const clientId = newClientId();
      const pending = { clientId, conversationId, text, attachments: [], createdAt: Date.now() };
      try {
        await postMessage(conversationId, { clientId, text });
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) throw new Error(err.message);
        if (alive.current) dispatch({ type: "pendingAdd", pending: { ...pending, phase: "failed" } });
        return;
      }
      // 服务端的推送可能比 POST 的回应先到：消息已经在列表里了就不再加临时消息
      const key = userMessageDedupeKey(conversationId, clientId);
      const arrived = stateRef.current.conversations[conversationId]?.messages.some((m) => m.sender === "user" && m.dedupeKey === key);
      if (alive.current && !arrived) dispatch({ type: "pendingAdd", pending: { ...pending, phase: "sending" } });
    },
    [],
  );

  /**
   * 带文件发：先把文件都传上去，都传好了才发消息；传失败 reject（Error.message 是中文），这时什么消息都没发出去。
   * 传的时候不显示临时消息（输入框那边显示“发送中”）。
   */
  const sendWithFiles = useCallback(
    async (conversationId: ConversationId, text: string, files: File[]) => {
      const attachments = await uploadFiles(files);
      if (alive.current) post(conversationId, text, attachments);
    },
    [post],
  );

  /** 重发：同一个 clientId、同样的附件，服务端按 clientId 去重。 */
  const retrySend = useCallback(
    (clientId: string) => {
      const pending = stateRef.current.pending.find((p) => p.clientId === clientId);
      if (!pending) return;
      dispatch({ type: "pendingPhase", clientId, phase: "sending" });
      void submit(pending.conversationId, clientId, pending.text, pending.attachments.map((a) => a.id));
    },
    [submit],
  );

  /** 服务端标了失败的用户消息：请求重试。排进队之后的变化从 WebSocket 来（message.updated），这里只管请求本身。 */
  const retryMessage = useCallback(async (messageId: MessageId) => {
    dispatch({ type: "retryStart", messageId });
    try {
      await postRetryMessage(messageId);
    } catch {
      if (alive.current) dispatch({ type: "retryFailed", messageId });
    }
  }, []);

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

  return { state, reload: loadState, send, sendChecked, sendWithFiles, retrySend, retryMessage, stop, loadOlder };
}
