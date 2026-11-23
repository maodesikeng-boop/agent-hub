import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2, MessageCircleQuestionMark } from "../ui/icons.ts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  askOf,
  DEFAULT_AGENT_VENDOR,
  GRAPH_HISTORY_PAGE_SIZE,
  MAX_COMPLETED_GRAPH_PAGES,
  agentEffortOf,
  effortLabel,
  isAgentVendor,
  isTaskNodeWaitingUser,
  modelShortLabel,
} from "../../shared/index.ts";
import type { ConversationId, Message, MessageId, ProjectId, TaskGraph, TaskGraphId, TaskNode, UserBlockerId, WorkerId } from "../../shared/index.ts";
import { cleanPieceTitle, errorText, formatContext, formatTokenDetail, NEEDS_YOU, NO_DATA } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import { stripMarkdown } from "../plainText.ts";
import { useHubQueryClient } from "../query-client.ts";
import { useClient } from "../device-scope.tsx";
import { boundWorkerIdsOf, isWorkerBound, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { normalizeTaskGraphs } from "../task-graph-compat.ts";
import type { WorkerTone } from "../worker-status.ts";
import { Button } from "../ui/button.tsx";
import { Avatar } from "./Avatar.tsx";
import { defaultLookOf, type SlimeLook } from "../../shared/slimes.ts";
import { PeelTrackList } from "./PeelTrack.tsx";
import { ShimmerOverlay } from "./StatusShimmer.tsx";
import { TaskProgressIcon } from "./TaskProgressIcon.tsx";
import { TaskGraphDialog } from "./TaskGraphDialog.tsx";

const BUSY_ACTIVITIES: ReadonlySet<string> = new Set(["working", "preparing", "background"]);
const IDLE_ACTIVITIES: ReadonlySet<string> = new Set(["stopping", "idle"]);
export const RIGHT_RAIL_VISIBLE_ROWS = 3;
const NO_LOOK = defaultLookOf(0);

const isBusy = (worker: WorkerEntry) => !worker.ended && (BUSY_ACTIVITIES.has(worker.activity) || !IDLE_ACTIVITIES.has(worker.activity));

const RIGHT_RAIL_ID = "right-rail";

const ROW_BASE = "flex w-[calc(100%+1.25rem)] pointer-coarse:min-h-11 cursor-pointer -mx-2.5 rounded-xl px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const ROW = cn(ROW_BASE, "gap-3");
const ITEM_HOVER = "hover:bg-jelly-hover";
const ITEM_SELECTED = "bg-jelly";
const ROW_ICON = "size-4 shrink-0 text-muted-foreground";
const ICON_STROKE = 1.5;
const TONE_DOT: Record<WorkerTone, string> = { success: "bg-success", warn: "bg-caution", danger: "bg-danger", neutral: "bg-muted-foreground/50" };

export const RIGHT_RAIL_COLLAPSED_KEY = "agent-hub.rightRail.collapsed";
type GroupKey = "asks" | "graphs" | "workers";
const readCollapsed = (): Partial<Record<GroupKey, true>> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    return {
      ...(value.asks === true && { asks: true as const }),
      ...(value.graphs === true && { graphs: true as const }),
      ...(value.workers === true && { workers: true as const }),
    };
  } catch {
    return {};
  }
};
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (key: GroupKey) =>
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      try {
        if (Object.keys(next).length > 0) localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, JSON.stringify(next));
        else localStorage.removeItem(RIGHT_RAIL_COLLAPSED_KEY);
      } catch {
      }
      return next;
    });
  return { collapsed, toggle };
}

function GroupTitle({
  id,
  bodyId,
  children,
  collapsed,
  onToggle,
  dot = false,
  trailing,
}: {
  id: string;
  bodyId: string;
  children: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  dot?: boolean;
  trailing?: React.ReactNode;
}) {
  const title = (
    <h2 id={id} className={cn("h-8 min-w-0 pointer-coarse:h-11 text-xs font-medium text-muted-foreground", trailing && "flex-1")}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="-mx-2.5 flex h-8 pointer-coarse:h-11 w-[calc(100%+1.25rem)] cursor-pointer items-center gap-2 rounded-xl px-2.5 text-left transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onToggle}
      >
        {dot && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />}
        <span className="min-w-0 truncate">{children}</span>
        <ChevronRight
          className={cn(
            "size-pixel-sm shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
            !collapsed && "rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
    </h2>
  );
  if (!trailing) return title;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {title}
      <div className="-mr-2 shrink-0">{trailing}</div>
    </div>
  );
}

function GroupBody({ id, collapsed, children }: { id: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <div
      id={id}
      data-group-body
      aria-hidden={collapsed || undefined}
      inert={collapsed}
      className={cn("grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none", collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}
    >
      {/* Bleed 12px on both sides so overflow-hidden does not clip the rows' focus rings. */}
      <div className="-mx-3 min-h-0 overflow-hidden px-3">{children}</div>
    </div>
  );
}

function MoreToggle({ expanded, onClick, children, ...rest }: { expanded: boolean; onClick: () => void; children: React.ReactNode } & React.AriaAttributes) {
  return (
    <button type="button" aria-expanded={expanded} className={cn(ROW, "h-8 pointer-coarse:h-11 items-center text-minor text-muted-foreground hover:bg-sidebar-hover hover:text-foreground")} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

function askSummary(text: string): string {
  for (const line of text.split("\n")) {
    const plain = stripMarkdown(line);
    if (plain !== "") return plain;
  }
  return "";
}

function AskRow({ ask, onOpen }: { ask: Message; onOpen: () => void }) {
  const summary = askSummary(ask.text);
  return (
    <li>
      <button type="button" title={summary} className={cn(ROW, "items-center", ITEM_HOVER)} onClick={onOpen}>
        <MessageCircleQuestionMark className={ROW_ICON} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body leading-5">{summary}</span>
        <ChevronRight className={cn(ROW_ICON, "size-pixel-sm")} aria-hidden="true" />
      </button>
    </li>
  );
}

function usePieceMeta(worker: WorkerEntry): { model: string | null; effort: string | null; context: string | null } {
  const vendor = isAgentVendor(worker.vendor) ? worker.vendor : DEFAULT_AGENT_VENDOR;
  const catalog = useModelCatalog(vendor);
  const context = formatContext(worker.usage);
  const model = worker.model ?? null;
  const rawEffort = agentEffortOf(vendor, model, worker.effort ?? null, catalog);
  return {
    model: worker.vendor === undefined ? null : model === null ? (catalog.defaultModel ?? null) : modelShortLabel(vendor, model, catalog),
    effort: rawEffort === null || rawEffort === "" ? null : effortLabel(rawEffort, vendor, catalog),
    context: context !== NO_DATA ? context : null,
  };
}

export function PieceMeta({ worker }: { worker: WorkerEntry }) {
  const { model, effort, context } = usePieceMeta(worker);
  if (model === null && effort === null && context === null) return null;
  return (
    <span
      data-testid="piece-meta"
      className="flex min-w-0 items-baseline gap-3 overflow-hidden text-xs text-muted-foreground max-[720px]:hidden @max-[18rem]/chat:hidden"
    >
      {model !== null && (
        <span title={model} className={cn("min-w-0 truncate", context !== null && "@max-[22rem]/chat:hidden")}>
          {model}
        </span>
      )}
      {effort !== null && (
        <span className={cn("shrink-0", (model !== null || context !== null) && "@max-[26rem]/chat:hidden")}>
          {effort}
        </span>
      )}
      {context !== null && (
        <span className="shrink-0 tabular-nums" title={formatTokenDetail(worker.usage)}>
          {context}
        </span>
      )}
    </span>
  );
}

function WorkerRow({ worker, active, onOpen }: { worker: WorkerEntry; active: boolean; onOpen: () => void }) {
  const meta = usePieceMeta(worker);
  const hint = [worker.title, meta.model, meta.effort, meta.context].filter((line): line is string => line !== null).join("\n");
  const title = cleanPieceTitle(worker.title);
  const busy = isBusy(worker);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-label={worker.title}
      title={hint}
      className={cn(ROW, "items-baseline", active ? ITEM_SELECTED : ITEM_HOVER)}
      onClick={onOpen}
    >
      <span className={cn("min-w-0 truncate text-body leading-5", worker.ended && "opacity-60", busy && "status-shimmer")}>
        {title}
        {busy && <ShimmerOverlay text={title} />}
      </span>
    </button>
  );
}

export const RightRailToggle = memo(function RightRailToggle({
  visible,
  open,
  attention,
  look = NO_LOOK,
  onToggle,
}: {
  visible: boolean;
  open: boolean;
  attention: boolean;
  look?: SlimeLook;
  onToggle: () => void;
}) {
  if (!visible) return null;
  return (
    <Button
      variant="slot"
      size="icon"
      aria-label={open ? "Hide side panel" : attention ? "Show side panel (needs you)" : "Show side panel"}
      aria-expanded={open}
      aria-controls={RIGHT_RAIL_ID}
      className={cn("relative shrink-0", open && "text-foreground")}
      onClick={onToggle}
    >
      <Avatar look={look} size={20} neutral />
      {!open && attention && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
    </Button>
  );
});

const NEVER = () => false;

function useLimited<T>(items: readonly T[], mustShow: (item: T) => boolean) {
  const [expanded, setExpanded] = useState(false);
  const hiddenMustShow = items.slice(RIGHT_RAIL_VISIBLE_ROWS).some(mustShow);
  useEffect(() => {
    if (hiddenMustShow) setExpanded(true);
  }, [hiddenMustShow]);
  const limited = items.length > RIGHT_RAIL_VISIBLE_ROWS;
  return { shown: limited && !expanded ? items.slice(0, RIGHT_RAIL_VISIBLE_ROWS) : items, limited, expanded, toggle: () => setExpanded((v) => !v) };
}

function ShowMore({ limited, expanded, onToggle }: { limited: boolean; expanded: boolean; onToggle: () => void }) {
  if (!limited) return null;
  return (
    <MoreToggle expanded={expanded} onClick={onToggle}>
      {expanded ? "Show less" : "Show more"}
    </MoreToggle>
  );
}

function CompletedGroup({
  workers,
  projectId,
  completedGraphCount,
  activeGraphIdsKey,
  look = NO_LOOK,
  openWorkerId,
  onOpenWorker,
  onZoomGraph,
  onLoadMoreWorkers,
  trailing,
}: {
  workers: WorkerEntry[];
  projectId?: ProjectId | null;
  completedGraphCount?: number;
  activeGraphIdsKey: string;
  look?: SlimeLook;
  openWorkerId: ConversationId | null;
  onOpenWorker: (id: ConversationId) => void;
  onZoomGraph: (graph: TaskGraph) => void;
  onLoadMoreWorkers?: () => Promise<void>;
  trailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [workersMore, setWorkersMore] = useState<{ loading: boolean; error: unknown }>({ loading: false, error: null });
  const loadMore = () => {
    if (historyQuery.hasNextPage && !historyQuery.isFetchingNextPage) void historyQuery.fetchNextPage();
    if (onLoadMoreWorkers === undefined || workersMore.loading) return;
    setWorkersMore({ loading: true, error: null });
    onLoadMoreWorkers().then(
      () => setWorkersMore({ loading: false, error: null }),
      (error: unknown) => setWorkersMore({ loading: false, error }),
    );
  };
  const activeEnded = workers.some((w) => w.conversationId === openWorkerId);
  useEffect(() => {
    if (activeEnded) setOpen(true);
  }, [activeEnded, openWorkerId]);

  const qc = useHubQueryClient();
  const client = useClient();
  const canQueryHistory = projectId !== undefined && projectId !== null;

  const historyQuery = useInfiniteQuery(
    {
      queryKey: ["project-task-graphs", client.device, projectId ?? null, completedGraphCount ?? null, activeGraphIdsKey] as const,
      queryFn: async ({ pageParam }) => {
        const page = await client.fetchProjectTaskGraphs(
          projectId!,
          pageParam !== undefined ? { before: pageParam, limit: GRAPH_HISTORY_PAGE_SIZE } : { limit: GRAPH_HISTORY_PAGE_SIZE },
        );
        return { ...page, graphs: normalizeTaskGraphs(page.graphs) };
      },
      initialPageParam: undefined as TaskGraphId | undefined,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.hasMore && allPages.length < MAX_COMPLETED_GRAPH_PAGES ? lastPage.graphs.at(-1)?.id : undefined,
      maxPages: MAX_COMPLETED_GRAPH_PAGES,
      enabled: open && canQueryHistory,
    },
    qc,
  );

  const completedGraphs = useMemo(
    () => historyQuery.data?.pages.flatMap((page) => page.graphs) ?? [],
    [historyQuery.data],
  );
  const histBoundIds = useMemo(() => boundWorkerIdsOf(completedGraphs), [completedGraphs]);
  const shownWorkers = useMemo(
    () =>
      histBoundIds.size === 0
        ? workers
        : workers.filter(
            (w) => w.conversationId === openWorkerId || !isWorkerBound(w, histBoundIds),
          ),
    [workers, histBoundIds, openWorkerId],
  );

  return (
    <section aria-labelledby="rail-completed" className="tint-fade py-3">
      <GroupTitle id="rail-completed" bodyId="rail-completed-body" collapsed={!open} onToggle={() => setOpen((v) => !v)} trailing={trailing}>
        Completed
      </GroupTitle>
      {open && (
        <GroupBody id="rail-completed-body" collapsed={false}>
          {historyQuery.isLoading && completedGraphs.length === 0 && shownWorkers.length === 0 && (
            <div className="flex items-center gap-2 py-2 text-minor text-muted-foreground">
              <Loader2 className="size-pixel-sm" aria-hidden="true" />
              <span>Loading…</span>
            </div>
          )}
          <ul>
            {completedGraphs.map((graph) => (
              <li key={`graph-${graph.id}`}>
                <button
                  type="button"
                  aria-label={graph.title}
                  title={graph.title}
                  onClick={() => onZoomGraph(graph)}
                  className={cn(ROW, "items-center", ITEM_HOVER)}
                >
                  <TaskProgressIcon graph={graph} color={look.color} size={18} />
                  <span className="min-w-0 flex-1 truncate text-body leading-5 opacity-60">{graph.title}</span>
                </button>
              </li>
            ))}
            {shownWorkers.map((worker) => (
              <li key={worker.conversationId}>
                <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
              </li>
            ))}
          </ul>
          {(historyQuery.error ?? workersMore.error) !== null && (
            <p role="alert" className="py-1 text-xs text-danger">
              {errorText(historyQuery.error ?? workersMore.error).text}
            </p>
          )}
          {(historyQuery.hasNextPage || onLoadMoreWorkers !== undefined) && (
            <MoreToggle expanded={false} onClick={loadMore}>
              {historyQuery.isFetchingNextPage || workersMore.loading ? "Loading…" : "Load more"}
            </MoreToggle>
          )}
        </GroupBody>
      )}
    </section>
  );
}

export function RailGroups({
  asks,
  workers,
  activeGraphs,
  completedGraphCount,
  projectId,
  look = NO_LOOK,
  openWorkerId,
  toggle,
  className,
  onOpenAsk,
  onOpenWorker,
  onLoadMoreWorkers,
  onNeedWorkers,
}: {
  asks: Message[];
  workers: WorkerEntry[];
  activeGraphs?: readonly TaskGraph[];
  completedGraphCount?: number;
  projectId?: ProjectId | null;
  look?: SlimeLook;
  openWorkerId: ConversationId | null;
  toggle?: React.ReactNode;
  className?: string;
  onOpenAsk: (messageId: MessageId) => void;
  onOpenWorker: (conversationId: ConversationId) => void;
  onLoadMoreWorkers?: () => Promise<void>;
  onNeedWorkers?: (workerIds: WorkerId[]) => void;
}) {
  const [zoomedState, setZoomedState] = useState<{ id: TaskGraphId; fallback: TaskGraph } | null>(null);
  // Stable callback keeps the memoized PeelTrackList from rerendering.
  const zoomGraph = useCallback((g: TaskGraph) => setZoomedState({ id: g.id, fallback: g }), []);

  const asksRef = useRef(asks);
  asksRef.current = asks;
  const openStepAsk = useCallback(
    (graph: TaskGraph, node: TaskNode) => {
      const ask = asksRef.current.find((m) => {
        const meta = askOf(m);
        if (node.userBlocker != null) return meta?.blockerRef?.blockerId === node.userBlocker.id;
        return m.id === node.gateAskMessageId || (meta?.gateRef?.graphId === graph.id && meta.gateRef.nodeKey === node.key);
      });
      if (ask !== undefined) onOpenAsk(ask.id);
      else zoomGraph(graph);
    },
    [onOpenAsk, zoomGraph],
  );

  const visibleAsks = useMemo(() => {
    const gateMsgIds = new Set<MessageId>();
    const stepBlockerIds = new Set<UserBlockerId>();
    for (const graph of activeGraphs ?? []) {
      for (const node of graph.nodes) {
        if (node.gateAskMessageId !== null) gateMsgIds.add(node.gateAskMessageId);
        if (node.userBlocker !== null && node.userBlocker !== undefined) stepBlockerIds.add(node.userBlocker.id);
      }
    }
    return asks.filter((ask) => {
      const meta = askOf(ask);
      if (meta?.gateRef !== undefined || gateMsgIds.has(ask.id)) return false;
      return meta?.blockerRef === undefined || !stepBlockerIds.has(meta.blockerRef.blockerId);
    });
  }, [asks, activeGraphs]);

  const activeBoundIds = useMemo(
    () => (activeGraphs && activeGraphs.length > 0 ? boundWorkerIdsOf(activeGraphs) : null),
    [activeGraphs],
  );
  const unboundWorkers = useMemo(
    () =>
      activeBoundIds === null || activeBoundIds.size === 0
        ? workers
        : workers.filter((w) => !isWorkerBound(w, activeBoundIds)),
    [workers, activeBoundIds],
  );

  const live = useMemo(
    () => unboundWorkers.filter((w) => !w.ended).toSorted((a, b) => Number(isBusy(b)) - Number(isBusy(a))),
    [unboundWorkers],
  );
  const ended = useMemo(() => unboundWorkers.filter((w) => w.ended), [unboundWorkers]);
  const shownAsks = useLimited(visibleAsks, NEVER);
  const shownLive = useLimited(live, (w) => w.conversationId === openWorkerId);
  const groups = useCollapsedGroups();

  const hasAsks = visibleAsks.length > 0;
  const hasGraphs = (activeGraphs?.length ?? 0) > 0;
  const hasLive = live.length > 0;
  const hasCompleted = ended.length > 0 || (completedGraphCount ?? 0) > 0;
  const graphNeedsYou = useMemo(
    () => activeGraphs?.some((g) => g.nodes.some(isTaskNodeWaitingUser)) ?? false,
    [activeGraphs],
  );

  const zoomedGraph = useMemo(() => {
    if (zoomedState === null) return null;
    return activeGraphs?.find((g) => g.id === zoomedState.id) ?? zoomedState.fallback;
  }, [zoomedState, activeGraphs]);
  useEffect(() => {
    if (zoomedGraph === null || onNeedWorkers === undefined) return;
    const have = workersByWorkerId(workers);
    const missing = [...boundWorkerIdsOf([zoomedGraph])].filter((id) => !have.has(id));
    if (missing.length > 0) onNeedWorkers(missing);
  }, [zoomedGraph, workers, onNeedWorkers]);

  return (
    <>
      <div className={cn("right-rail-scroll min-h-0 flex-1 divide-y divide-line overflow-x-hidden overflow-y-auto overscroll-y-contain px-5", className)}>
        {hasAsks && (
          <section aria-labelledby="rail-asks" className="tint-fade py-3">
            <GroupTitle
              id="rail-asks"
              bodyId="rail-asks-body"
              collapsed={groups.collapsed.asks === true}
              onToggle={() => groups.toggle("asks")}
              dot
              trailing={toggle}
            >
              {NEEDS_YOU}
            </GroupTitle>
            <GroupBody id="rail-asks-body" collapsed={groups.collapsed.asks === true}>
              <ul>
                {shownAsks.shown.map((ask) => (
                  <AskRow key={ask.id} ask={ask} onOpen={() => onOpenAsk(ask.id)} />
                ))}
              </ul>
              <ShowMore limited={shownAsks.limited} expanded={shownAsks.expanded} onToggle={shownAsks.toggle} />
            </GroupBody>
          </section>
        )}
        {hasGraphs && activeGraphs !== undefined && (
          <section aria-labelledby="rail-graphs" className="tint-fade py-3">
            <GroupTitle
              id="rail-graphs"
              bodyId="rail-graphs-body"
              collapsed={groups.collapsed.graphs === true}
              onToggle={() => groups.toggle("graphs")}
              dot={graphNeedsYou}
              trailing={!hasAsks ? toggle : undefined}
            >
              Task Graph
            </GroupTitle>
            <GroupBody id="rail-graphs-body" collapsed={groups.collapsed.graphs === true}>
              <PeelTrackList
                graphs={activeGraphs}
                workers={workers}
                openWorkerId={openWorkerId}
                color={look.color}
                onOpenWorker={onOpenWorker}
                onZoomGraph={zoomGraph}
                onOpenStepAsk={openStepAsk}
              />
            </GroupBody>
          </section>
        )}
        {hasLive && (
          <section aria-labelledby="rail-workers" className="tint-fade py-3">
            <GroupTitle
              id="rail-workers"
              bodyId="rail-workers-body"
              collapsed={groups.collapsed.workers === true}
              onToggle={() => groups.toggle("workers")}
              trailing={!hasAsks && !hasGraphs ? toggle : undefined}
            >
              Pieces
            </GroupTitle>
            <GroupBody id="rail-workers-body" collapsed={groups.collapsed.workers === true}>
              <ul>
                {shownLive.shown.map((worker) => (
                  <li key={worker.conversationId}>
                    <WorkerRow worker={worker} active={worker.conversationId === openWorkerId} onOpen={() => onOpenWorker(worker.conversationId)} />
                  </li>
                ))}
              </ul>
              <ShowMore limited={shownLive.limited} expanded={shownLive.expanded} onToggle={shownLive.toggle} />
            </GroupBody>
          </section>
        )}
        {hasCompleted && (
          <CompletedGroup
            workers={ended}
            projectId={projectId}
            completedGraphCount={completedGraphCount}
            activeGraphIdsKey={(activeGraphs ?? []).map((g) => g.id).join(",")}
            look={look}
            openWorkerId={openWorkerId}
            onOpenWorker={onOpenWorker}
            onZoomGraph={zoomGraph}
            {...(onLoadMoreWorkers !== undefined ? { onLoadMoreWorkers } : {})}
            trailing={!hasAsks && !hasGraphs && !hasLive ? toggle : undefined}
          />
        )}
      </div>
      {zoomedGraph !== null && (
        <TaskGraphDialog
          graph={zoomedGraph}
          open
          onOpenChange={(open) => {
            if (!open) setZoomedState(null);
          }}
          workers={workers}
          color={look.color}
          onOpenWorker={onOpenWorker}
        />
      )}
    </>
  );
}

export const RightRail = memo(function RightRail({
  asks,
  workers,
  activeGraphs,
  completedGraphCount,
  projectId,
  openWorkerId,
  layout,
  toggle,
  look = NO_LOOK,
  onOpenAsk,
  onOpenWorker,
  onLoadMoreWorkers,
  onNeedWorkers,
}: {
  asks: Message[];
  workers: WorkerEntry[];
  activeGraphs?: readonly TaskGraph[];
  completedGraphCount?: number;
  projectId?: ProjectId | null;
  openWorkerId: ConversationId | null;
  onLoadMoreWorkers?: () => Promise<void>;
  onNeedWorkers?: (workerIds: WorkerId[]) => void;
  layout: "side" | "top";
  toggle?: React.ReactNode;
  look?: SlimeLook;
  onOpenAsk: (messageId: MessageId) => void;
  onOpenWorker: (conversationId: ConversationId) => void;
}) {
  const side = layout === "side";
  return (
    <aside
      id={RIGHT_RAIL_ID}
      aria-label="Side panel"
      className={cn(
        "tint-fade flex min-w-0 shrink-0 flex-col overflow-hidden bg-surface-chat [contain:layout_style]",
        side ? "w-80 border-l border-line" : "max-h-[40dvh] border-b border-line",
      )}
    >
      <RailGroups
        asks={asks}
        workers={workers}
        activeGraphs={activeGraphs}
        completedGraphCount={completedGraphCount}
        projectId={projectId}
        look={look}
        openWorkerId={openWorkerId}
        toggle={side ? toggle : undefined}
        className={side ? "pb-4" : "py-1"}
        onOpenAsk={onOpenAsk}
        onOpenWorker={onOpenWorker}
        {...(onLoadMoreWorkers !== undefined ? { onLoadMoreWorkers } : {})}
        {...(onNeedWorkers !== undefined ? { onNeedWorkers } : {})}
      />
    </aside>
  );
});
