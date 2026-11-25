// Invariant: preserves the 40px .shell-topbar[data-window-drag] strip across all desktop routes while marking the interactive input wrapper [data-no-drag].
import { memo, useCallback, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ROUTER_COMMAND_MAX_CHARS, type ConversationId } from "../../shared/index.ts";
import type { HubClient } from "../client.ts";
import type { DeviceScopeLookup, FleetLookOf } from "../device-scope.tsx";
import { LOCAL_DEVICE, type DeviceView } from "../devices.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { TOPBAR_ROUTER_INPUT_MAX_REM } from "../limits.ts";
import { useRouterCommands } from "../router-commands.ts";
import { routerTurnsOf, type RouterTurnEntry } from "../router-stream.ts";
import {
  CLOSED_TOPBAR_SESSION,
  canSubmitQuickMessage,
  handoffQuickDraft,
  recordQuickTurn,
  selectQuickRouterTurns,
  type TopBarRouterSession,
} from "../router-topbar-model.ts";
import { Button } from "../ui/button.tsx";
import { ArrowUp } from "../ui/icons.ts";
import { Popover, PopoverAnchor } from "../ui/popover.tsx";
import type { DraftSlot } from "../upload.ts";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { RouterTopBarPopover } from "./RouterTopBarPopover.tsx";

const BAR_STYLE = { "--topbar-input-max": `${TOPBAR_ROUTER_INPUT_MAX_REM}rem` } as CSSProperties;
const TOO_LONG = `Router takes up to ${ROUTER_COMMAND_MAX_CHARS.toLocaleString("en-US")} characters`;
const NO_TURNS: readonly RouterTurnEntry[] = [];

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

type QuickRouterProps = Omit<RouterTopBarProps, "hidden">;
type Field = "top" | "reply";

/**
 * Precondition: rendered as the first child of DesktopWorkbench inside QueryClientProvider.
 * Postcondition: renders the 40px wood .shell-topbar[data-window-drag]; when hidden is false, centers the translucent-to-solid Message Router input and manages its non-modal reply popover without triggering sibling pane re-renders.
 */
export const RouterTopBar = memo(function RouterTopBar({ hidden, ...quick }: RouterTopBarProps) {
  return (
    <div data-window-drag aria-hidden={hidden || undefined} className="shell-topbar shrink-0" style={BAR_STYLE}>
      {!hidden && <QuickRouter {...quick} />}
    </div>
  );
});

function useDeviceScopeLookup(devices: readonly DeviceView[], clientForDevice: (deviceKey: string) => HubClient): DeviceScopeLookup {
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  return useCallback<DeviceScopeLookup>(
    (deviceKey) => {
      const device = devicesRef.current.find((d) => d.key === deviceKey);
      return device === undefined ? null : { client: clientForDevice(deviceKey), server: device.state.server };
    },
    [clientForDevice],
  );
}

function QuickRouter({
  devices,
  selfId,
  lookOf,
  working,
  routerDraft,
  clientForDevice,
  storeForDevice,
  onExpand,
  onOpenConversation,
  onOpenWorker,
}: QuickRouterProps) {
  const anchorRef = useRef<HTMLLabelElement>(null);
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [invalid, setInvalid] = useState<Field | null>(null);
  const [session, setSession] = useState<TopBarRouterSession>(CLOSED_TOPBAR_SESSION);

  const resolvedSelfId = selfId ?? undefined;
  const local = devices.find((d) => d.key === LOCAL_DEVICE);
  const liveTurns = local === undefined ? NO_TURNS : routerTurnsOf(local.state, resolvedSelfId);
  const commands = useRouterCommands(liveTurns, resolvedSelfId);
  const turns = selectQuickRouterTurns(session.clientIds, liveTurns, commands.pendingTurns);
  const deviceScopeLookup = useDeviceScopeLookup(devices, clientForDevice);

  const submit = (text: string, field: Field): boolean => {
    const check = canSubmitQuickMessage(text);
    if (!check.ok) {
      if (check.reason === "too_long") setInvalid(field);
      return false;
    }
    const clientId = commands.send({ text: check.trimmed });
    setSession((current) => recordQuickTurn(current, clientId));
    return true;
  };
  const submitTop = () => {
    if (submit(draft, "top")) setDraft("");
  };
  const close = useCallback(() => setSession(CLOSED_TOPBAR_SESSION), []);
  const expand = () => {
    const handoff = handoffQuickDraft(draft, replyDraft, routerDraft.get());
    if (handoff !== null) routerDraft.set(handoff);
    setDraft("");
    setReplyDraft("");
    setInvalid(null);
    close();
    onExpand();
  };
  const openConversation = useCallback(
    (deviceKey: string, conversationId: ConversationId) => {
      close();
      onOpenConversation(deviceKey, conversationId);
    },
    [close, onOpenConversation],
  );
  const openWorker = useCallback(
    (deviceKey: string, conversationId: ConversationId) => {
      close();
      onOpenWorker(deviceKey, conversationId);
    },
    [close, onOpenWorker],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      submitTop();
    } else if (event.key === "Escape" && !session.open) {
      event.currentTarget.blur();
    }
  };

  return (
    <Popover open={session.open} onOpenChange={(open) => !open && close()} modal={false}>
      <PopoverAnchor asChild>
        <label ref={anchorRef} data-no-drag className="topbar-router">
          <RouterAvatar size={18} working={working} />
          <input
            type="text"
            aria-label="Message Router"
            placeholder="Message Router…"
            autoComplete="off"
            enterKeyHint="send"
            value={draft}
            aria-invalid={invalid === "top" || undefined}
            title={invalid === "top" ? TOO_LONG : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              if (invalid === "top") setInvalid(null);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-minor outline-none"
          />
          {draft.trim() !== "" && (
            <Button
              data-topbar-send
              type="button"
              variant="send"
              size="icon-sm"
              aria-label="Send to Router"
              className="size-5.5 rounded-xs"
              onClick={submitTop}
            >
              <ArrowUp className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          )}
        </label>
      </PopoverAnchor>
      <RouterTopBarPopover
        anchorRef={anchorRef}
        turns={turns}
        multiDevice={devices.length > 1}
        working={working}
        replyDraft={replyDraft}
        replyInvalid={invalid === "reply" ? TOO_LONG : undefined}
        onReplyDraftChange={(value) => {
          setReplyDraft(value);
          if (invalid === "reply") setInvalid(null);
        }}
        retryingMap={commands.retryingMap}
        retryErrors={commands.retryErrors}
        deviceScopeLookup={deviceScopeLookup}
        lookOf={lookOf}
        clientForDevice={clientForDevice}
        storeForDevice={storeForDevice}
        onSendFollowUp={(text) => {
          if (submit(text, "reply")) setReplyDraft("");
        }}
        onRetryCommand={commands.retryCommand}
        onRetryUnsent={commands.retryUnsent}
        onExpand={expand}
        onClose={close}
        onOpenConversation={openConversation}
        onOpenWorker={openWorker}
      />
    </Popover>
  );
}
