import {
  InfiniteQueryObserver,
  notifyManager,
  useInfiniteQuery,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ExternalLink } from "../ui/icons.ts";
import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  ROUTER_STREAM_LIVE_MAX,
  ROUTER_STREAM_MAX_PAGES,
  ROUTER_STREAM_PAGE_SIZE,
  type ConversationId,
  type RouterCommandId,
  type RouterItemsPage,
  type RouterReportItem,
  type RouterReportLink,
} from "../../shared/index.ts";
import { localClient, type HubClient } from "../client.ts";
import { formatTime } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import { retryStateOf, type RouterRetries } from "../router-commands.ts";
import {
  briefingEntryOfReport,
  mergeRouterStream,
  turnEntryOfCommand,
  type FleetRouterStream,
  type RouterBriefingEntry,
  type RouterDeviceBriefings,
  type RouterStreamPos,
  type RouterStreamSource,
  type RouterTurnEntry,
} from "../router-stream.ts";
import { Button } from "../ui/button.tsx";
import { childRows, useMessageEnter, type EnterItem } from "../useMessageEnter.ts";
import { useStickToBottom } from "../useStickToBottom.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import { DeviceScopeOf, useFleetLookOf } from "../device-scope.tsx";
import { CardBody, INLINE_LINK_CLASS } from "./Deliverables.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { AgentHead } from "./Messages.tsx";
import { RouterTurnRow } from "./RouterTurnRow.tsx";

type ParsedBriefingLink =
  | { kind: "external"; url: string }
  | { kind: "worker"; deviceKey?: string; id: ConversationId }
  | { kind: "conversation"; deviceKey?: string; id: ConversationId }
  | { kind: "plain" };

function parseBriefingLink(target: string): ParsedBriefingLink {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return { kind: "external", url: t };
  const workerShort = /^worker:(\d+)$/i.exec(t);
  if (workerShort) return { kind: "worker", id: Number(workerShort[1]) };
  const convShort = /^conversation:(\d+)$/i.exec(t);
  if (convShort) return { kind: "conversation", id: Number(convShort[1]) };
  const hashMatch = /^#\/(?:d\/([^/]+)\/)?(w|c)\/(\d+)$/.exec(t);
  if (hashMatch) {
    const deviceKey = hashMatch[1];
    const id = Number(hashMatch[3]);
    return hashMatch[2] === "w"
      ? { kind: "worker", ...(deviceKey !== undefined ? { deviceKey } : {}), id }
      : { kind: "conversation", ...(deviceKey !== undefined ? { deviceKey } : {}), id };
  }
  return { kind: "plain" };
}

function BriefingLinks({
  links,
  deviceKey,
  onOpenConversation,
  onOpenWorker,
}: {
  links: readonly RouterReportLink[];
  deviceKey: string;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-minor text-muted-foreground">
      {links.map((link, idx) => {
        const parsed = parseBriefingLink(link.target);
        const label = link.label || link.target;
        if (parsed.kind === "external") {
          return (
            <a key={idx} href={parsed.url} target="_blank" rel="noreferrer" className={INLINE_LINK_CLASS}>
              <span>{label}</span>
              <ExternalLink className="size-pixel-sm shrink-0" aria-hidden="true" />
            </a>
          );
        }
        if (parsed.kind === "worker") {
          return (
            <button
              key={idx}
              type="button"
              className={INLINE_LINK_CLASS}
              onClick={() => onOpenWorker(parsed.deviceKey ?? deviceKey, parsed.id)}
            >
              {label}
            </button>
          );
        }
        if (parsed.kind === "conversation") {
          return (
            <button
              key={idx}
              type="button"
              className={INLINE_LINK_CLASS}
              onClick={() => onOpenConversation(parsed.deviceKey ?? deviceKey, parsed.id)}
            >
              {label}
            </button>
          );
        }
        return (
          <span key={idx} className="text-muted-foreground">
            {label}
          </span>
        );
      })}
    </div>
  );
}

const BriefingRow = memo(function BriefingRow({
  entry,
  head,
  showNewDivider,
  multiDevice,
  onOpenConversation,
  onOpenWorker,
}: {
  entry: RouterBriefingEntry;
  head: boolean;
  showNewDivider: boolean;
  multiDevice: boolean;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const showProject = entry.projectName !== null && entry.projectName !== entry.pmName;
  const showDevice = (multiDevice || !entry.self) && entry.deviceName !== "";
  const look = useFleetLookOf()(entry.deviceKey, entry.pmId);
  return (
    <div data-stream-entry className="w-full">
      {showNewDivider && (
        <div data-new-divider className="mt-6 mb-2 flex items-center gap-2.5 text-xs text-muted-foreground">
          <span>New</span>
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>
      )}
      <div
        data-router-briefing
        data-side="left"
        className={cn("flex flex-col", showNewDivider ? "mt-2" : head ? "mt-6 first:mt-2" : "mt-2.5")}
      >
        {head && (
          <AgentHead
            identity={{ name: entry.pmName, look }}
            onClick={() => onOpenConversation(entry.deviceKey, entry.report.conversationId)}
            trailing={
              (showProject || showDevice) && (
                <>
                  {showProject && <span className="truncate text-xs text-muted-foreground">{entry.projectName}</span>}
                  {showDevice && <span className="shrink-0 text-xs text-muted-foreground">{entry.deviceName}</span>}
                </>
              )
            }
          />
        )}
        <div className="flex flex-col gap-1.5">
          <DeviceScopeOf deviceKey={entry.deviceKey}>
            <CardBody
              text={entry.report.summary}
              deliverables={entry.report.deliverables}
              extra={
                entry.report.links.length > 0 && (
                  <BriefingLinks
                    links={entry.report.links}
                    deviceKey={entry.deviceKey}
                    onOpenConversation={onOpenConversation}
                    onOpenWorker={onOpenWorker}
                  />
                )
              }
              textClassName="text-body leading-relaxed"
            />
          </DeviceScopeOf>
          <div className="text-xs text-muted-foreground tabular-nums">{formatTime(entry.report.createdAt)}</div>
        </div>
      </div>
    </div>
  );
});

interface DevicePagerSnapshot {
  key: string;
  data: InfiniteData<RouterItemsPage> | undefined;
  isError: boolean;
  isFetching: boolean;
  hasNextPage: boolean;
}

type BriefingObserver = InfiniteQueryObserver<
  RouterItemsPage,
  Error,
  InfiniteData<RouterItemsPage>,
  readonly unknown[],
  string | null
>;

type BriefingObserverOptions = InfiniteQueryObserverOptions<
  RouterItemsPage,
  Error,
  InfiniteData<RouterItemsPage>,
  readonly unknown[],
  string | null
>;

function makeBriefingOptions(
  deviceKey: string,
  oldestCursor: string | null,
  clientForDevice: (deviceKey: string) => HubClient,
): BriefingObserverOptions {
  return {
    queryKey: ["router-stream", "briefings", deviceKey, oldestCursor] as const,
    initialPageParam: oldestCursor,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      clientForDevice(deviceKey).fetchRouterItems({
        cursor: pageParam,
        limit: ROUTER_STREAM_PAGE_SIZE,
        kind: "report",
      }),
    getNextPageParam: (lastPage: RouterItemsPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    getPreviousPageParam: () => undefined,
    maxPages: ROUTER_STREAM_MAX_PAGES,
    staleTime: Infinity,
    enabled: false,
    retry: false,
  };
}

function useDeviceBriefingPagers(
  devices: readonly RouterDeviceBriefings[],
  clientForDevice: (deviceKey: string) => HubClient,
  qc: QueryClient,
) {
  const entriesRef = useRef(
    new Map<string, { cursor: string | null; clientForDevice: typeof clientForDevice; observer: BriefingObserver }>(),
  );
  const snapshotRef = useRef<readonly DevicePagerSnapshot[]>([]);

  for (const dev of devices) {
    const existing = entriesRef.current.get(dev.key);
    if (!existing) {
      const opts = makeBriefingOptions(dev.key, dev.oldestCursor, clientForDevice);
      entriesRef.current.set(dev.key, {
        cursor: dev.oldestCursor,
        clientForDevice,
        observer: new InfiniteQueryObserver(qc, opts),
      });
    } else if (existing.cursor !== dev.oldestCursor || existing.clientForDevice !== clientForDevice) {
      existing.cursor = dev.oldestCursor;
      existing.clientForDevice = clientForDevice;
      existing.observer.setOptions(makeBriefingOptions(dev.key, dev.oldestCursor, clientForDevice));
    }
  }

  useEffect(() => {
    const activeKeys = new Set(devices.map((d) => d.key));
    for (const [key] of entriesRef.current) {
      if (!activeKeys.has(key)) {
        entriesRef.current.delete(key);
        qc.removeQueries({ queryKey: ["router-stream", "briefings", key] });
      }
    }
  }, [devices, qc]);

  const deviceKeysSig = devices.map((d) => `${d.key}:${d.oldestCursor ?? ""}`).join("|");

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const batched = notifyManager.batchCalls(onStoreChange);
      const unsubs: Array<() => void> = [];
      for (const dev of devices) {
        const rec = entriesRef.current.get(dev.key);
        if (rec) {
          unsubs.push(rec.observer.subscribe(batched));
          rec.observer.updateResult();
        }
      }
      return () => {
        for (const u of unsubs) u();
      };
    },
    [deviceKeysSig],
  );

  const getSnapshot = useCallback((): readonly DevicePagerSnapshot[] => {
    const next: DevicePagerSnapshot[] = devices.map((dev) => {
      const res = entriesRef.current.get(dev.key)?.observer.getCurrentResult();
      return {
        key: dev.key,
        data: res?.data,
        isError: Boolean(res?.isError),
        isFetching: Boolean(res?.isFetching),
        hasNextPage: Boolean(res?.hasNextPage),
      };
    });
    const prev = snapshotRef.current;
    if (
      prev.length === next.length &&
      next.every((cur, i) => {
        const p = prev[i]!;
        return (
          p.key === cur.key &&
          p.data === cur.data &&
          p.isError === cur.isError &&
          p.isFetching === cur.isFetching &&
          p.hasNextPage === cur.hasNextPage
        );
      })
    ) {
      return prev;
    }
    snapshotRef.current = next;
    return next;
  }, [deviceKeysSig]);

  const snapshots = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fetchDevicePage = useCallback((deviceKey: string) => {
    const rec = entriesRef.current.get(deviceKey);
    if (!rec) return;
    const cur = rec.observer.getCurrentResult();
    if (cur.data === undefined) void rec.observer.refetch();
    else void rec.observer.fetchNextPage();
  }, []);

  return { snapshots, fetchDevicePage };
}

const ACKED_BRIEFINGS_MAX = ROUTER_STREAM_LIVE_MAX * 4;
const ackedBriefingsByClient = new WeakMap<QueryClient, Set<string>>();

function getAckedBriefings(qc: QueryClient): Set<string> {
  let set = ackedBriefingsByClient.get(qc);
  if (set === undefined) {
    set = new Set();
    ackedBriefingsByClient.set(qc, set);
  }
  return set;
}

function addAckedBriefing(set: Set<string>, key: string): void {
  if (!set.has(key) && set.size >= ACKED_BRIEFINGS_MAX) {
    const oldest = set.keys().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

export const RouterStream = memo(function RouterStream({
  stream,
  selfId,
  pendingTurns,
  hasDecisions,
  clientForDevice,
  storeForDevice,
  retries,
  onRetryCommand,
  onRetryUnsent,
  onOpenConversation,
  onOpenWorker,
}: {
  stream: FleetRouterStream;
  selfId: string | undefined;
  pendingTurns: readonly RouterTurnEntry[];
  hasDecisions: boolean;
  clientForDevice: (deviceKey: string) => HubClient;
  storeForDevice: DeviceStoreLookup;
  retries: RouterRetries;
  onRetryCommand: (commandId: RouterCommandId, fromRetryId: string | null) => void;
  onRetryUnsent: (clientId: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const qc = useHubQueryClient();

  const commandsQuery = useInfiniteQuery(
    {
      queryKey: ["router-stream", "commands", stream.oldestCommandCursor] as const,
      initialPageParam: stream.oldestCommandCursor,
      queryFn: ({ pageParam }) =>
        localClient.fetchRouterCommands({ cursor: pageParam, limit: ROUTER_STREAM_PAGE_SIZE }),
      getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined),
      getPreviousPageParam: () => undefined,
      maxPages: ROUTER_STREAM_MAX_PAGES,
      staleTime: Infinity,
      enabled: false,
      retry: false,
    },
    qc,
  );

  const { snapshots: briefingSnapshots, fetchDevicePage } = useDeviceBriefingPagers(
    stream.devices,
    clientForDevice,
    qc,
  );

  const ackedBriefings = getAckedBriefings(qc);
  const newDividerCaptureRef = useRef<{ key: string | null; seenDevices: Set<string> }>({
    key: null,
    seenDevices: new Set(),
  });
  {
    const cap = newDividerCaptureRef.current;
    let earliest: RouterBriefingEntry | null = null;
    for (const dev of stream.devices) {
      if (cap.seenDevices.has(dev.key)) continue;
      if (cap.key === null) {
        for (const b of dev.briefings) {
          if (
            b.report.status === "unread" &&
            !ackedBriefings.has(b.key) &&
            (earliest === null || b.createdAt < earliest.createdAt || (b.createdAt === earliest.createdAt && b.key < earliest.key))
          ) {
            earliest = b;
          }
        }
      }
      cap.seenDevices.add(dev.key);
    }
    if (cap.key === null && earliest !== null) {
      cap.key = earliest.key;
    }
  }
  const newDividerKey = newDividerCaptureRef.current.key;

  const sentUnreadSigRef = useRef(new Map<string, string>());
  const failedReadRef = useRef(new Set<string>());
  useEffect(() => {
    const flushRead = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const acked = getAckedBriefings(qc);
      const activeDeviceKeys = new Set(stream.devices.map((d) => d.key));
      for (const key of sentUnreadSigRef.current.keys()) {
        if (!activeDeviceKeys.has(key)) {
          sentUnreadSigRef.current.delete(key);
          failedReadRef.current.delete(key);
        }
      }
      for (const dev of stream.devices) {
        if (!dev.online) {
          if (failedReadRef.current.delete(dev.key)) sentUnreadSigRef.current.delete(dev.key);
          continue;
        }
        const unreadIds: number[] = [];
        const unreadKeys: string[] = [];
        for (const b of dev.briefings) {
          if (b.report.status === "archived") {
            acked.delete(b.key);
          } else if (!acked.has(b.key)) {
            unreadIds.push(b.report.id);
            unreadKeys.push(b.key);
          }
        }
        if (unreadIds.length === 0) {
          sentUnreadSigRef.current.delete(dev.key);
          failedReadRef.current.delete(dev.key);
          continue;
        }
        unreadIds.sort((a, b) => a - b);
        const sig = unreadIds.join(",");
        if (sentUnreadSigRef.current.get(dev.key) === sig) continue;
        sentUnreadSigRef.current.set(dev.key, sig);
        failedReadRef.current.delete(dev.key);
        clientForDevice(dev.key)
          .postArchiveAllRouterReports()
          .then(() => {
            for (const k of unreadKeys) addAckedBriefing(acked, k);
          })
          .catch(() => {
            if (sentUnreadSigRef.current.get(dev.key) === sig) failedReadRef.current.add(dev.key);
          });
      }
    };
    flushRead();
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      for (const key of failedReadRef.current) sentUnreadSigRef.current.delete(key);
      failedReadRef.current.clear();
      flushRead();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stream.devices, clientForDevice, qc]);

  const { entries, hasMore, anyError, anyFetching, loadTargets } = useMemo(() => {
    const liveCmdIds = new Set<number>();
    const liveClientIds = new Set<string>();
    for (const t of stream.turns) {
      if (t.command) liveCmdIds.add(t.command.id);
      if (t.clientId) liveClientIds.add(t.clientId);
    }
    const olderTurns: RouterTurnEntry[] = [];
    const cmdPages = commandsQuery.data?.pages ?? [];
    let oldestCmd: { createdAt: number; id: number } | null = stream.oldestCommand;
    for (const page of cmdPages) {
      for (const cmd of page.commands) {
        if (oldestCmd === null || cmd.createdAt < oldestCmd.createdAt || (cmd.createdAt === oldestCmd.createdAt && cmd.id < oldestCmd.id)) {
          oldestCmd = cmd;
        }
        if (cmd.status === "cancelled" || liveCmdIds.has(cmd.id)) continue;
        liveCmdIds.add(cmd.id);
        if (cmd.clientId) liveClientIds.add(cmd.clientId);
        olderTurns.push(turnEntryOfCommand(cmd, selfId, false));
      }
    }

    const activePending = pendingTurns.filter((p) => !liveClientIds.has(p.clientId));
    const persistedTurns = olderTurns.length > 0 ? [...olderTurns, ...stream.turns] : stream.turns;
    const allTurns = activePending.length > 0 ? [...persistedTurns, ...activePending] : persistedTurns;

    const cmdNeverFetched = commandsQuery.data === undefined && !commandsQuery.isError;
    const cmdHasMore = cmdNeverFetched
      ? stream.commandsHasMore
      : commandsQuery.isError || (Boolean(commandsQuery.hasNextPage) && cmdPages.length < ROUTER_STREAM_MAX_PAGES);
    const cmdLoadedDownTo: RouterStreamPos | null =
      cmdHasMore && oldestCmd !== null ? { createdAt: oldestCmd.createdAt, kind: "turn", deviceKey: "", id: oldestCmd.id } : null;

    const sources: RouterStreamSource[] = [
      { entries: allTurns, loadedDownTo: cmdLoadedDownTo, hasMore: cmdHasMore },
    ];
    const nextTargets: Array<
      | { kind: "commands"; isError: boolean }
      | { kind: "device"; deviceKey: string; isError: boolean }
    > = [];
    if (cmdHasMore) {
      nextTargets.push({ kind: "commands", isError: commandsQuery.isError });
    }

    let errored = commandsQuery.isError && cmdHasMore;
    let fetching = commandsQuery.isFetching;

    for (let i = 0; i < stream.devices.length; i++) {
      const dev = stream.devices[i]!;
      const snap = briefingSnapshots[i];
      const liveRepIds = new Set<number>();
      for (const b of dev.briefings) liveRepIds.add(b.report.id);

      const olderBriefings: RouterBriefingEntry[] = [];
      const repPages = snap?.data?.pages ?? [];
      let oldestRep: { createdAt: number; id: number } | null = dev.oldestReport;
      for (const page of repPages) {
        for (const item of page.items) {
          if (oldestRep === null || item.createdAt < oldestRep.createdAt || (item.createdAt === oldestRep.createdAt && item.id < oldestRep.id)) {
            oldestRep = item;
          }
          if (item.kind !== "report" || liveRepIds.has(item.id)) continue;
          liveRepIds.add(item.id);
          const entry = briefingEntryOfReport(item as RouterReportItem, {
            deviceKey: dev.key,
            deviceName: dev.name,
            self: dev.self,
            pmById: dev.pmById,
            projectById: dev.projectById,
            live: false,
          });
          if (entry !== null) olderBriefings.push(entry);
        }
      }

      const allBriefings = olderBriefings.length > 0 ? [...olderBriefings, ...dev.briefings] : dev.briefings;
      const repNeverFetched = snap === undefined || (snap.data === undefined && !snap.isError);
      const repHasMore =
        dev.online &&
        (repNeverFetched
          ? dev.hasMore
          : Boolean(snap?.isError) || (Boolean(snap?.hasNextPage) && repPages.length < ROUTER_STREAM_MAX_PAGES));
      const repLoadedDownTo: RouterStreamPos | null =
        repHasMore && oldestRep !== null
          ? { createdAt: oldestRep.createdAt, kind: "briefing", deviceKey: dev.key, id: oldestRep.id }
          : null;

      sources.push({ entries: allBriefings, loadedDownTo: repLoadedDownTo, hasMore: repHasMore });
      if (repHasMore) {
        const devErr = Boolean(snap?.isError);
        if (devErr) errored = true;
        nextTargets.push({ kind: "device", deviceKey: dev.key, isError: devErr });
      }
      if (snap?.isFetching) fetching = true;
    }

    const merged = mergeRouterStream(sources);
    return {
      entries: merged.entries,
      hasMore: merged.hasMore,
      anyError: errored,
      anyFetching: fetching,
      loadTargets: nextTargets,
    };
  }, [
    stream,
    selfId,
    pendingTurns,
    commandsQuery.data,
    commandsQuery.isError,
    commandsQuery.isFetching,
    commandsQuery.hasNextPage,
    briefingSnapshots,
  ]);

  const handleLoadEarlier = useCallback(() => {
    if (anyFetching) return;
    const targets = anyError ? loadTargets.filter((t) => t.isError) : loadTargets;
    for (const target of targets) {
      if (target.kind === "commands") {
        if (commandsQuery.data === undefined) void commandsQuery.refetch();
        else void commandsQuery.fetchNextPage();
      } else {
        fetchDevicePage(target.deviceKey);
      }
    }
  }, [anyFetching, anyError, loadTargets, commandsQuery, fetchDevicePage]);

  const ownCount = useMemo(
    () => stream.turns.length + pendingTurns.length,
    [stream.turns.length, pendingTurns.length],
  );
  const lastEntry = entries.at(-1);
  const lastKey = lastEntry
    ? lastEntry.kind === "turn"
      ? `${lastEntry.key}:${lastEntry.status}:${lastEntry.command?.updatedAt ?? 0}`
      : `${lastEntry.key}:${lastEntry.report.updatedAt}`
    : "empty";
  const headKey = entries[0]?.key ?? "empty";

  const { ref, contentRef, away, scrollToBottom, loadOlder, onScroll } = useStickToBottom({
    lastKey,
    ownCount,
    headKey,
    canLoadOlder: hasMore && !anyFetching && !anyError,
    onLoadOlder: handleLoadEarlier,
  });

  const empty = !hasDecisions && entries.length === 0 && !hasMore;
  const enterItemAt = (index: number): EnterItem => ({ key: entries[index]!.key, turn: false });
  useMessageEnter(() => childRows(contentRef.current, Number(hasMore) + Number(empty), entries.length, false), entries.length, enterItemAt, false, empty);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        role="log"
        aria-label="Router timeline"
        onScroll={onScroll}
        className="messages router-timeline min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        <div ref={contentRef} className="flex min-h-full flex-col pt-8 pb-12">
          {hasMore && (
            <button
              type="button"
              className="touch-target mb-2 cursor-pointer self-center px-3 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-default disabled:opacity-60"
              disabled={anyFetching}
              onClick={loadOlder}
            >
              {anyError ? "Couldn't load. Click to retry" : anyFetching ? "Loading…" : "Load earlier"}
            </button>
          )}

          {empty && (
            <div className="m-auto flex flex-col items-center gap-3 py-10 text-center" data-empty>
              <RouterAvatar size={36} className="opacity-40" />
              <p className="text-minor text-muted-foreground">All clear</p>
            </div>
          )}

          {entries.map((entry, index) => {
            if (entry.kind === "turn") {
              const { retryPending, retryError } = retryStateOf(entry, retries);
              return (
                <RouterTurnRow
                  key={entry.key}
                  entry={entry}
                  multiDevice={stream.multiDevice}
                  clientForDevice={clientForDevice}
                  storeForDevice={storeForDevice}
                  retryPending={retryPending}
                  retryError={retryError}
                  onRetryCommand={onRetryCommand}
                  onRetryUnsent={onRetryUnsent}
                  onOpenConversation={onOpenConversation}
                  onOpenWorker={onOpenWorker}
                />
              );
            }
            const prev = entries[index - 1];
            const showNewDivider = newDividerKey !== null && entry.key === newDividerKey;
            const head = !(
              prev?.kind === "briefing" &&
              prev.deviceKey === entry.deviceKey &&
              prev.report.pmId === entry.report.pmId
            );
            return (
              <BriefingRow
                key={entry.key}
                entry={entry}
                head={head}
                showNewDivider={showNewDivider}
                multiDevice={stream.multiDevice}
                onOpenConversation={onOpenConversation}
                onOpenWorker={onOpenWorker}
              />
            );
          })}
        </div>
      </div>

      {away && (
        <div className="messages pointer-events-none absolute inset-x-0 bottom-9 flex justify-center" data-back-to-bottom>
          <Button
            variant="outline"
            size="icon-sm"
            className="pointer-events-auto"
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            onClick={scrollToBottom}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
});
