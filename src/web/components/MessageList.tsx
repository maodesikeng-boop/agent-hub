import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message, MessageId } from "../../shared/index.ts";
import { groupMessages } from "../selectors.ts";
import type { OlderState, PendingMessage } from "../state.ts";
import { Button } from "../ui/button.tsx";
import { AgentTyping, MessageBubble, PendingBubble, ToolGroup, type AgentIdentity, type MessageActions } from "./Messages.tsx";

/** 离底部不到这么多像素算“在底部”，新消息来了跟着滚。 */
const STICK_DISTANCE_PX = 80;
/** 滚到离顶部这么近就加载更早的消息。 */
const LOAD_OLDER_DISTANCE_PX = 40;
/** 跳到某条消息后，高亮这么久。 */
const HIGHLIGHT_MS = 2_000;

export function MessageList({
  messages,
  pending,
  agentOf,
  hasMore,
  older,
  onLoadOlder,
  onRetry,
  actions,
  focus,
  status,
  statusAgent,
}: {
  messages: Message[];
  pending: PendingMessage[];
  /** 一条消息署谁的名字。 */
  agentOf: (message: Message) => { name: string; avatarKey: number };
  hasMore: boolean;
  older: OlderState | undefined;
  onLoadOlder: () => void;
  onRetry: (clientId: string) => void;
  actions: MessageActions;
  /** 要跳到并高亮的消息；n 变了就再跳一次。 */
  focus?: { id: MessageId; n: number } | null;
  /**
   * agent 在忙时它在做什么（AgentStatus），没在忙是 null。显示在这一轮最后一条回复的头像行上；
   * 最后一条不是 agent 的回复（这一轮还没出回复）时，在列表底部单独出一行“头像 名字 · 状态”，名字用 statusAgent。
   */
  status?: React.ReactNode;
  statusAgent?: AgentIdentity;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlightId, setHighlightId] = useState<MessageId | null>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  /** 触发“加载更早”时的内容高度，加载完据此保持原来的位置。 */
  const anchorHeight = useRef<number | null>(null);
  const prevPendingCount = useRef(pending.length);

  const items = groupMessages(messages);
  const lastKey = `${messages.at(-1)?.id ?? 0}:${pending.length}:${status != null}`;
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

  // 点了“等你确定”条里的某个问题：滚到那条消息，高亮一会儿
  useEffect(() => {
    if (!focus) return;
    ref.current?.querySelector(`[data-message-id="${focus.id}"]`)?.scrollIntoView({ block: "center" });
    setHighlightId(focus.id);
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focus]);

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

  /** 状态跟着最后一项走：它是 agent 的回复（文字或一组操作）就接在它的头像行上，不然（用户消息、系统消息、待发的）单独出一行。 */
  const lastItem = items.at(-1);
  const rideOnLast = status != null && pending.length === 0 && lastItem !== undefined && (lastItem.kind === "tools" || lastItem.message.sender === "agent");
  const typing = status != null && !rideOnLast && statusAgent !== undefined;

  /** 上一项是哪个 agent 说的（头像编号）；不是 agent 的消息是 null。换人也要重新署名。 */
  let previous: number | null = null;
  return (
    <div className="relative h-full">
      <div className="messages flex h-full flex-col overflow-y-auto pt-4 pb-6" ref={ref} role="log" aria-label="消息" onScroll={onScroll}>
        {hasMore && (
          <button
            type="button"
            className="mt-1 cursor-pointer self-center rounded-full border border-border px-3.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
            disabled={older === "loading"}
            onClick={loadOlder}
          >
            {older === "error" ? "加载失败，点击重试" : older === "loading" ? "加载中" : "加载更早的消息"}
          </button>
        )}
        {items.map((item) => {
          const message = item.kind === "tools" ? item.messages[0]! : item.message;
          const identity = agentOf(message);
          const head = previous !== identity.avatarKey;
          const itemStatus = rideOnLast && item === lastItem ? status : undefined;
          if (item.kind === "tools") {
            previous = identity.avatarKey;
            return <ToolGroup key={item.key} messages={item.messages} identity={identity} head={head} status={itemStatus} />;
          }
          previous = item.message.sender === "agent" || item.message.sender === "pm" ? identity.avatarKey : null;
          return (
            <MessageBubble
              key={item.message.id}
              message={item.message}
              identity={identity}
              head={head}
              status={itemStatus}
              actions={actions}
              highlighted={item.message.id === highlightId}
            />
          );
        })}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} pending={p} onRetry={onRetry} />
        ))}
        {typing && statusAgent && <AgentTyping identity={statusAgent} status={status} />}
      </div>
      {away && (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
