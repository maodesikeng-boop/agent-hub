// Invariant: renders inside a non-modal Radix Popover anchored below the top-bar input and never mounts a second .composer-frame.
import { memo, useRef, type RefObject } from "react";
import type { ConversationId, RouterCommandId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import { FleetDeviceScopes, FleetLooks, type DeviceScopeLookup, type FleetLookOf } from "../device-scope.tsx";
import type { ErrorLike } from "../format.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM } from "../limits.ts";
import { retryStateOf } from "../router-commands.ts";
import type { RouterTurnEntry } from "../router-stream.ts";
import { shouldDismissOnTopBarOutsidePress, tabbablesIn } from "../router-topbar-model.ts";
import { Button } from "../ui/button.tsx";
import { Maximize2, X } from "../ui/icons.ts";
import { PopoverContent } from "../ui/popover.tsx";
import { useStickToBottom } from "../useStickToBottom.ts";
import { CardNoteForm } from "./Deliverables.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { RouterTurnRow } from "./RouterTurnRow.tsx";

const CONTENT_STYLE = { maxHeight: `min(${TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM}rem, var(--radix-popover-content-available-height))` };
const noop = () => {};

export interface RouterTopBarPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  turns: readonly RouterTurnEntry[];
  multiDevice: boolean;
  working: boolean;
  replyDraft: string;
  replyInvalid: string | undefined;
  onReplyDraftChange: (value: string) => void;
  retryingMap: Readonly<Record<RouterCommandId, number>>;
  retryErrors: Readonly<Record<RouterCommandId, ErrorLike>>;
  deviceScopeLookup: DeviceScopeLookup;
  lookOf: FleetLookOf;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  onSendFollowUp: (text: string) => void;
  onRetryCommand: (commandId: RouterCommandId, updatedAt: number) => void;
  onRetryUnsent: (clientId: string) => void;
  onExpand: () => void;
  onClose: () => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}

type TimelineProps = Pick<
  RouterTopBarPopoverProps,
  | "turns"
  | "multiDevice"
  | "retryingMap"
  | "retryErrors"
  | "clientForDevice"
  | "storeForDevice"
  | "onRetryCommand"
  | "onRetryUnsent"
  | "onOpenConversation"
  | "onOpenWorker"
>;

const QuickTimeline = memo(function QuickTimeline({ turns, multiDevice, retryingMap, retryErrors, ...handlers }: TimelineProps) {
  const last = turns.at(-1);
  const lastKey = last === undefined ? "empty" : `${last.key}:${last.status}:${last.command?.updatedAt ?? 0}`;
  const { ref, contentRef, onScroll } = useStickToBottom({ lastKey, ownCount: turns.length, canLoadOlder: false, onLoadOlder: noop });
  return (
    <div
      ref={ref}
      role="log"
      aria-label="Router replies"
      onScroll={onScroll}
      className="messages router-timeline min-h-0 flex-1 overflow-y-auto [--fade-top:0.75rem]"
    >
      <div ref={contentRef} className="flex flex-col px-4 pt-2 pb-5">
        {turns.map((entry) => (
          <RouterTurnRow key={entry.key} entry={entry} multiDevice={multiDevice} {...retryStateOf(entry, retryingMap, retryErrors)} {...handlers} />
        ))}
      </div>
    </div>
  );
});

/**
 * Precondition: mounted inside a Radix Popover root whose PopoverAnchor wraps anchorRef.
 * Postcondition: renders the header (RouterAvatar, title, Expand, Close), a stick-to-bottom .router-timeline turn list, and a full-bleed bottom reply row that takes focus when the popover opens; Escape or Close returns focus to the anchor's input, and Shift+Tab from the first control goes back to the anchor.
 */
export function RouterTopBarPopover({
  anchorRef,
  contentRef,
  working,
  replyDraft,
  replyInvalid,
  onReplyDraftChange,
  deviceScopeLookup,
  lookOf,
  onSendFollowUp,
  onExpand,
  onClose,
  ...timeline
}: RouterTopBarPopoverProps) {
  const refocusAnchorRef = useRef(false);
  const closeToAnchor = () => {
    refocusAnchorRef.current = true;
    onClose();
  };
  return (
    <PopoverContent
      ref={contentRef}
      data-router-quick
      aria-label="Router"
      side="bottom"
      align="center"
      sideOffset={6}
      style={CONTENT_STYLE}
      className="flex w-[max(min(22rem,var(--radix-popover-content-available-width)),var(--radix-popover-trigger-width))] min-w-0 max-w-(--radix-popover-content-available-width) flex-col overflow-hidden p-0"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        contentRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={() => {
        refocusAnchorRef.current = true;
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (refocusAnchorRef.current) tabbablesIn(anchorRef.current)[0]?.focus({ preventScroll: true });
        refocusAnchorRef.current = false;
      }}
      onInteractOutside={(event) => {
        const target = event.detail.originalEvent.target;
        if (!shouldDismissOnTopBarOutsidePress(target instanceof Element ? target : null, anchorRef.current)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || !event.shiftKey || tabbablesIn(event.currentTarget)[0] !== event.target) return;
        const back = tabbablesIn(anchorRef.current).at(-1);
        if (back === undefined) return;
        event.preventDefault();
        back.focus();
      }}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <RouterAvatar size={18} working={working} />
        <h2 className="min-w-0 flex-1 truncate text-minor font-semibold text-foreground">Router</h2>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Expand" title="Open Router" onClick={onExpand}>
          <Maximize2 className="size-pixel-sm" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close" title="Close" onClick={closeToAnchor}>
          <X className="size-pixel-sm" aria-hidden="true" />
        </Button>
      </header>
      <FleetDeviceScopes lookup={deviceScopeLookup}>
        <FleetLooks lookOf={lookOf}>
          <QuickTimeline {...timeline} />
        </FleetLooks>
      </FleetDeviceScopes>
      <CardNoteForm
        variant="row"
        disabled={false}
        pending={false}
        label="Reply to Router"
        placeholder="Reply to Router…"
        value={replyDraft}
        onChange={onReplyDraftChange}
        invalid={replyInvalid}
        onSubmitNote={onSendFollowUp}
        className="mx-0 mb-0 shrink-0"
      />
    </PopoverContent>
  );
}
