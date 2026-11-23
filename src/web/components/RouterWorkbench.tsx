import { useMutation, useMutationState, type Mutation, type QueryClient } from "@tanstack/react-query";
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
import {
  ROUTER_STREAM_LIVE_MAX,
  defaultRouterSettings,
  type Attachment,
  type ConversationId,
  type PostRouterCommandResponse,
  type PostRouterCommandTarget,
} from "../../shared/index.ts";
import { localClient, type HubClient } from "../client.ts";
import { FleetDeviceScopes, FleetLooks, type DeviceScopeLookup } from "../device-scope.tsx";
import type { ComposerSource, MenuItem } from "../composer-suggest.ts";
import { submitDecision } from "../decision-actions.ts";
import { LOCAL_DEVICE, isReadOnly, type DeviceView } from "../devices.ts";
import { errorText, formatTime, newClientId, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import {
  fleetRouterStream,
  turnEntryOfCommand,
  type FleetRouterStream,
  type RouterStreamDeviceInput,
  type RouterTurnEntry,
} from "../router-stream.ts";
import type {
  FleetDecisionEntry,
  FleetRouterView,
  RouterTargetCandidate,
} from "../selectors.ts";
import { MOBILE_SHELL_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { uploadFiles, type DraftSlot, type StagedFiles } from "../upload.ts";
import { Avatar } from "./Avatar.tsx";
import { DraftComposer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { RIGHT_RAIL_VISIBLE_ROWS } from "./RightRail.tsx";
import { RouterDecisionCard } from "./RouterDecisionCard.tsx";
import { RouterModelPicker } from "./RouterModelPicker.tsx";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { RouterStream } from "./RouterStream.tsx";

const ROUTER_COMMAND_MUTATION_KEY = ["router-command"] as const;

const CHIP_REMOVE_CLASS =
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus";

const NO_PENDING_TURNS: readonly RouterTurnEntry[] = [];
const DEFAULT_ROUTER_SETTINGS = defaultRouterSettings();

interface RouterCommandVariables {
  clientId: string;
  text: string;
  attachments: Attachment[];
  attachmentIds: string[];
  target?: PostRouterCommandTarget;
  createdAt: number;
}

interface RawRouterMutation {
  clientId: string;
  variables: RouterCommandVariables;
  status: "idle" | "pending" | "success" | "error";
  data: PostRouterCommandResponse | undefined;
  error: unknown;
}

function pruneRouterCommandMutations(qc: QueryClient, confirmedClientIds: ReadonlySet<string>) {
  const cache = qc.getMutationCache();
  const all = cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY });
  for (const m of all) {
    const vars = m.state.variables as RouterCommandVariables | undefined;
    if (m.state.status === "success" && vars && confirmedClientIds.has(vars.clientId)) {
      cache.remove(m);
    }
  }
  const remaining = cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY });
  if (remaining.length <= ROUTER_STREAM_LIVE_MAX) return;
  let excess = remaining.length - ROUTER_STREAM_LIVE_MAX;
  for (const m of remaining) {
    if (excess <= 0) break;
    if (m.state.status !== "pending") {
      cache.remove(m);
      excess--;
    }
  }
}

const RouterNeedsYouTray = memo(function RouterNeedsYouTray({
  decisions,
  mobile,
  multiDevice,
  decisionNotes,
  decisionErrors,
  onNoteChange,
  onSubmit,
  onOpenConversation,
  selectedKey,
  onSelectKey,
}: {
  decisions: readonly FleetDecisionEntry[];
  mobile: boolean;
  multiDevice: boolean;
  decisionNotes: Readonly<Record<string, string>>;
  decisionErrors: Readonly<Record<string, ErrorLike>>;
  onNoteChange: (key: string, value: string) => void;
  onSubmit: (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  selectedKey: string | null;
  onSelectKey: (key: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [rowsExpanded, setRowsExpanded] = useState(false);

  useEffect(() => {
    if (decisions.length === 0) {
      setCollapsed(false);
      setRowsExpanded(false);
    }
  }, [decisions.length]);

  const trayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tray = trayRef.current;
    if (tray !== null) tray.scrollTop = 0;
  }, [selectedKey]);

  if (decisions.length === 0) return null;

  const expandedEntry =
    (selectedKey !== null ? decisions.find((d) => d.decision.key === selectedKey) : undefined) ??
    decisions[0]!;
  const otherEntries = decisions.filter((d) => d.decision.key !== expandedEntry.decision.key);
  const hasMoreRows = otherEntries.length > RIGHT_RAIL_VISIBLE_ROWS;
  const shownRows =
    hasMoreRows && !rowsExpanded ? otherEntries.slice(0, RIGHT_RAIL_VISIBLE_ROWS) : otherEntries;

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
            <span className="shrink-0 font-normal text-muted-foreground tabular-nums">{decisions.length}</span>
          </CollapsibleTrigger>

          <CollapsibleContent
            ref={trayRef}
            className={cn(
              "router-tray-scroll -mx-2.5 space-y-2 overflow-y-auto overscroll-y-contain px-2.5 pt-2 pb-5",
              mobile ? "max-h-[45dvh]" : "max-h-[50dvh]",
            )}
          >
            <RouterDecisionCard
              entry={expandedEntry}
              multiDevice={multiDevice}
              busy={false}
              note={decisionNotes[expandedEntry.decision.key] ?? ""}
              error={decisionErrors[expandedEntry.decision.key] ?? null}
              onNoteChange={onNoteChange}
              onSubmit={onSubmit}
              onOpenConversation={onOpenConversation}
            />

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
                        "flex w-full pointer-coarse:min-h-11 cursor-pointer items-center gap-2.5 border-2 border-transparent px-2.5 py-2 text-left transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]",
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
                        <span className="shrink-0 border border-border bg-panel px-2 py-0.5 text-xs font-medium text-muted-foreground">
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
    <li className="flex max-w-full items-center gap-1.5 border border-border-strong bg-panel py-1 pr-1 pl-2.5 text-minor text-foreground">
      <Avatar look={look} size={16} />
      <span className="truncate font-medium">{label}</span>
      {deviceName !== null && <span className="shrink-0 text-xs text-muted-foreground">{deviceName}</span>}
      <button type="button" className={CHIP_REMOVE_CLASS} aria-label={`Remove target ${label}`} onClick={onRemove}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

export function RouterWorkbench({
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
  const qc = useHubQueryClient();
  const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
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

  const [hiddenDecisionTokens, setHiddenDecisionTokens] = useState<Readonly<Record<string, string>>>({});
  const [decisionNotes, setDecisionNotes] = useState<Readonly<Record<string, string>>>({});
  const [decisionErrors, setDecisionErrors] = useState<Readonly<Record<string, ErrorLike>>>({});
  const [selectedDecisionKey, setSelectedDecisionKey] = useState<string | null>(null);

  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);

  useEffect(() => {
    const activeTokenByKey = new Map(view.decisions.map((d) => [d.decision.key, decisionInstanceToken(d)]));
    setHiddenDecisionTokens((prev) => {
      const entries = Object.entries(prev);
      if (entries.length === 0) return prev;
      const kept = entries.filter(([k, tok]) => activeTokenByKey.get(k) === tok);
      return kept.length === entries.length ? prev : Object.fromEntries(kept);
    });
    setDecisionNotes((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0 || keys.every((k) => activeTokenByKey.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => activeTokenByKey.has(k)));
    });
    setDecisionErrors((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0 || keys.every((k) => activeTokenByKey.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => activeTokenByKey.has(k)));
    });
  }, [view.decisions]);

  const visibleDecisions = useMemo(
    () => view.decisions.filter((d) => hiddenDecisionTokens[d.decision.key] !== decisionInstanceToken(d)),
    [view.decisions, hiddenDecisionTokens],
  );

  const handleNoteChange = useCallback((key: string, value: string) => {
    setDecisionNotes((prev) => ({ ...prev, [key]: value }));
    setDecisionErrors((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const inflightDecisions = useRef(new Set<string>());
  const handleDecisionSubmit = useCallback(
    async (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => {
      const key = entry.decision.key;
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
        setDecisionNotes((prev) => {
          if (prev[key] === undefined) return prev;
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
      } catch (err) {
        setHiddenDecisionTokens((prev) => {
          if (prev[key] !== token) return prev;
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
        setSelectedDecisionKey(key);
        setDecisionErrors((prev) => ({ ...prev, [key]: errorText(err) }));
      } finally {
        inflightDecisions.current.delete(key);
      }
    },
    [clientForDevice],
  );

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

  // Destructure only the stable mutate so RouterStream's memo holds.
  const { mutate: mutateSend } = useMutation<PostRouterCommandResponse, unknown, RouterCommandVariables>(
    {
      mutationKey: ROUTER_COMMAND_MUTATION_KEY,
      gcTime: Infinity,
      mutationFn: (vars) =>
        localClient.postRouterCommand({
          clientId: vars.clientId,
          text: vars.text,
          ...(vars.attachmentIds.length > 0 ? { attachmentIds: vars.attachmentIds } : {}),
          ...(vars.target !== undefined ? { target: vars.target } : {}),
        }),
    },
    qc,
  );

  const selectMutation = useCallback(
    (m: Mutation<unknown, unknown, unknown, unknown>): RawRouterMutation | null => {
      const vars = m.state.variables as RouterCommandVariables | undefined;
      if (!vars || typeof vars.clientId !== "string") return null;
      return {
        clientId: vars.clientId,
        variables: vars,
        status: m.state.status,
        data: m.state.data as PostRouterCommandResponse | undefined,
        error: m.state.error,
      };
    },
    [],
  );
  const rawMutations = useMutationState(
    { filters: { mutationKey: ROUTER_COMMAND_MUTATION_KEY }, select: selectMutation },
    qc,
  );

  const latestVarsByClientIdRef = useRef(new Map<string, RouterCommandVariables>());
  const prevPendingTurnsRef = useRef<readonly RouterTurnEntry[]>(NO_PENDING_TURNS);

  const pendingTurns = useMemo<readonly RouterTurnEntry[]>(() => {
    if (rawMutations.length === 0) {
      latestVarsByClientIdRef.current.clear();
      prevPendingTurnsRef.current = NO_PENDING_TURNS;
      return NO_PENDING_TURNS;
    }
    const liveClientIds = new Set<string>();
    for (const t of stream.turns) {
      if (t.clientId) liveClientIds.add(t.clientId);
    }
    const deduped = new Map<string, RawRouterMutation>();
    for (const m of rawMutations) {
      if (m !== null) deduped.set(m.clientId, m);
    }
    const varsMap = new Map<string, RouterCommandVariables>();
    const built: RouterTurnEntry[] = [];
    for (const [clientId, m] of deduped) {
      varsMap.set(clientId, m.variables);
      if (liveClientIds.has(clientId)) continue;
      if (m.status === "success" && m.data?.command) {
        built.push(turnEntryOfCommand(m.data.command, resolvedSelfId, true));
        continue;
      }
      const status = m.status === "error" ? "send_failed" : "sending";
      built.push({
        kind: "turn",
        key: `turn:${clientId}`,
        clientId,
        createdAt: m.variables.createdAt,
        inputText: m.variables.text,
        attachments: m.variables.attachments,
        status,
        ...(m.status === "error" ? { unsentError: m.error } : {}),
        command: null,
        destinations: [],
        live: true,
      });
    }
    latestVarsByClientIdRef.current = varsMap;
    if (built.length === 0) {
      prevPendingTurnsRef.current = NO_PENDING_TURNS;
      return NO_PENDING_TURNS;
    }
    const prev = prevPendingTurnsRef.current;
    if (
      prev.length === built.length &&
      built.every((cur, i) => {
        const p = prev[i]!;
        return (
          p.key === cur.key &&
          p.status === cur.status &&
          p.command === cur.command &&
          p.unsentError === cur.unsentError
        );
      })
    ) {
      return prev;
    }
    prevPendingTurnsRef.current = built;
    return built;
  }, [rawMutations, stream.turns, resolvedSelfId]);

  useEffect(() => {
    if (rawMutations.length === 0) return;
    const confirmed = new Set<string>();
    for (const t of stream.turns) {
      if (t.clientId) confirmed.add(t.clientId);
    }
    pruneRouterCommandMutations(qc, confirmed);
  }, [rawMutations.length, stream.turns, qc]);

  const handleRetryUnsent = useCallback(
    (clientId: string) => {
      const vars = latestVarsByClientIdRef.current.get(clientId);
      if (!vars) return;
      const cache = qc.getMutationCache();
      for (const m of cache.findAll({ mutationKey: ROUTER_COMMAND_MUTATION_KEY })) {
        const mv = m.state.variables as RouterCommandVariables | undefined;
        if (mv?.clientId === clientId && m.state.status === "error") {
          cache.remove(m);
        }
      }
      mutateSend(vars);
    },
    [qc, mutateSend],
  );

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

  const handleSelectTarget = useCallback((targetKey: string) => {
    setSelectedTargetKey(targetKey);
  }, []);

  const handleComposerSend = useCallback(
    (text: string, files: File[]): void | Promise<void> => {
      const trimmed = text.trim();
      if (trimmed === "" && files.length === 0) return;

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
        const clientId = newClientId();
        mutateSend({
          clientId,
          text: trimmed,
          attachments: uploaded,
          attachmentIds: uploaded.map((a) => a.id),
          ...(targetPayload !== undefined ? { target: targetPayload } : {}),
          createdAt: Date.now(),
        });
      };

      if (files.length === 0) {
        draft.set("");
        if (targetSnap !== null) setSelectedTargetKey(null);
        dispatchCommand([]);
        return;
      }

      return uploadFiles(files, localClient).then((uploaded) => {
        draft.clearIfMatch(trimmed);
        staging.removeSent(files);
        if (targetSnap !== null) setSelectedTargetKey(null);
        dispatchCommand(uploaded);
      });
    },
    [selectedTarget, draft, staging, mutateSend],
  );

  const targetChip = useMemo(
    () =>
      selectedTarget ? (
        <TargetChip
          label={selectedTarget.label}
          deviceName={view.multiDevice || !selectedTarget.self ? selectedTarget.deviceName : null}
          look={selectedTarget.look}
          onRemove={() => setSelectedTargetKey(null)}
        />
      ) : null,
    [selectedTarget, view.multiDevice],
  );

  return (
    <FleetDeviceScopes lookup={deviceScopeLookup}>
      <FleetLooks lookOf={view.lookOf}>
      <FileDropZone className="flex min-h-0 flex-1 flex-col" onFiles={staging.add}>
        <header
          data-window-drag
          className="flex h-14 min-w-0 shrink-0 items-center justify-between gap-3 overflow-hidden border-b-2 border-border pr-3 pl-4"
        >
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            {leading}
            <RouterAvatar size={28} working={stream.turns.some((entry) => entry.status === "planning")} />
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
          mobile={mobile}
          multiDevice={view.multiDevice}
          decisionNotes={decisionNotes}
          decisionErrors={decisionErrors}
          onNoteChange={handleNoteChange}
          onSubmit={handleDecisionSubmit}
          onOpenConversation={onOpenConversation}
          selectedKey={selectedDecisionKey}
          onSelectKey={setSelectedDecisionKey}
        />

        <RouterStream
          stream={stream}
          selfId={resolvedSelfId}
          pendingTurns={pendingTurns}
          hasDecisions={visibleDecisions.length > 0}
          clientForDevice={clientForDevice}
          storeForDevice={storeForDevice}
          onRetryUnsent={handleRetryUnsent}
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
            sendTone="rail"
            onSelectTarget={handleSelectTarget}
            onSend={handleComposerSend}
          />
        </div>
      </FileDropZone>
      </FleetLooks>
    </FleetDeviceScopes>
  );
}
