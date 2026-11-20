import { ChevronDown } from "../ui/icons.ts";
import { memo, useEffect, useMemo, useState } from "react";
import { attachmentsOf, isHandoverTraffic, isRewoundMessage, isSilentTriggerMessage, userMessageDedupeKey, type Message, type MessageId } from "../../shared/index.ts";
import { groupMessages } from "../selectors.ts";
import type { OlderState, PendingMessage } from "../state.ts";
import { Button } from "../ui/button.tsx";
import { useMessageEnter, type EnterItem } from "../useMessageEnter.ts";
import { useStickToBottom } from "../useStickToBottom.ts";
import { EmptyConversation, MessageBubble, PendingBubble, TurnView, revertedChangeIds, type AgentIdentity, type MessageActions } from "./Messages.tsx";

const HIGHLIGHT_MS = 2_000;

const EMPTY_TURN = { work: [], parts: [], startedAt: 0, endedAt: 0 };

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
  const [highlightId, setHighlightId] = useState<MessageId | null>(null);

  const items = useMemo(() => groupMessages(messages), [messages]);
  const revertedChanges = useMemo(() => revertedChangeIds(messages), [messages]);
  const busy = status != null || Boolean(streamingText);
  const lastKey = `${messages.findLast((m) => !isHandoverTraffic(m) && !isSilentTriggerMessage(m) && !(isRewoundMessage(m) && attachmentsOf(m).length === 0))?.id ?? 0}:${pending.length}:${busy}`;
  const firstId = messages[0]?.id ?? 0;

  const { ref, contentRef, away, scrollToBottom, loadOlder, onScroll } = useStickToBottom({
    lastKey,
    ownCount: pending.length,
    headKey: firstId,
    canLoadOlder: hasMore,
    onLoadOlder,
  });

  useEffect(() => {
    if (!focus) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.querySelector(`[data-message-id="${focus.id}"]`)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    setHighlightId(focus.id);
    onFocusDone?.();
  }, [focus, onFocusDone, ref]);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

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
    return item.kind === "turn" ? { key: item.key, turn: true } : { key: item.message.dedupeKey, turn: false };
  };
  useMessageEnter(contentRef, Number(hasMore) + Number(empty), items.length + pending.length, enterItemAt, typing, empty);

  return (
    <div className="relative flex h-full flex-col">
      <div className="messages messages-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain" ref={ref} role="log" aria-label="Messages" onScroll={onScroll}>
        <div className="flex min-h-full flex-col pt-8 pb-12" ref={contentRef}>
          {hasMore && (
            <button
              type="button"
              className="touch-target mb-2 cursor-pointer self-center rounded-full px-3 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
              disabled={older === "loading"}
              onClick={loadOlder}
            >
              {older === "error" ? "Couldn't load. Click to retry" : older === "loading" ? "Loading…" : "Load earlier messages"}
            </button>
          )}
          {empty && <EmptyConversation identity={statusAgent} />}
          {items.map((item, index) => {
            if (item.kind === "turn") {
              const first = item.work[0] ?? item.parts[0]!;
              const isLastTurn = rideOnTurn && index === items.length - 1;
              const turnStatus = isLastTurn ? status : undefined;
              const turnStreaming = isLastTurn ? streamingText : undefined;
              return (
                <TurnView
                  key={item.key}
                  turn={item}
                  identity={agentOf(first)}
                  status={turnStatus}
                  streamingText={turnStreaming}
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
          {typing && statusAgent && <TurnView turn={EMPTY_TURN} identity={statusAgent} status={status} streamingText={streamingText} actions={actions} />}
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
