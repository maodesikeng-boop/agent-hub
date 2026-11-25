// Invariant: renders one Router command turn identically in the full Router timeline and the top-bar reply popover.
import type { ReactElement } from "react";
import type { ConversationId, RouterCommandId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import type { ErrorLike } from "../format.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import type { RouterTurnEntry } from "../router-stream.ts";

export interface RouterTurnRowProps {
  entry: RouterTurnEntry;
  multiDevice: boolean;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  retryPending: boolean;
  retryError: ErrorLike | undefined;
  onRetryCommand: (commandId: RouterCommandId, updatedAt: number) => void;
  onRetryUnsent: (clientId: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}

/**
 * Precondition: rendered inside FleetDeviceScopes and FleetLooks providers.
 * Postcondition: renders the user bubble, Router status or Markdown reply, clickable PM/Worker destinations, retry controls, and inline ForwardReply blocks for one Router turn.
 */
export function RouterTurnRow(_props: RouterTurnRowProps): ReactElement {
  throw new Error("Not implemented");
}
