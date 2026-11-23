import { ChevronDown } from "../ui/icons.ts";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { attachmentsOf, isHandoverTraffic, isRewoundMessage, isSilentTriggerMessage, userMessageDedupeKey, type Message, type MessageId, type PersonaChangeId } from "../../shared/index.ts";
import { groupMessages } from "../selectors.ts";
import type { OlderState, PendingMessage } from "../state.ts";
import { groupMessageRows, type DisplayRow } from "../system-events.ts";
import { Button } from "../ui/button.tsx";
import { useMessageEnter, type EnterItem } from "../useMessageEnter.ts";
import { useStickToBottom } from "../useStickToBottom.ts";
import { useFocusMessage, useVirtualRows } from "../useVirtualRows.ts";
import { EmptyConversation, EventGroupView, MessageBubble, PendingBubble, TurnView, revertedChangeIds, type AgentIdentity, type MessageActions } from "./Messages.tsx";

const EMPTY_TURN = { work: [], parts: [], startedAt: 0, endedAt: 0 };

interface RowContext {
  items: readonly DisplayRow[];
  pending: PendingMessage[];
  agentOf: (message: Message) => AgentIdentity;
  onRetry: (clientId: string) => void;
  actions: MessageActions;
  highlightId: MessageId | null;
  revertedChanges: ReadonlySet<PersonaChangeId>;
  lastTurnStatus: { status: React.ReactNode; streamingText: string | null | undefined } | null;
}

function rowContent(index: number, { items, pending, agentOf, onRetry, actions, highlightId, revertedChanges, lastTurnStatus }: RowContext): React.ReactNode {
  const item = items[index];
  if (item === undefined) return <PendingBubble pending={pending[index - items.length]!} onRetry={onRetry} />;
  if (item.kind === "event_group") {
    return <EventGroupView family={item.family} messages={item.messages} actions={actions} revertedChanges={revertedChanges} />;
  }
  if (item.kind === "turn") {
    const first = item.work[0] ?? item.parts[0]!;
    const live = index === items.length - 1 ? lastTurnStatus : null;
    return (
      <TurnView
        turn={item}
        identity={agentOf(first)}
        status={live?.status}
        streamingText={live?.streamingText}
        actions={actions}
        highlightId={highlightId}
        revertedChanges={revertedChanges}
      />
    );
  }
  const { message } = item;
  const previous = items[index - 1];
  const head = !(previous?.kind === "message" && previous.message.sender === message.sender);
  return (
    <MessageBubble
      message={message}
      identity={agentOf(message)}
      head={head}
      actions={actions}
      highlighted={message.id === highlightId}
      revertedChanges={revertedChanges}
    />
  );
}

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
  streamingText,
}: {
  messages: Message[];
  pending: PendingMessage[];
  agentOf: (message: Message) => AgentIdentity;
  hasMore: boolean;
  older: OlderState | undefined;
  onLoadOlder: () => void;
  onRetry: (clientId: string) => void;
  actions: MessageActions;
  focus?: { id: MessageId; n: number } | null;
  onFocusDone?: () => void;
  status?: React.ReactNode;
  statusAgent?: AgentIdentity;
  streamingText?: string | null;
}) {
  const items = useMemo(() => groupMessageRows(groupMessages(messages)), [messages]);
  const revertedChanges = useMemo(() => revertedChangeIds(messages), [messages]);
  const busy = status != null || Boolean(streamingText);
  const lastKey = `${messages.findLast((m) => !isHandoverTraffic(m) && !isSilentTriggerMessage(m) && !(isRewoundMessage(m) && attachmentsOf(m).length === 0))?.id ?? 0}:${pending.length}:${busy}`;

  const { ref, contentRef, away, scrollToBottom, loadOlder, onScroll } = useStickToBottom({
    lastKey,
    ownCount: pending.length,
    canLoadOlder: hasMore,
    onLoadOlder,
  });

  const listRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<HTMLDivElement>(null);
  const count = items.length + pending.length;
  const getItemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return `pending:${pending[index - items.length]!.clientId}`;
      return item.kind === "message" ? `message:${item.message.id}` : item.key;
    },
    [items, pending],
  );
  const { virtualizer, onFocus, onBlur } = useVirtualRows({ scrollRef: ref, listRef, count, getItemKey, headLayoutKey: `${hasMore}:${older}:${items.length === 0}` });
  const indexOf = useCallback(
    (id: MessageId) =>
      items.findLastIndex((item) =>
        item.kind === "turn"
          ? [...item.work, ...item.parts].some((m) => m.id === id)
          : item.kind === "event_group"
            ? item.messages.some((m) => m.id === id)
            : item.message.id === id,
      ),
    [items],
  );
  const highlightId = useFocusMessage({ scrollRef: ref, virtualizer, focus, onFocusDone, indexOf });

  useEffect(() => {
    if (messages.length === 0 && hasMore && older === undefined) {
      onLoadOlder();
    }
  }, [messages.length, hasMore, older, onLoadOlder]);

  const lastItem = items.at(-1);
  const rideOnTurn = busy && pending.length === 0 && lastItem?.kind === "turn";
  const typing = busy && !rideOnTurn && statusAgent !== undefined;
  const empty = items.length === 0 && pending.length === 0 && !busy && !hasMore;

  const enterItemAt = (index: number): EnterItem => {
    if (index >= items.length) {
      const p = pending[index - items.length]!;
      return { key: userMessageDedupeKey(p.conversationId, p.clientId), turn: false };
    }
    const item = items[index]!;
    if (item.kind === "turn") return { key: item.key, turn: true };
    if (item.kind === "event_group") return { key: item.key, turn: false };
    return { key: item.message.dedupeKey, turn: false };
  };
  const enterRows = () => ({
    row: (index: number) => listRef.current?.querySelector(`:scope > [data-index="${index}"]`)?.firstElementChild,
    typingRow: typingRef.current?.firstElementChild,
  });
  useMessageEnter(enterRows, count, enterItemAt, typing, empty);

  const rowContext: RowContext = { items, pending, agentOf, onRetry, actions, highlightId, revertedChanges, lastTurnStatus: rideOnTurn ? { status, streamingText } : null };
  const scrollMargin = virtualizer.options.scrollMargin;

  return (
    <div className="relative flex h-full flex-col">
      <div className="messages messages-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain" ref={ref} role="log" aria-label="Messages" onScroll={onScroll}>
        <div className="relative flex min-h-full flex-col pt-8 pb-12" ref={contentRef}>
          {hasMore && (
            <button
              type="button"
              className="touch-target mb-2 cursor-pointer self-center px-3 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default disabled:opacity-60"
              disabled={older === "loading"}
              onClick={loadOlder}
            >
              {older === "error" ? "Couldn't load. Click to retry" : older === "loading" ? "Loading…" : "Load earlier messages"}
            </button>
          )}
          {empty && <EmptyConversation identity={statusAgent} />}
          <div ref={listRef} className="relative w-full shrink-0" style={{ height: virtualizer.getTotalSize() }} onFocus={onFocus} onBlur={onBlur}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                data-list-head={row.index === 0 && !hasMore ? "" : undefined}
                className="absolute top-0 left-0 flex w-full flex-col [contain:layout_style]"
                style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
              >
                {rowContent(row.index, rowContext)}
              </div>
            ))}
          </div>
          {typing && statusAgent && (
            <div ref={typingRef} className="flex flex-col" data-list-head={count === 0 && !hasMore ? "" : undefined}>
              <TurnView turn={EMPTY_TURN} identity={statusAgent} status={status} streamingText={streamingText} actions={actions} />
            </div>
          )}
        </div>
      </div>
      {away && (
        <div className="messages pointer-events-none absolute inset-x-0 bottom-9 flex justify-center" data-back-to-bottom>
          <Button variant="secondary" size="icon-sm" className="pointer-events-auto" aria-label="Scroll to bottom" title="Scroll to bottom" onClick={scrollToBottom}>
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
});
