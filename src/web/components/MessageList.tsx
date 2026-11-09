import { ChevronDown } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isHandoverTraffic, isSilentTriggerMessage, type Message, type MessageId } from "../../shared/index.ts";
import { groupMessages } from "../selectors.ts";
import type { OlderState, PendingMessage } from "../state.ts";
import { Button } from "../ui/button.tsx";
import { EmptyConversation, MessageBubble, PendingBubble, TurnView, revertedChangeIds, type AgentIdentity, type MessageActions } from "./Messages.tsx";

/** 离底部不到这么多像素算“在底部”，内容变高、新消息来了跟着滚。 */
const STICK_DISTANCE_PX = 80;
/** 滚到离顶部这么近就加载更早的消息。 */
const LOAD_OLDER_DISTANCE_PX = 40;
/** 跳到某条消息后，高亮这么久。 */
const HIGHLIGHT_MS = 2_000;

const EMPTY_TURN = { work: [], parts: [], startedAt: 0, endedAt: 0 };

/**
 * 消息流（docs/ui-standard.md 第 17 条）：agent 的一轮回复一个头像，操作合成一行；打开、刷新、图片加载完、内容变高时，
 * 原本在底部的继续贴底（ResizeObserver），往上翻了就不拉回去。
 */
export const MessageList = memo(function MessageList({
  messages,
  pending,
  agentOf,
  hasMore,
  older,
  onLoadOlder,
  onRetry,
  actions,
  focus,
  onFocusDone,
  status,
  statusAgent,
}: {
  messages: Message[];
  pending: PendingMessage[];
  /** 一条消息署谁的名字（一轮回复按它的第一条）。 */
  agentOf: (message: Message) => AgentIdentity;
  hasMore: boolean;
  older: OlderState | undefined;
  onLoadOlder: () => void;
  onRetry: (clientId: string) => void;
  actions: MessageActions;
  /** 要跳到并高亮的消息；n 变了就再跳一次。 */
  focus?: { id: MessageId; n: number } | null;
  /** 这次跳转用完了，请清掉 focus。 */
  onFocusDone?: () => void;
  /**
   * agent 在忙时它在做什么（AgentStatus），没在忙是 null。最后一项是 agent 的一轮回复时显示在这一轮最下面；
   * 不是（这一轮还没出东西）时在列表底部单独出一轮“头像 名字 + 状态”，署名用 statusAgent。
   */
  status?: React.ReactNode;
  /** agent 是谁：状态那一轮、空对话用。 */
  statusAgent?: AgentIdentity;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [highlightId, setHighlightId] = useState<MessageId | null>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  /** 触发“加载更早”时的内容高度，加载完据此保持原来的位置。 */
  const anchorHeight = useRef<number | null>(null);
  const prevPendingCount = useRef(pending.length);

  const items = useMemo(() => groupMessages(messages), [messages]);
  const revertedChanges = useMemo(() => revertedChangeIds(messages), [messages]);
  const busy = status != null;
  // 只看显示出来的：写交接的来往、静默唤醒触发消息（不显示）进来不算新消息
  const lastKey = `${messages.findLast((m) => !isHandoverTraffic(m) && !isSilentTriggerMessage(m))?.id ?? 0}:${pending.length}:${busy}`;
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

  // 内容变高（图片加载完、展开明细、文字长出来）、滚动区变矮（输入框长高）：原本在底部就继续贴底，翻上去了不动。
  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 更早的消息接到前面后，保持用户正在看的那一条不动。
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && anchorHeight.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeight.current;
      anchorHeight.current = null;
    }
  }, [firstId]);

  // 点了“等你确定”里的某个问题：滚到那条消息，高亮一会儿。跳一次就用掉（通知 App 清掉），重新挂载时不会再跳
  useEffect(() => {
    if (!focus) return;
    ref.current?.querySelector(`[data-message-id="${focus.id}"]`)?.scrollIntoView({ block: "center" });
    setHighlightId(focus.id);
    onFocusDone?.();
  }, [focus, onFocusDone]);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const loadOlder = () => {
    anchorHeight.current = ref.current?.scrollHeight ?? null;
    onLoadOlder();
  };

  // 初始快照只带 hasMore、没带消息的历史对话（如已收工的 Worker）：点开时自动拉取最新一页。
  useEffect(() => {
    if (messages.length === 0 && hasMore && older === undefined) {
      onLoadOlder();
    }
  }, [messages.length, hasMore, older, onLoadOlder]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE_PX;
    stick.current = nearBottom;
    setAway(!nearBottom);
    if (hasMore && el.scrollTop < LOAD_OLDER_DISTANCE_PX) loadOlder();
  };

  /** 状态挂在最后一轮回复上；最后一项不是 agent 的回复（用户消息、Worker 的汇报、系统行、待发的）就在底部单独出一轮。 */
  const lastItem = items.at(-1);
  const rideOnTurn = busy && pending.length === 0 && lastItem?.kind === "turn";
  const typing = busy && !rideOnTurn && statusAgent !== undefined;
  const empty = messages.length === 0 && pending.length === 0 && !busy && !hasMore;

  return (
    <div className="relative flex h-full flex-col">
      <div className="messages min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain" ref={ref} role="log" aria-label="消息" onScroll={onScroll}>
        <div className="flex min-h-full flex-col pt-4 pb-12" ref={contentRef}>
          {hasMore && (
            <button
              type="button"
              className="touch-target mb-2 cursor-pointer self-center rounded-full px-3 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
              disabled={older === "loading"}
              onClick={loadOlder}
            >
              {older === "error" ? "加载失败，点击重试" : older === "loading" ? "加载中" : "加载更早的消息"}
            </button>
          )}
          {empty && <EmptyConversation identity={statusAgent} />}
          {items.map((item, index) => {
            if (item.kind === "turn") {
              const first = item.work[0] ?? item.parts[0]!;
              const turnStatus = rideOnTurn && index === items.length - 1 ? status : undefined;
              return (
                <TurnView
                  key={item.key}
                  turn={item}
                  identity={agentOf(first)}
                  status={turnStatus}
                  actions={actions}
                  highlightId={highlightId}
                  revertedChanges={revertedChanges}
                />
              );
            }
            const { message } = item;
            // Worker 对话里项目经理连说几句：只有第一句带头像
            const previous = items[index - 1];
            const head = !(previous?.kind === "message" && previous.message.sender === message.sender);
            return (
              <MessageBubble
                key={message.id}
                message={message}
                identity={agentOf(message)}
                head={head}
                actions={actions}
                highlighted={message.id === highlightId}
                revertedChanges={revertedChanges}
              />
            );
          })}
          {pending.map((p) => (
            <PendingBubble key={p.clientId} pending={p} onRetry={onRetry} />
          ))}
          {typing && statusAgent && <TurnView turn={EMPTY_TURN} identity={statusAgent} status={status} actions={actions} />}
        </div>
      </div>
      {/* 往上翻了：“回到底部”浮在输入框上方一点、消息列水平正中（照 t3code 的 Scroll to end）；消息区高度不变，文字照常滚动。回到底部就收起，贴底接着贴 */}
      {away && (
        <div className="messages pointer-events-none absolute inset-x-0 bottom-9 flex justify-center" data-back-to-bottom>
          <Button variant="secondary" size="icon-sm" className="pointer-events-auto" aria-label="回到底部" title="回到底部" onClick={scrollToBottom}>
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
});
