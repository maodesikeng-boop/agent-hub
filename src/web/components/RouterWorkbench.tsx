import { ChevronRight, X } from "../ui/icons.ts";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  defaultRouterSettings,
  type Attachment,
  type ConversationId,
  type PostRouterCommandTarget,
} from "../../shared/index.ts";
import { localClient, type HubClient } from "../client.ts";
import { DeviceScopeOf, FleetDeviceScopes, FleetLooks, type DeviceScopeLookup } from "../device-scope.tsx";
import type { ComposerSource, MenuItem } from "../composer-suggest.ts";
import { submitDecision } from "../decision-actions.ts";
import {
  clearDecisionDraft,
  getDecisionDraft,
  routerDecisionDraftKey,
  setDecisionDraft,
  useDecisionDraft,
} from "../decision-drafts.ts";
import { LOCAL_DEVICE, isReadOnly, type DeviceView } from "../devices.ts";
import { errorText, formatTime, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useRouterCommands } from "../router-commands.ts";
import { fleetRouterStream, type FleetRouterStream, type RouterStreamDeviceInput } from "../router-stream.ts";
import type {
  FleetDecisionEntry,
  FleetRouterView,
  RouterTargetCandidate,
} from "../selectors.ts";
import { useShellCarry } from "../shell-carry.tsx";
import { useMobileShell } from "../shell-layout.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { uploadFiles, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Avatar } from "./Avatar.tsx";
import { DraftComposer } from "./Composer.tsx";
import { UnsentDraftBanner } from "./Deliverables.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { SandboxApprovalCard } from "./SandboxApprovalCard.tsx";
import { RouterDecisionCard } from "./RouterDecisionCard.tsx";
import { RouterModelPicker } from "./RouterModelPicker.tsx";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { RouterStream } from "./RouterStream.tsx";

const ROUTER_TRAY_VISIBLE_ROWS = 3;

const CHIP_REMOVE_CLASS =
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus";

const NO_SANDBOX_CARDS: readonly ReactNode[] = [];
const DEFAULT_ROUTER_SETTINGS = defaultRouterSettings();

function useFleetSandboxCards(devices: readonly DeviceView[], multiDevice: boolean): readonly ReactNode[] {
  const inputs = devices.flatMap((device) => {
    const cards = device.state.pendingSandboxCards;
    return cards === undefined || cards.length === 0 ? [] : [{
      key: device.key,
      cards,
      disabled: isReadOnly(device.status),
      name: multiDevice || device.key !== LOCAL_DEVICE ? device.info.name : undefined,
    }];
  });
  const cache = useRef<{ inputs: typeof inputs; cards: readonly ReactNode[] } | null>(null);
  const prev = cache.current;
  if (prev !== null && inputs.length === prev.inputs.length && inputs.every((input, i) => {
    const old = prev.inputs[i];
    return old?.key === input.key && old.cards === input.cards && old.disabled === input.disabled && old.name === input.name;
  })) return prev.cards;

  const cards = inputs.length === 0 ? NO_SANDBOX_CARDS : inputs.flatMap(({ key, cards, disabled, name }) => cards.map((card) => (
    <DeviceScopeOf key={`${key}:${card.id}`} deviceKey={key}>
      <SandboxApprovalCard approvalId={card.id} text={card.text} disabled={disabled} deviceName={name} />
    </DeviceScopeOf>
  )));
  cache.current = { inputs, cards };
  return cards;
}

interface ClosedRouterDraft {
  decisionKey: string;
  draftKey: string;
  pmName: string;
  question: string;
  deviceKey: string;
  conversationId: ConversationId;
  look: Parameters<typeof Avatar>[0]["look"];
}

function closedDraftOf(entry: FleetDecisionEntry): ClosedRouterDraft {
  return {
    decisionKey: entry.decision.key,
    draftKey: routerDecisionDraftKey(entry.deviceId, entry.decision),
    pmName: entry.decision.pmName,
    question: entry.decision.question,
    deviceKey: entry.deviceKey,
    conversationId: entry.decision.conversationId,
    look: entry.look,
  };
}

const ClosedRouterDraftCard = memo(function ClosedRouterDraftCard({
  closed,
  onDismiss,
  onOpenConversation,
}: {
  closed: ClosedRouterDraft;
  onDismiss: () => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const draft = useDecisionDraft(closed.draftKey);
  if (draft.trim() === "") return null;
  return (
    <article aria-label={closed.question} data-closed-draft-card className="rounded-sm border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-2 text-minor">
        <button
          type="button"
          className="touch-target inline-flex cursor-pointer items-center gap-2 text-left font-semibold text-foreground outline-none hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
          onClick={() => onOpenConversation(closed.deviceKey, closed.conversationId)}
        >
          <Avatar look={closed.look} size={24} />
          <span className="truncate">{closed.pmName}</span>
        </button>
        <span className="rounded-xs bg-panel px-2 py-0.5 text-xs font-medium text-muted-foreground">Closed</span>
      </div>
      <h3 className="mt-2.5 text-body font-medium text-foreground">{closed.question}</h3>
      <UnsentDraftBanner draft={draft} onDismiss={onDismiss} />
    </article>
  );
});

const RouterNeedsYouTray = memo(function RouterNeedsYouTray({
  decisions,
  sandboxCards,
  closedDraft,
  mobile,
  multiDevice,
  decisionErrors,
  onNoteFocus,
  onNoteChange,
  onDismissClosedDraft,
  onSubmit,
  onOpenConversation,
  selectedKey,
  onSelectKey,
}: {
  decisions: readonly FleetDecisionEntry[];
  sandboxCards: readonly ReactNode[];
  closedDraft: ClosedRouterDraft | null;
  mobile: boolean;
  multiDevice: boolean;
  decisionErrors: Readonly<Record<string, ErrorLike>>;
  onNoteFocus: (decisionKey: string) => void;
  onNoteChange: (decisionKey: string, draftKey: string, value: string) => void;
  onDismissClosedDraft: () => void;
  onSubmit: (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [rowsExpanded, setRowsExpanded] = useState(false);

  const hasContent = decisions.length > 0 || sandboxCards.length > 0 || closedDraft !== null;
  useEffect(() => {
    if (!hasContent) {
      setCollapsed(false);
      setRowsExpanded(false);
    }
  }, [hasContent]);

  const expandedEntry =
    closedDraft !== null
      ? null
      : ((selectedKey !== null ? decisions.find((d) => d.decision.key === selectedKey) : undefined) ?? decisions[0] ?? null);
  const activeSlotKey = closedDraft !== null ? `closed:${closedDraft.draftKey}` : (expandedEntry?.decision.key ?? null);

  const trayRef = useRef<HTMLDivElement>(null);
  const prevSlotKeyRef = useRef<string | null>(activeSlotKey);
  useEffect(() => {
    if (prevSlotKeyRef.current === activeSlotKey) return;
    prevSlotKeyRef.current = activeSlotKey;
    const tray = trayRef.current;
    if (tray !== null) tray.scrollTop = 0;
  }, [activeSlotKey]);

  if (!hasContent) return null;

  const otherEntries =
    expandedEntry === null ? decisions : decisions.filter((d) => d.decision.key !== expandedEntry.decision.key);
  const hasMoreRows = otherEntries.length > ROUTER_TRAY_VISIBLE_ROWS;
  const shownRows =
    hasMoreRows && !rowsExpanded ? otherEntries.slice(0, ROUTER_TRAY_VISIBLE_ROWS) : otherEntries;

  return (
    <Collapsible asChild open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
      <section aria-label="Needs You" className="chat-column w-full shrink-0 pb-3">
        <div className="border-b border-border pt-2.5">
          <CollapsibleTrigger
            type="button"
            className="touch-target flex h-8 w-full cursor-pointer items-center gap-2 text-left text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <ChevronRight
                className={cn("size-pixel-sm shrink-0 transition-transform", !collapsed && "rotate-90")}
                aria-hidden="true"
              />
              <span className="truncate">Needs You</span>
            </span>
            <span className="shrink-0 font-normal text-muted-foreground tabular-nums">{decisions.length + sandboxCards.length}</span>
          </CollapsibleTrigger>

          <CollapsibleContent
            ref={trayRef}
            className={cn(
              "router-tray-scroll -mx-2.5 space-y-2 overflow-y-auto overscroll-y-contain px-2.5 pt-2 pb-5",
              mobile ? "max-h-[45dvh]" : "max-h-[50dvh]",
            )}
          >
            {sandboxCards}
            {closedDraft !== null ? (
              <ClosedRouterDraftCard
                closed={closedDraft}
                onDismiss={onDismissClosedDraft}
                onOpenConversation={onOpenConversation}
              />
            ) : expandedEntry !== null ? (
              <RouterDecisionCard
                key={expandedEntry.decision.key}
                entry={expandedEntry}
                multiDevice={multiDevice}
                busy={false}
                error={decisionErrors[expandedEntry.decision.key] ?? null}
                onNoteFocus={onNoteFocus}
                onNoteChange={onNoteChange}
                onSubmit={onSubmit}
                onOpenConversation={onOpenConversation}
              />
            ) : null}

            {shownRows.length > 0 && (
              <div className="-mx-2.5 flex flex-col gap-0.5 pt-0.5">
                {shownRows.map((entry) => {
                  const firstLine =
                    entry.decision.question.split(/\r?\n/, 1)[0]?.trim() || entry.decision.question;
                  const showDevice = multiDevice || !entry.self;
                  return (
                    <button
                      key={entry.decision.key}
                      type="button"
                      aria-expanded={false}
                      className={cn(
                        "flex w-full pointer-coarse:min-h-11 cursor-pointer items-center gap-2.5 border border-transparent px-2.5 py-2 text-left transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]",
                        !entry.online && "[&_[data-slot=avatar]]:opacity-50",
                      )}
                      onClick={() => onSelectKey(entry.decision.key)}
                    >
                      <Avatar look={entry.look} size={20} />
                      <span className="shrink-0 text-minor font-medium text-foreground">
                        {entry.decision.pmName}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-body text-foreground"
                        title={entry.decision.question}
                      >
                        {firstLine}
                      </span>
                      {showDevice && (
                        <span className="shrink-0 text-xs text-muted-foreground">{entry.deviceName}</span>
                      )}
                      {!entry.online && (
                        <span className="shrink-0 rounded-xs bg-panel px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          Offline
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatTime(entry.decision.createdAt)}
                      </span>
                      <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            )}

            {hasMoreRows && (
              <button
                type="button"
                aria-expanded={rowsExpanded}
                className="touch-target inline-flex cursor-pointer items-center gap-1 px-1 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus"
                onClick={() => setRowsExpanded((v) => !v)}
              >
                {rowsExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </CollapsibleContent>
        </div>
      </section>
    </Collapsible>
  );
});

function decisionInstanceToken(entry: FleetDecisionEntry): string {
  return `${entry.decision.askMessageId ?? ""}:${entry.decision.updatedAt}`;
}

function TargetChip({
  label,
  deviceName,
  look,
  onRemove,
}: {
  label: string;
  deviceName: string | null;
  look: Parameters<typeof Avatar>[0]["look"];
  onRemove: () => void;
}) {
  return (
    <li className="flex max-w-full items-center gap-1.5 rounded-xs bg-panel py-1 pr-1 pl-2.5 text-minor text-foreground">
      <Avatar look={look} size={16} />
      <span className="truncate font-medium">{label}</span>
      {deviceName !== null && <span className="shrink-0 text-xs text-muted-foreground">{deviceName}</span>}
      <button type="button" className={CHIP_REMOVE_CLASS} aria-label={`Remove target ${label}`} onClick={onRemove}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

function useRouterDecisions(
  decisions: readonly FleetDecisionEntry[],
  clientForDevice: (deviceKey: string) => HubClient,
) {
  const [hiddenDecisionTokens, setHiddenDecisionTokens] = useState<Readonly<Record<string, string>>>({});
  const [decisionErrors, setDecisionErrors] = useState<Readonly<Record<string, ErrorLike>>>({});
  const [selectedDecisionKey, setSelectedDecisionKey] = useShellCarry<string | null>("router:decision", null);
  const [closedDraft, setClosedDraft] = useShellCarry<ClosedRouterDraft | null>("router:closed-draft", null);
  const [trackedExpanded, setTrackedExpanded] = useState<FleetDecisionEntry | null>(null);
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;

  const visibleDecisions = useMemo(
    () => decisions.filter((d) => hiddenDecisionTokens[d.decision.key] !== decisionInstanceToken(d)),
    [decisions, hiddenDecisionTokens],
  );

  // Promote a remotely closed card with an unsent draft during render so the next card never mounts in its slot.
  let activeClosedDraft = closedDraft;
  if (activeClosedDraft !== null && getDecisionDraft(activeClosedDraft.draftKey).trim() === "") {
    activeClosedDraft = null;
    setClosedDraft(null);
  }
  if (trackedExpanded !== null) {
    const trackedKey = trackedExpanded.decision.key;
    const trackedDraftKey = routerDecisionDraftKey(trackedExpanded.deviceId, trackedExpanded.decision);
    const stillPresent = decisions.some(
      (d) => d.decision.key === trackedKey && routerDecisionDraftKey(d.deviceId, d.decision) === trackedDraftKey,
    );
    const locallyHidden = hiddenDecisionTokens[trackedKey] === decisionInstanceToken(trackedExpanded);
    if (!stillPresent && !locallyHidden && getDecisionDraft(trackedDraftKey).trim() !== "") {
      const nextClosed = closedDraftOf(trackedExpanded);
      activeClosedDraft = nextClosed;
      setClosedDraft(nextClosed);
      setTrackedExpanded(null);
    }
  }

  const currentExpanded =
    activeClosedDraft !== null
      ? null
      : ((selectedDecisionKey !== null ? visibleDecisions.find((d) => d.decision.key === selectedDecisionKey) : undefined) ??
        visibleDecisions[0] ??
        null);

  useEffect(() => {
    setTrackedExpanded((prev) => {
      if (prev === currentExpanded) return prev;
      if (
        prev !== null &&
        currentExpanded !== null &&
        prev.decision.key === currentExpanded.decision.key &&
        routerDecisionDraftKey(prev.deviceId, prev.decision) === routerDecisionDraftKey(currentExpanded.deviceId, currentExpanded.decision)
      ) {
        return prev;
      }
      return currentExpanded;
    });
  }, [currentExpanded]);

  useEffect(() => {
    const activeTokenByKey = new Map(decisions.map((d) => [d.decision.key, decisionInstanceToken(d)]));
    setHiddenDecisionTokens((prev) => {
      const entries = Object.entries(prev);
      if (entries.length === 0) return prev;
      const kept = entries.filter(([k, tok]) => activeTokenByKey.get(k) === tok);
      return kept.length === entries.length ? prev : Object.fromEntries(kept);
    });
    setDecisionErrors((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0 || keys.every((k) => activeTokenByKey.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => activeTokenByKey.has(k)));
    });
  }, [decisions]);

  const handleNoteFocus = useCallback(
    (decisionKey: string) => {
      setSelectedDecisionKey(decisionKey);
    },
    [setSelectedDecisionKey],
  );

  const handleNoteChange = useCallback(
    (decisionKey: string, draftKey: string, value: string) => {
      setSelectedDecisionKey(decisionKey);
      setDecisionDraft(draftKey, value);
      setDecisionErrors((prev) => {
        if (prev[decisionKey] === undefined) return prev;
        const { [decisionKey]: _removed, ...rest } = prev;
        return rest;
      });
    },
    [setSelectedDecisionKey],
  );

  const handleSelectKey = useCallback(
    (key: string) => {
      setClosedDraft(null);
      setSelectedDecisionKey(key);
    },
    [setClosedDraft, setSelectedDecisionKey],
  );

  const handleDismissClosedDraft = useCallback(() => {
    setClosedDraft((prev) => {
      if (prev !== null) clearDecisionDraft(prev.draftKey);
      return null;
    });
    setSelectedDecisionKey(null);
  }, [setClosedDraft, setSelectedDecisionKey]);

  const inflightDecisions = useRef(new Set<string>());
  const handleDecisionSubmit = useCallback(
    async (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => {
      const key = entry.decision.key;
      const draftKey = routerDecisionDraftKey(entry.deviceId, entry.decision);
      const token = decisionInstanceToken(entry);
      if (inflightDecisions.current.has(key)) return;
      inflightDecisions.current.add(key);
      setHiddenDecisionTokens((prev) => ({ ...prev, [key]: token }));
      setDecisionErrors((prev) => {
        if (prev[key] === undefined) return prev;
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      try {
        const client = clientForDevice(entry.deviceKey);
        await submitDecision(client, entry.decision, { optionIndex, note });
        clearDecisionDraft(draftKey);
      } catch (err) {
        setHiddenDecisionTokens((prev) => {
          if (prev[key] !== token) return prev;
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
        if (!decisionsRef.current.some((d) => d.decision.key === key) && getDecisionDraft(draftKey).trim() !== "") {
          setClosedDraft(closedDraftOf(entry));
        } else {
          setSelectedDecisionKey(key);
          setDecisionErrors((prev) => ({ ...prev, [key]: errorText(err) }));
        }
      } finally {
        inflightDecisions.current.delete(key);
      }
    },
    [clientForDevice, setClosedDraft, setSelectedDecisionKey],
  );

  return {
    visibleDecisions,
    closedDraft: activeClosedDraft,
    decisionErrors,
    selectedDecisionKey,
    handleNoteFocus,
    handleNoteChange,
    handleSelectKey,
    handleDismissClosedDraft,
    handleDecisionSubmit,
  };
}

export const RouterWorkbench = memo(function RouterWorkbench({
  leading,
  toolbar,
  notices,
  view,
  devices,
  selfId,
  draft,
  staging,
  clientForDevice,
  storeForDevice,
  onOpenConversation,
  onOpenWorker,
  onManageProviders,
}: {
  leading?: ReactNode;
  toolbar?: ReactNode;
  notices?: ReactNode;
  view: FleetRouterView;
  devices: readonly DeviceView[];
  selfId: string | null;
  draft: DraftSlot;
  staging: StagedFiles;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
  onManageProviders?: () => void;
}) {
  const mobile = useMobileShell();
  const resolvedSelfId = selfId ?? undefined;
  const localSettings = useMemo(() => {
    const localDevice = devices.find((d) => d.key === LOCAL_DEVICE) ?? devices[0];
    return localDevice?.state.router.settings ?? DEFAULT_ROUTER_SETTINGS;
  }, [devices]);

  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const deviceScopeLookup = useCallback<DeviceScopeLookup>(
    (deviceKey) => {
      const device = devicesRef.current.find((d) => d.key === deviceKey);
      return device === undefined ? null : { client: clientForDevice(deviceKey), server: device.state.server };
    },
    [clientForDevice],
  );

  const {
    visibleDecisions,
    closedDraft,
    decisionErrors,
    selectedDecisionKey,
    handleNoteFocus,
    handleNoteChange,
    handleSelectKey,
    handleDismissClosedDraft,
    handleDecisionSubmit,
  } = useRouterDecisions(view.decisions, clientForDevice);

  const sandboxCards = useFleetSandboxCards(devices, view.multiDevice);

  const selectedTargetKey = useStore(draft.target);

  const stream = useMemo<FleetRouterStream>(() => {
    const inputs: RouterStreamDeviceInput[] = devices.map((d) => ({
      key: d.key,
      name: d.info.name,
      self: d.key === LOCAL_DEVICE,
      online: d.key === LOCAL_DEVICE || !isReadOnly(d.status),
      state: d.state,
    }));
    return fleetRouterStream(inputs, resolvedSelfId);
  }, [devices, resolvedSelfId]);

  const commands = useRouterCommands(stream.turns, resolvedSelfId);
  const { send: sendCommand } = commands;

  const selectedTarget = useMemo<RouterTargetCandidate | null>(
    () => (selectedTargetKey === null ? null : (view.targets.find((t) => t.key === selectedTargetKey) ?? null)),
    [selectedTargetKey, view.targets],
  );

  const composerSource = useMemo<ComposerSource>(
    () => ({
      commands: async () => [],
      files: async () => ({ entries: [], truncated: false }),
      targets: (rawQuery: string): MenuItem[] => {
        const q = rawQuery.trim().toLowerCase();
        return view.targets
          .filter(
            (t) =>
              q === "" ||
              t.label.toLowerCase().includes(q) ||
              t.pmName.toLowerCase().includes(q) ||
              (t.projectName?.toLowerCase().includes(q) ?? false) ||
              t.deviceName.toLowerCase().includes(q),
          )
          .map((t) => {
            const detailParts: string[] = [];
            if (t.projectName !== null && t.projectName !== t.pmName) detailParts.push(t.pmName);
            if (view.multiDevice || !t.self) detailParts.push(t.deviceName);
            if (!t.online) detailParts.push("Offline");
            return {
              id: `target:${t.key}`,
              label: t.label,
              detail: detailParts.join(" "),
              insert: `@${t.label}`,
              disabled: !t.online,
              look: t.look,
              targetKey: t.key,
            };
          });
      },
    }),
    [view.targets, view.multiDevice],
  );

  const handleSelectTarget = useCallback((targetKey: string) => draft.setTarget(targetKey), [draft]);

  const handleComposerSend = useCallback(
    (text: string, files: File[]): void | Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === "" && files.length === 0) return;

      const targetKey = selectedTargetKey;
      const targetSnap = selectedTarget;
      let targetPayload: PostRouterCommandTarget | undefined;
      if (targetSnap !== null) {
        targetPayload = {
          ...(targetSnap.self ? {} : { deviceId: targetSnap.deviceId }),
          pmId: targetSnap.pmId,
          ...(targetSnap.projectId !== null ? { projectId: targetSnap.projectId } : {}),
        };
      }

      const dispatchCommand = (uploaded: Attachment[]) => {
        sendCommand({ text: trimmed, attachments: uploaded, ...(targetPayload !== undefined ? { target: targetPayload } : {}) });
      };

      if (files.length === 0) {
        draft.set("");
        draft.clearTargetIfMatch(targetKey);
        dispatchCommand([]);
        return;
      }

      return uploadFiles(files, localClient).then((uploaded) => {
        draft.clearIfMatch(trimmed);
        draft.clearTargetIfMatch(targetKey);
        staging.removeSent(files);
        dispatchCommand(uploaded);
      });
    },
    [selectedTargetKey, selectedTarget, draft, staging, sendCommand],
  );

  const targetChip = useMemo(
    () =>
      selectedTarget ? (
        <TargetChip
          label={selectedTarget.label}
          deviceName={view.multiDevice || !selectedTarget.self ? selectedTarget.deviceName : null}
          look={selectedTarget.look}
          onRemove={() => draft.setTarget(null)}
        />
      ) : null,
    [selectedTarget, view.multiDevice, draft],
  );

  return (
    <FleetDeviceScopes lookup={deviceScopeLookup}>
      <FleetLooks lookOf={view.lookOf}>
      <FileDropZone className="chat-text flex min-h-0 flex-1 flex-col" onFiles={staging.add}>
        <header
          data-window-drag
          className="flex h-11 min-w-0 shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-border pr-3 pl-4"
        >
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            {leading}
            <RouterAvatar size={24} working={stream.turns.some((entry) => entry.status === "planning")} />
            <h1 className="truncate text-title font-semibold text-foreground">Router</h1>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {toolbar}
            <RouterModelPicker settings={localSettings} mobile={mobile} onManageProviders={onManageProviders} />
          </div>
        </header>

        {notices}

        <RouterNeedsYouTray
          decisions={visibleDecisions}
          sandboxCards={sandboxCards}
          closedDraft={closedDraft}
          mobile={mobile}
          multiDevice={view.multiDevice}
          decisionErrors={decisionErrors}
          onNoteFocus={handleNoteFocus}
          onNoteChange={handleNoteChange}
          onDismissClosedDraft={handleDismissClosedDraft}
          onSubmit={handleDecisionSubmit}
          onOpenConversation={onOpenConversation}
          selectedKey={selectedDecisionKey}
          onSelectKey={handleSelectKey}
        />

        <RouterStream
          stream={stream}
          selfId={resolvedSelfId}
          pendingTurns={commands.pendingTurns}
          hasDecisions={visibleDecisions.length > 0 || sandboxCards.length > 0 || closedDraft !== null}
          clientForDevice={clientForDevice}
          storeForDevice={storeForDevice}
          retryingMap={commands.retryingMap}
          retryErrors={commands.retryErrors}
          onRetryCommand={commands.retryCommand}
          onRetryUnsent={commands.retryUnsent}
          onOpenConversation={onOpenConversation}
          onOpenWorker={onOpenWorker}
        />

        <div className="chat-column pointer-events-none relative z-10 -mt-6.5 w-full shrink-0 composer-dock *:pointer-events-auto">
          <DraftComposer
            draft={draft}
            staging={staging}
            source={composerSource}
            placeholder={mobile ? "Tell Router…" : "Tell Router, or type @ to pick a project…"}
            autoFocus={!mobile}
            leadingChip={targetChip}
            onSelectTarget={handleSelectTarget}
            onSend={handleComposerSend}
          />
        </div>
      </FileDropZone>
      </FleetLooks>
    </FleetDeviceScopes>
  );
});
