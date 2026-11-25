// Invariant: preserves the 40px .shell-topbar[data-window-drag] strip across all desktop routes while marking the interactive input wrapper [data-no-drag].
import type { ReactElement } from "react";
import type { ConversationId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import type { FleetLookOf } from "../device-scope.tsx";
import type { DeviceView } from "../devices.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import type { DraftSlot } from "../upload.ts";

export interface RouterTopBarProps {
  devices: readonly DeviceView[];
  selfId: string | null;
  lookOf: FleetLookOf;
  working: boolean;
  /** True on #/router where the full Router composer is already active; keeps the 40px wood drag bar empty. */
  hidden: boolean;
  routerDraft: DraftSlot;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  onExpand: () => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}

/**
 * Precondition: rendered as the first child of DesktopWorkbench inside QueryClientProvider.
 * Postcondition: renders the 40px wood .shell-topbar[data-window-drag]; when hidden is false, centers the translucent-to-solid Message Router input and manages its non-modal reply popover without triggering sibling pane re-renders.
 */
export function RouterTopBar(_props: RouterTopBarProps): ReactElement {
  throw new Error("Not implemented");
}
