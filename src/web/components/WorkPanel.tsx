import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import type { ConversationId, Message, MessageId, PmId, TaskGraph, TaskGraphId, WorkerId } from "../../shared/index.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import { cn } from "../lib/utils.ts";
import { boundWorkerIdsOf, workersByWorkerId, type WorkerEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { ArrowLeft, X } from "../ui/icons.ts";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { useCompletedWork } from "../useCompletedWork.ts";
import { activeWorkOf, type WorkPanelTab } from "../work-panel-model.ts";
import { ActiveTab } from "./ActiveTab.tsx";
import { Avatar } from "./Avatar.tsx";
import { CompletedTab } from "./CompletedTab.tsx";
import { TaskGraphDialog } from "./TaskGraphDialog.tsx";

export interface WorkPanelHeaderProps {
  tab: WorkPanelTab;
  activeCount: number;
  /** null hides the count while the first Completed page loads. */
  completedCount: number | null;
  onSelectTab: (tab: WorkPanelTab) => void;
  onClose: () => void;
  /** Shown on phone full-page panels in place of Close. */
  onBack?: () => void;
  backLabel?: string;
}

export function WorkPanelHeader({
  tab,
  activeCount,
  completedCount,
  onSelectTab,
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
        <Tabs value={tab} onValueChange={(next) => onSelectTab(next as WorkPanelTab)} className="h-full">
          <TabsList aria-label="Work panel tabs" className="flex h-full items-stretch gap-5">
            <TabsTrigger value="active" className="work-panel-tab touch-target">
              <span>Active</span>
              <span className="work-panel-tab-count tabular-nums">{activeCount}</span>
            </TabsTrigger>
            <TabsTrigger value="completed" className="work-panel-tab touch-target">
              <span>Completed</span>
              {completedCount !== null && <span className="work-panel-tab-count tabular-nums">{completedCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="info" className="work-panel-tab touch-target">
              <span>Info</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
}

export function WorkPanel({ layout, label, header, children }: WorkPanelProps): React.ReactElement {
  return (
    <aside
      aria-label={label}
      data-layout={layout}
      className="work-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </aside>
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

export function finishSignalOf(graphs: readonly TaskGraph[], workers: readonly WorkerEntry[]): string {
  const graphIds = graphs.map((g) => g.id).join(",");
  const endedIds = workers.filter((w) => w.ended).map((w) => w.conversationId).join(",");
  return `${graphIds}|${endedIds}`;
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
}: {
  layout: "side" | "stack" | "page";
  tab: Exclude<WorkPanelTab, "info">;
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
}): React.ReactElement {
  const activeWork = useMemo(() => activeWorkOf(graphs, workers), [graphs, workers]);
  const finishSignal = useMemo(() => finishSignalOf(graphs, workers), [graphs, workers]);
  const completedQuery = useCompletedWork(pmId, true, finishSignal);
  const [zoomedState, setZoomedState] = useState<{ id: TaskGraphId; fallback: TaskGraph } | null>(null);
  const expandGraph = useCallback((g: TaskGraph) => setZoomedState({ id: g.id, fallback: g }), []);
  const zoomedGraph = useMemo(
    () => (zoomedState === null ? null : (graphs.find((g) => g.id === zoomedState.id) ?? zoomedState.fallback)),
    [zoomedState, graphs],
  );
  useEffect(() => {
    if (zoomedGraph === null) return;
    const have = workersByWorkerId(workers);
    const missing = [...boundWorkerIdsOf([zoomedGraph])].filter((id) => !have.has(id));
    if (missing.length > 0) onNeedWorkers(missing);
  }, [zoomedGraph, workers, onNeedWorkers]);

  return (
    <>
      <WorkPanel
        layout={layout}
        label="Work panel"
        header={
          <WorkPanelHeader
            tab={tab}
            activeCount={activeWork.count}
            completedCount={completedQuery.total}
            onSelectTab={onSelectTab}
            onClose={onClose}
            {...(onBack !== undefined ? { onBack } : {})}
            {...(backLabel !== undefined ? { backLabel } : {})}
          />
        }
      >
        {tab === "active" ? (
          <ActiveTab
            work={activeWork}
            workers={workers}
            {...(asks !== undefined ? { asks } : {})}
            onOpenWorker={onOpenWorker}
            onOpenAsk={onOpenAsk}
            onExpandGraph={expandGraph}
          />
        ) : (
          <CompletedTab query={completedQuery} onOpenWorker={onOpenWorker} />
        )}
      </WorkPanel>
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
