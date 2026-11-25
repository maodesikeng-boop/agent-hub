// Invariant: renders inside a non-modal Radix Popover anchored below the top-bar input and never mounts a second .composer-frame.
import type { ReactElement, RefObject } from "react";
import type { ConversationId, RouterCommandId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import type { DeviceScopeLookup, FleetLookOf } from "../device-scope.tsx";
import type { ErrorLike } from "../format.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import type { RouterTurnEntry } from "../router-stream.ts";

export interface RouterTopBarPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  turns: readonly RouterTurnEntry[];
  multiDevice: boolean;
  working: boolean;
  replyDraft: string;
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

/**
 * Precondition: mounted inside a Radix Popover root whose PopoverAnchor wraps anchorRef.
 * Postcondition: renders the header (RouterAvatar, title, Expand, Close), a stick-to-bottom .chat-text .router-timeline turn list, and a full-bleed bottom reply row that auto-focuses on open.
 */
export function RouterTopBarPopover(_props: RouterTopBarPopoverProps): ReactElement | null {
  throw new Error("Not implemented");
}
