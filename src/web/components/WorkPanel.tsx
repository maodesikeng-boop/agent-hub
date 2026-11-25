import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import type { ConversationId, Message, MessageId, PmId, TaskGraph, TaskGraphId, TaskNodeKey, WorkerId } from "../../shared/index.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { boundWorkerIdsOf, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { ArrowLeft, X } from "../ui/icons.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { useCompletedWork } from "../useCompletedWork.ts";
import { activeWorkOf, type WorkPanelTab } from "../work-panel-model.ts";
import { ActiveTab } from "./ActiveTab.tsx";
import { Avatar } from "./Avatar.tsx";
import { CompletedTab } from "./CompletedTab.tsx";
import { TaskGraphDialog } from "./TaskGraphDialog.tsx";

export interface WorkPanelHeaderProps {
  activeCount: number;
  /** null hides the count while the first Completed page loads. */
  completedCount: number | null;
  onClose: () => void;
  /** Shown on phone full-page panels in place of Close. */
  onBack?: () => void;
  backLabel?: string;
}

export function WorkPanelHeader({
  activeCount,
  completedCount,
  onClose,
  onBack,
  backLabel = "Back",
}: WorkPanelHeaderProps): React.ReactElement {
  return (
    <header
      data-window-drag
      className={cn("work-panel-header flex h-11 shrink-0 items-center justify-between gap-2", onBack !== undefined ? "pl-3 pr-3" : "pl-5 pr-3")}
    >
      <div className="flex h-full min-w-0 items-center gap-2">
        {onBack !== undefined && (
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={backLabel} title={backLabel} onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        )}
        <TabsList aria-label="Work panel tabs" className="flex h-full items-stretch gap-5">
          <TabsTrigger value="active" aria-label={`Active ${activeCount}`} className="work-panel-tab touch-target">
            <span>Active</span>
            <span className="work-panel-tab-count tabular-nums">{activeCount}</span>
          </TabsTrigger>
          <TabsTrigger value="completed" aria-label={completedCount === null ? "Completed" : `Completed ${completedCount}`} className="work-panel-tab touch-target">
            <span>Completed</span>
            {completedCount !== null && <span className="work-panel-tab-count tabular-nums">{completedCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="info" className="work-panel-tab touch-target">
            <span>Info</span>
          </TabsTrigger>
        </TabsList>
      </div>
      {onBack === undefined && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="work-panel-close shrink-0"
          aria-label="Close work panel"
          title="Close work panel"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}

export interface WorkPanelDetailHeaderProps {
  title: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  /** Omitted on full-screen phone pages where Back is the sole exit. */
  onClose?: () => void;
  /** Extra controls before Close, such as the Worker `⋯` menu. */
  actions?: React.ReactNode;
}

export function WorkPanelDetailHeader({
  title,
  backLabel,
  onBack,
  onClose,
  actions,
}: WorkPanelDetailHeaderProps): React.ReactElement {
  return (
    <header data-window-drag className="work-panel-header flex h-11 shrink-0 items-center gap-2 px-3">
      <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={backLabel} title={backLabel} onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
      </Button>
      <div className="min-w-0 flex-1">{title}</div>
      {actions}
      {onClose !== undefined && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="work-panel-close shrink-0"
          aria-label="Close work panel"
          title="Close work panel"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}

export interface WorkPanelProps {
  /** side: beside the conversation; stack: covering it in the narrowest desktop tier; page: a full phone page. */
  layout: "side" | "stack" | "page";
  label: string;
  header: React.ReactNode;
  children: React.ReactNode;
  tabs?: { value: WorkPanelTab; onSelect: (tab: WorkPanelTab) => void };
}

export function WorkPanel({ layout, label, header, children, tabs }: WorkPanelProps): React.ReactElement {
  const panel = (
    <aside
      aria-label={label}
      data-layout={layout}
      className="work-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </aside>
  );
  return tabs === undefined ? panel : (
    <Tabs asChild value={tabs.value} onValueChange={(value) => {
      if (value === "active" || value === "completed" || value === "info") tabs.onSelect(value);
    }}>
      {panel}
    </Tabs>
  );
}

export function WorkPanelToggle({
  open,
  attention,
  look,
  onToggle,
}: {
  open: boolean;
  attention: boolean;
  look: SlimeLook;
  onToggle: () => void;
}): React.ReactElement {
  const label = open ? "Hide work panel" : attention ? "Show work panel (needs you)" : "Show work panel";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
      className="relative shrink-0"
    >
      <Avatar look={look} size={22} neutral />
      {attention && !open && (
        <span
          aria-hidden="true"
          data-testid="work-panel-attention"
          className="absolute top-0.5 right-0.5 size-2 rounded-full bg-status-active shadow-[0_0_0_2px_var(--background)]"
        />
      )}
    </Button>
  );
}

export function WorkPanelTabsSheet({
  layout,
  tab,
  pmId,
  graphs,
  workers,
  asks,
  look,
  onSelectTab,
  onClose,
  onBack,
  backLabel,
  onOpenWorker,
  onOpenAsk,
  onNeedWorkers,
  onExpand,
  subscribeTaskGraphs,
  info,
}: {
  layout: "side" | "stack" | "page";
  tab: WorkPanelTab;
  pmId: PmId | null;
  graphs: readonly TaskGraph[];
  workers: readonly WorkerEntry[];
  asks?: readonly Message[];
  look: SlimeLook;
  onSelectTab: (tab: WorkPanelTab) => void;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  onOpenWorker: (id: ConversationId) => void;
  onOpenAsk: (id: MessageId) => void;
  onNeedWorkers: (ids: WorkerId[]) => void;
  onExpand?: () => void;
  subscribeTaskGraphs: (listener: (graph: TaskGraph) => void) => () => void;
  info?: { label: string; body: React.ReactNode; detailHeader?: React.ReactNode } | undefined;
}): React.ReactElement {
  const activeWork = useMemo(() => activeWorkOf(graphs, workers), [graphs, workers]);
  const completedQuery = useCompletedWork(pmId, info?.detailHeader === undefined);
  const [zoomed, setZoomed] = useState<{ id: TaskGraphId; title: string; terminal: TaskGraph | null; decisionKey?: TaskNodeKey } | null>(null);
  const expandGraph = useCallback((graph: TaskGraph, decisionKey?: TaskNodeKey) => {
    onExpand?.();
    setZoomed({ id: graph.id, title: graph.title, terminal: null, ...(decisionKey !== undefined ? { decisionKey } : {}) });
  }, [onExpand]);
  useEffect(() => subscribeTaskGraphs((graph) => {
    setZoomed((current) => current?.id === graph.id
      ? { ...current, terminal: graph.status === "active" ? null : graph }
      : current);
  }), [subscribeTaskGraphs]);
  const zoomedGraph = zoomed === null ? null : graphs.find((g) => g.id === zoomed.id) ?? zoomed.terminal;
  const dismissedGraph = zoomedGraph === null ? zoomed : null;
  const outcome = dismissedGraph === null ? undefined : completedQuery.days
    .flatMap((day) => day.items)
    .find((item) => item.kind === "graph" && item.graphId === dismissedGraph.id)?.outcome;
  const closeDialog = (open: boolean) => {
    if (!open) setZoomed(null);
  };
  useEffect(() => {
    if (zoomedGraph === null) return;
    const have = workersByWorkerId(workers);
    const missing = [...boundWorkerIdsOf([zoomedGraph])].filter((id) => !have.has(id));
    if (missing.length > 0) onNeedWorkers(missing);
  }, [zoomedGraph, workers, onNeedWorkers]);

  const infoDetail = info?.detailHeader !== undefined;
  const header = info?.detailHeader ?? (
    <WorkPanelHeader
      activeCount={activeWork.count}
      completedCount={completedQuery.total}
      onClose={onClose}
      {...(onBack !== undefined ? { onBack } : {})}
      {...(backLabel !== undefined ? { backLabel } : {})}
    />
  );

  return (
    <>
      <WorkPanel
        layout={layout}
        label={info?.label ?? "Work panel"}
        header={header}
        tabs={{ value: tab, onSelect: onSelectTab }}
      >
        <TabsContent value="active" className="min-h-0 flex-1 flex-col data-[state=active]:flex">
          <ActiveTab
            work={activeWork}
            workers={workers}
            {...(asks !== undefined ? { asks } : {})}
            onOpenWorker={onOpenWorker}
            onOpenAsk={onOpenAsk}
            onExpandGraph={expandGraph}
          />
        </TabsContent>
        <TabsContent value="completed" className="min-h-0 flex-1 flex-col data-[state=active]:flex">
          <CompletedTab query={completedQuery} onOpenWorker={onOpenWorker} />
        </TabsContent>
        <TabsContent
          value="info"
          className="min-h-0 flex-1 flex-col data-[state=active]:flex"
          {...(infoDetail && { role: "presentation", "aria-labelledby": undefined, tabIndex: undefined })}
        >
          {info?.body}
        </TabsContent>
      </WorkPanel>
      {zoomed !== null && (
        <TaskGraphDialog
          graph={zoomedGraph}
          open
          onOpenChange={closeDialog}
          workers={workers}
          color={look.color}
          onOpenWorker={onOpenWorker}
          decisionKey={zoomed.decisionKey}
          terminal={dismissedGraph === null ? undefined : { title: dismissedGraph.title, outcome }}
        />
      )}
    </>
  );
}
