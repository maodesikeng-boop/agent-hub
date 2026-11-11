// Router 无卡片时间流（docs/ui-standard.md 第 21 条、docs/router-workbench-v2-design.md 第 4、5 节）：
// 指令回合（右气泡 + 左水果刀结果与去向跳转行）与跨设备 PM 里程碑简报按时间合流，看到即标已读，共享 useStickToBottom。
import {
  InfiniteQueryObserver,
  notifyManager,
  useInfiniteQuery,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleAlert, ExternalLink } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX,
  ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX,
  ROUTER_STREAM_LIVE_MAX,
  ROUTER_STREAM_MAX_PAGES,
  ROUTER_STREAM_PAGE_SIZE,
  type ConversationId,
  type RouterCommandId,
  type RouterItemsPage,
  type RouterReportItem,
  type RouterReportLink,
} from "../../shared/index.ts";
import { ApiError, localClient, type HubClient } from "../client.ts";
import { errorLine, errorText, errorTitle, formatTime, type ErrorLike } from "../format.ts";
import { paletteOf } from "../lib/palette.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import {
  briefingEntryOfReport,
  canRetryCommand,
  mergeRouterStream,
  turnEntryOfCommand,
  type FleetRouterStream,
  type RouterBriefingEntry,
  type RouterDeviceBriefings,
  type RouterStreamEntry,
  type RouterStreamSource,
  type RouterTurnDestination,
  type RouterTurnEntry,
} from "../router-stream.ts";
import { Button } from "../ui/button.tsx";
import { useMessageEnter, type EnterItem } from "../useMessageEnter.ts";
import { useStickToBottom } from "../useStickToBottom.ts";
import { AttachmentList } from "./Attachments.tsx";
import { Avatar } from "./Avatar.tsx";
import { KnifeAvatar } from "./KnifeAvatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { AgentHead, BUBBLE, CopyButton, SentBody, TEXT_BUTTON, UnsentMark } from "./Messages.tsx";

const ROUTER_IDENTITY = { name: "Router", avatarKey: 0 } as const;

const INLINE_LINK_CLASS =
  "touch-target inline-flex cursor-pointer items-center gap-1 rounded-xl text-link underline decoration-link/40 transition-colors outline-none hover:decoration-link focus-visible:ring-2 focus-visible:ring-ring/50";

function jellyStyle(avatarKey: number): CSSProperties {
  return { "--jelly": paletteOf(avatarKey).accent } as CSSProperties;
}

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
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
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

function DestinationRow({
  dest,
  multiDevice,
  onOpenConversation,
  onOpenWorker,
}: {
  dest: RouterTurnDestination;
  multiDevice: boolean;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const showProject = dest.projectName !== null && dest.projectName !== dest.name;
  const showDevice = (multiDevice || !dest.self) && dest.deviceName !== "";
  return (
    <button
      type="button"
      data-destination
      style={jellyStyle(dest.avatarKey)}
      className="flex w-full pointer-coarse:min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors outline-none hover:bg-jelly-hover focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() =>
        dest.worker
          ? onOpenWorker(dest.deviceKey, dest.conversationId)
          : onOpenConversation(dest.deviceKey, dest.conversationId)
      }
    >
      <Avatar colorKey={dest.avatarKey} size={20} neutral={dest.worker} />
      <span className="min-w-0 truncate text-body font-medium text-foreground">{dest.name}</span>
      {showProject && <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{dest.projectName}</span>}
      {showDevice && <span className="shrink-0 text-xs text-muted-foreground">{dest.deviceName}</span>}
      {dest.opLabel !== null && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{dest.opLabel}</span>
      )}
      <ChevronRight
        className={cn("size-4 shrink-0 text-muted-foreground", dest.opLabel === null && "ml-auto")}
        aria-hidden="true"
      />
    </button>
  );
}

const TurnRow = memo(function TurnRow({
  entry,
  multiDevice,
  retryPending,
  retryError,
  onRetryCommand,
  onRetryUnsent,
  onOpenConversation,
  onOpenWorker,
}: {
  entry: RouterTurnEntry;
  multiDevice: boolean;
  retryPending: boolean;
  retryError: ErrorLike | undefined;
  onRetryCommand: (commandId: RouterCommandId, updatedAt: number) => void;
  onRetryUnsent: (clientId: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const effectiveStatus = retryPending ? "planning" : entry.status;
  const isSending = effectiveStatus === "sending";
  const isSendFailed = effectiveStatus === "send_failed";
  const command = entry.command;
  const plan = command?.plan ?? null;
  const rawReply = plan?.reply ?? "";
  // 轨道 A 成功投递后去向行已经把目标和状态交代清楚，不再重复画那句模板回执
  const showReply = rawReply.trim() !== "" && !(plan?.track === "A" && effectiveStatus === "dispatched");
  const isRunning = effectiveStatus === "planning";
  const isFailed = effectiveStatus === "failed";
  const canRetry = isFailed && entry.live && command !== null && canRetryCommand(command);

  let unsentNode: React.ReactNode = null;
  if (isSendFailed) {
    const err = entry.unsentError;
    const rejected = err instanceof ApiError && err.status === 400;
    const info = err !== undefined ? errorText(err) : undefined;
    const reason = info !== undefined ? errorLine(info) : undefined;
    const raw = info !== undefined ? errorTitle(info) : undefined;
    unsentNode = (
      <UnsentMark
        reason={reason}
        raw={raw}
        {...(rejected ? {} : { onRetry: () => onRetryUnsent(entry.clientId) })}
      />
    );
  }

  const failReason =
    retryError !== undefined ? errorLine(retryError) : (command?.error ?? "总助这次没能完成，请重试");
  const failRaw =
    retryError !== undefined ? errorTitle(retryError) : (plan?.errorRaw !== undefined && plan.errorRaw !== failReason ? plan.errorRaw : undefined);

  return (
    <div data-stream-entry className="chat-column w-full">
      <div data-router-turn data-status={effectiveStatus} className="mt-6 flex flex-col first:mt-2">
        <article className="flex flex-col items-end" data-side="right" title={formatTime(entry.createdAt)}>
          <SentBody unsent={unsentNode}>
            {(entry.inputText !== "" || entry.attachments.length === 0) && (
              <div
                data-bubble
                className={cn(
                  BUBBLE,
                  "max-w-[80%] bg-bubble-me whitespace-pre-wrap text-bubble-me-foreground [overflow-wrap:anywhere]",
                )}
              >
                {entry.inputText}
              </div>
            )}
            <AttachmentList attachments={entry.attachments} />
          </SentBody>
        </article>

        {!isSending && !isSendFailed && (
          <div className="mt-4 flex flex-col" data-side="left">
            <AgentHead identity={ROUTER_IDENTITY} avatar={<KnifeAvatar size={26} />} />
            <div className="flex flex-col gap-2.5">
              {entry.destinations.length > 0 && (
                <div className="-mx-2.5 flex flex-col gap-0.5">
                  {entry.destinations.map((dest) => (
                    <DestinationRow
                      key={dest.key}
                      dest={dest}
                      multiDevice={multiDevice}
                      onOpenConversation={onOpenConversation}
                      onOpenWorker={onOpenWorker}
                    />
                  ))}
                </div>
              )}

              {showReply && (
                <div className="w-full min-w-0 text-body leading-relaxed">
                  <Markdown text={rawReply} />
                </div>
              )}

              {plan?.replyTruncated === true && (
                <p className="text-xs text-muted-foreground">Reply truncated</p>
              )}

              {isRunning && (
                <div className="text-minor text-muted-foreground">
                  <span className="status-shimmer">Working…</span>
                </div>
              )}

              {isFailed && (
                <div className="flex items-start gap-2 text-minor leading-5">
                  <CircleAlert className="mt-0.75 size-3.5 shrink-0 text-danger" aria-hidden="true" />
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
                    <span className="text-minor text-muted-foreground" title={failRaw}>
                      {failReason}
                    </span>
                    {canRetry && command !== null && (
                      <button
                        type="button"
                        className={cn(TEXT_BUTTON, "px-1 text-minor font-medium text-muted-foreground")}
                        onClick={() => onRetryCommand(command.id, command.updatedAt)}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )}

              {!isRunning && !isFailed && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                  {showReply && <CopyButton text={rawReply} />}
                  <span>{formatTime(entry.createdAt)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

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
  return (
    <div data-stream-entry className="chat-column w-full">
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
            identity={{ name: entry.pmName, avatarKey: entry.avatarKey }}
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
          <div className="w-full min-w-0 text-body leading-relaxed">
            <Markdown text={entry.report.summary} />
          </div>
          <BriefingLinks
            links={entry.report.links}
            deviceKey={entry.deviceKey}
            onOpenConversation={onOpenConversation}
            onOpenWorker={onOpenWorker}
          />
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
      pageParam
        ? clientForDevice(deviceKey).fetchRouterItems({
            cursor: pageParam,
            limit: ROUTER_STREAM_PAGE_SIZE,
            kind: "report",
          })
        : Promise.resolve({ items: [], nextCursor: null, hasMore: false }),
    getNextPageParam: (lastPage: RouterItemsPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    getPreviousPageParam: () => undefined,
    maxPages: ROUTER_STREAM_MAX_PAGES,
    staleTime: Infinity,
    enabled: false,
    retry: false,
  };
}

/** 动态台数设备的简报历史分页（复用 @tanstack/react-query 的 InfiniteQueryObserver，设备移除时同步清理缓存）。 */
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  onRetryUnsent,
  onOpenConversation,
  onOpenWorker,
}: {
  stream: FleetRouterStream;
  selfId: string | undefined;
  pendingTurns: readonly RouterTurnEntry[];
  hasDecisions: boolean;
  clientForDevice: (deviceKey: string) => HubClient;
  onRetryUnsent: (clientId: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const qc = useHubQueryClient();

  // 指令历史分页（入口本机）
  const commandsQuery = useInfiniteQuery(
    {
      queryKey: ["router-stream", "commands", stream.oldestCommandCursor] as const,
      initialPageParam: stream.oldestCommandCursor,
      queryFn: ({ pageParam }) =>
        pageParam
          ? localClient.fetchRouterCommands({ cursor: pageParam, limit: ROUTER_STREAM_PAGE_SIZE })
          : Promise.resolve({ commands: [], nextCursor: null, hasMore: false }),
      getNextPageParam: (lastPage) => (lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined),
      getPreviousPageParam: () => undefined,
      maxPages: ROUTER_STREAM_MAX_PAGES,
      staleTime: Infinity,
      enabled: false,
      retry: false,
    },
    qc,
  );

  // 各就绪设备的简报历史分页
  const { snapshots: briefingSnapshots, fetchDevicePage } = useDeviceBriefingPagers(
    stream.devices,
    clientForDevice,
    qc,
  );

  // 失败指令原地 Retry 状态（同步防连点重入 + 200 返回至 WS 推送前无缝保持 Working…）
  const retryingLockRef = useRef(new Set<RouterCommandId>());
  const [retryingMap, setRetryingMap] = useState<Readonly<Record<RouterCommandId, number>>>({});
  const [retryErrors, setRetryErrors] = useState<Readonly<Record<RouterCommandId, ErrorLike>>>({});

  useEffect(() => {
    const hasRetrying = Object.keys(retryingMap).length > 0;
    const hasErrors = Object.keys(retryErrors).length > 0;
    if (!hasRetrying && !hasErrors) return;
    const liveFailed = new Map<RouterCommandId, number>();
    for (const t of stream.turns) {
      if (t.command && t.command.status === "failed") liveFailed.set(t.command.id, t.command.updatedAt);
    }
    if (hasRetrying) {
      setRetryingMap((prev) => {
        const kept = Object.entries(prev).filter(([id, prevAt]) => liveFailed.get(Number(id)) === prevAt);
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
      });
    }
    if (hasErrors) {
      setRetryErrors((prev) => {
        const kept = Object.entries(prev).filter(([id]) => liveFailed.has(Number(id)));
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
      });
    }
  }, [stream.turns, retryingMap, retryErrors]);

  const handleRetryCommand = useCallback(async (commandId: RouterCommandId, updatedAt: number) => {
    if (retryingLockRef.current.has(commandId)) return;
    retryingLockRef.current.add(commandId);
    setRetryingMap((prev) => ({ ...prev, [commandId]: updatedAt }));
    setRetryErrors((prev) => {
      if (prev[commandId] === undefined) return prev;
      const { [commandId]: _cleared, ...rest } = prev;
      return rest;
    });
    try {
      await localClient.postRetryRouterCommand(commandId);
    } catch (err) {
      setRetryingMap((prev) => {
        const { [commandId]: _cleared, ...rest } = prev;
        return rest;
      });
      setRetryErrors((prev) => ({ ...prev, [commandId]: errorText(err) }));
    } finally {
      retryingLockRef.current.delete(commandId);
    }
  }, []);

  // 打开 #/router 时刻定格的 New 分隔线：只在设备第一次进入视野且尚未定格时记下最早一条未读简报的 key，之后标已读或新简报进来都不挪动
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

  // 看到即标已读：页面可见时，每台有未读简报的在线设备按未读编号集合去重各调一次 archive-all。
  // 失败了集合照样记着（不改界面），只在页面重新可见或未读集合变了（来了新简报）时再试，别的流更新不重发。
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
          // 掉线期间失败过的，重新连上就再试一次
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

  // 组装各来源（指令来源 + 各设备简报来源）并做水位线合并
  const { entries, hasMore, anyError, anyFetching, loadTargets } = useMemo(() => {
    // 1. 指令来源
    const liveCmdIds = new Set<number>();
    const liveClientIds = new Set<string>();
    for (const t of stream.turns) {
      if (t.command) liveCmdIds.add(t.command.id);
      if (t.clientId) liveClientIds.add(t.clientId);
    }
    const olderTurns: RouterTurnEntry[] = [];
    const cmdPages = commandsQuery.data?.pages ?? [];
    for (const page of cmdPages) {
      for (const cmd of page.commands) {
        if (cmd.status === "cancelled" || liveCmdIds.has(cmd.id)) continue;
        liveCmdIds.add(cmd.id);
        if (cmd.clientId) liveClientIds.add(cmd.clientId);
        olderTurns.push(turnEntryOfCommand(cmd, selfId, false));
      }
    }
    olderTurns.sort((a, b) => a.createdAt - b.createdAt || (a.command?.id ?? 0) - (b.command?.id ?? 0));

    const activePending = pendingTurns.filter((p) => !liveClientIds.has(p.clientId));
    const persistedTurns = olderTurns.length > 0 ? [...olderTurns, ...stream.turns] : stream.turns;
    const allTurns = activePending.length > 0 ? [...persistedTurns, ...activePending] : persistedTurns;

    // 快照近窗除了条数还有字节上限（ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES），几条长回答就能把它截到不满 10 条，
    // 所以没翻过之前只要近窗里有东西就给 Load earlier，第一页回来再以服务端的 hasMore 为准。
    // 水位线只在近窗满了条数上限（大概率被截过）或已经翻过还有更多时才挡，免得一边只有几条新内容就把另一边全挡住。
    const cmdNeverFetched = commandsQuery.data === undefined && !commandsQuery.isError;
    const cmdHasMore =
      stream.oldestCommandCursor !== null &&
      (cmdNeverFetched ||
        commandsQuery.isError ||
        (Boolean(commandsQuery.hasNextPage) && cmdPages.length < ROUTER_STREAM_MAX_PAGES));
    const cmdGuards = cmdNeverFetched ? stream.liveCommandCount >= ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX : cmdHasMore;
    const cmdLoadedDownTo = cmdHasMore && cmdGuards && persistedTurns.length > 0 ? persistedTurns[0]!.createdAt : null;

    const sources: RouterStreamSource<RouterStreamEntry>[] = [
      { entries: allTurns, loadedDownTo: cmdLoadedDownTo, hasMore: cmdHasMore },
    ];
    const nextTargets: Array<
      | { kind: "commands"; isError: boolean }
      | { kind: "device"; deviceKey: string; isError: boolean }
    > = [];
    if (cmdHasMore && stream.oldestCommandCursor !== null) {
      nextTargets.push({ kind: "commands", isError: commandsQuery.isError });
    }

    let errored = commandsQuery.isError && cmdHasMore;
    let fetching = commandsQuery.isFetching;

    // 2. 各就绪设备的简报来源
    for (let i = 0; i < stream.devices.length; i++) {
      const dev = stream.devices[i]!;
      const snap = briefingSnapshots[i];
      const liveRepIds = new Set<number>();
      for (const b of dev.briefings) liveRepIds.add(b.report.id);

      const olderBriefings: RouterBriefingEntry[] = [];
      const repPages = snap?.data?.pages ?? [];
      for (const page of repPages) {
        for (const item of page.items) {
          // 旧版守护进程不认识 kind=report，网页再按 kind === "report" 滤一次
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
      olderBriefings.sort((a, b) => a.createdAt - b.createdAt || a.report.id - b.report.id);

      const allBriefings = olderBriefings.length > 0 ? [...olderBriefings, ...dev.briefings] : dev.briefings;
      // 和指令同一个口径：没翻过之前有就给 Load earlier；近窗满了快照条数上限才挡水位线
      const repNeverFetched = snap === undefined || (snap.data === undefined && !snap.isError);
      const repHasMore =
        dev.online &&
        dev.oldestCursor !== null &&
        (repNeverFetched ||
          Boolean(snap?.isError) ||
          (Boolean(snap?.hasNextPage) && repPages.length < ROUTER_STREAM_MAX_PAGES));
      const repGuards = repNeverFetched ? dev.liveReportCount >= ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX : repHasMore;
      const repLoadedDownTo = repHasMore && repGuards && allBriefings.length > 0 ? allBriefings[0]!.createdAt : null;

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
  useMessageEnter(contentRef, Number(hasMore) + Number(empty), entries.length, enterItemAt, false, empty);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        role="log"
        aria-label="Router timeline"
        onScroll={onScroll}
        className="messages min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        <div ref={contentRef} className="flex min-h-full flex-col pt-4 pb-12">
          {hasMore && (
            <button
              type="button"
              className="touch-target mb-2 cursor-pointer self-center rounded-full px-3 py-1 text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60"
              disabled={anyFetching}
              onClick={loadOlder}
            >
              {anyError ? "Couldn't load. Click to retry" : anyFetching ? "Loading…" : "Load earlier"}
            </button>
          )}

          {empty && (
            <div className="m-auto flex flex-col items-center gap-3 py-10 text-center" data-empty>
              <KnifeAvatar size={36} className="opacity-40" />
              <p className="text-minor text-muted-foreground">All clear</p>
            </div>
          )}

          {entries.map((entry, index) => {
            if (entry.kind === "turn") {
              const cmdId = entry.command?.id;
              const retryPending =
                cmdId !== undefined &&
                entry.command?.status === "failed" &&
                retryingMap[cmdId] !== undefined &&
                retryingMap[cmdId] === entry.command.updatedAt;
              const retryError = cmdId !== undefined ? retryErrors[cmdId] : undefined;
              return (
                <TurnRow
                  key={entry.key}
                  entry={entry}
                  multiDevice={stream.multiDevice}
                  retryPending={retryPending}
                  retryError={retryError}
                  onRetryCommand={handleRetryCommand}
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
            variant="secondary"
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
