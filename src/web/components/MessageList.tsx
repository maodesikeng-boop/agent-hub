import { useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../../shared/index.ts";
import { groupMessages } from "../selectors.ts";
import type { OlderState, PendingMessage } from "../state.ts";
import { MessageBubble, PendingBubble, ToolGroup } from "./Messages.tsx";

/** 离底部不到这么多像素算“在底部”，新消息来了跟着滚。 */
const STICK_DISTANCE_PX = 80;
/** 滚到离顶部这么近就加载更早的消息。 */
const LOAD_OLDER_DISTANCE_PX = 40;

export function MessageList({
  messages,
  pending,
  agent,
  hasMore,
  older,
  onLoadOlder,
  onRetry,
}: {
  messages: Message[];
  pending: PendingMessage[];
  agent: { name: string; avatarKey: number };
  hasMore: boolean;
  older: OlderState | undefined;
  onLoadOlder: () => void;
  onRetry: (clientId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  /** 触发“加载更早”时的内容高度，加载完据此保持原来的位置。 */
  const anchorHeight = useRef<number | null>(null);
  const prevPendingCount = useRef(pending.length);

  const items = groupMessages(messages);
  const lastKey = `${messages.at(-1)?.id ?? 0}:${pending.length}`;
  const firstId = messages[0]?.id ?? 0;

  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
  };

  // 打开对话、来了新消息：在底部就跟着滚；自己刚发的一定滚。
  useLayoutEffect(() => {
    const own = pending.length > prevPendingCount.current;
    prevPendingCount.current = pending.length;
    if (stick.current || own) scrollToBottom();
    else setAway(true);
  }, [lastKey]);

  // 更早的消息接到前面后，保持用户正在看的那一条不动。
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && anchorHeight.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeight.current;
      anchorHeight.current = null;
    }
  }, [firstId]);

  const loadOlder = () => {
    anchorHeight.current = ref.current?.scrollHeight ?? null;
    onLoadOlder();
  };

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE_PX;
    stick.current = nearBottom;
    setAway(!nearBottom);
    if (hasMore && el.scrollTop < LOAD_OLDER_DISTANCE_PX) loadOlder();
  };

  let previous: "agent" | "other" | null = null;
  return (
    <div className="messages-wrap">
      <div className="messages" ref={ref} role="log" aria-label="消息" onScroll={onScroll}>
        {hasMore && (
          <button type="button" className="older" disabled={older === "loading"} onClick={loadOlder}>
            {older === "error" ? "加载失败，点击重试" : older === "loading" ? "加载中" : "加载更早的消息"}
          </button>
        )}
        {items.map((item) => {
          const head = previous !== "agent";
          if (item.kind === "tools") {
            previous = "agent";
            return <ToolGroup key={item.key} messages={item.messages} identity={agent} head={head} />;
          }
          previous = item.message.sender === "agent" ? "agent" : "other";
          return <MessageBubble key={item.message.id} message={item.message} identity={agent} head={head} />;
        })}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} pending={p} onRetry={onRetry} />
        ))}
      </div>
      {away && (
        <button type="button" className="to-bottom" aria-label="回到底部" onClick={scrollToBottom}>
          <span className="chevron down" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
