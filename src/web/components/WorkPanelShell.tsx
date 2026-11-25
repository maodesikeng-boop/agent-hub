import { useCallback, useMemo } from "react";
import type * as React from "react";
import { DEFAULT_AGENT_VENDOR, isAgentVendor, type Pm, type SessionState } from "../../shared/index.ts";
import { isReadOnly, routeDeviceOf } from "../devices.ts";
import { infoPageTitle } from "../info-rows.ts";
import { useModelCatalog } from "../models.tsx";
import { isRenewing, pendingOf, sessionOf, workerOutcomesOf, workerPhaseOf, type WorkerEntry } from "../selectors.ts";
import type { useShellModel } from "../shell-model.ts";
import { workPanelExitsOf, type WorkPanelContent } from "../side-panel.ts";
import { useCompletedWork } from "../useCompletedWork.ts";
import { activeWorkOf, type WorkPanelTab } from "../work-panel-model.ts";
import { workerWorkStatusOf } from "../work-status.ts";
import { InfoTab } from "./InfoTab.tsx";
import { WorkerConversation } from "./WorkerConversation.tsx";
import { WorkerDetailHeader, workerMenuFactsOf } from "./WorkerDetail.tsx";
import { WorkPanel, WorkPanelDetailHeader, WorkPanelHeader, WorkPanelTabsSheet, finishSignalOf } from "./WorkPanel.tsx";

export type ShellModel = ReturnType<typeof useShellModel>;
export type ShellContent = NonNullable<ShellModel["content"]>;

export function WorkerPane({
  model: { state, hub },
  content: c,
  mobile,
  top,
  notices,
  workerId,
}: {
  model: ShellModel;
  content: ShellContent;
  mobile: boolean;
  top?: React.ReactNode;
  notices: React.ReactNode;
  workerId: number;
}) {
  return (
    <WorkerConversation
      mobile={mobile}
      key={c.keyOf(workerId)}
      title={c.workerLine?.title ?? c.workerView?.conversation.title ?? "Worker"}
      phase={workerPhaseOf(state, workerId)}
      pm={{ name: c.workerPmEntry?.name ?? "Project manager", look: c.workerPmEntry?.look ?? c.look }}
      outcomes={workerOutcomesOf(state, workerId)}
      view={c.workerView}
      loading={c.workerLoading}
      pending={pendingOf(state, workerId)}
      session={sessionOf(state, workerId)}
      older={state.older[workerId]}
      draft={c.drafts.of(c.keyOf(workerId))}
      staging={c.staging.of(c.keyOf(workerId))}
      top={top}
      notices={notices}
      onSend={c.send}
      onRetry={hub.retrySend}
      onStop={hub.stop}
      onRewind={hub.rewind}
      onLoadOlder={c.handleLoadOlder}
      actions={c.actions}
      link={c.link}
    />
  );
}

export function WorkerHeaderSlot({
  title,
  meta,
  session,
  ended,
  createdAt,
  endedAt,
  branch,
  workerReadonly,
  readOnly,
  backLabel,
  onBack,
  onClose,
  onStop,
  onEnd,
}: {
  title: string;
  meta: WorkerEntry | undefined;
  session: SessionState | null;
  ended: boolean;
  createdAt: number | null;
  endedAt: number | null;
  branch: string | null;
  workerReadonly?: boolean;
  readOnly: boolean;
  backLabel: string;
  onBack: () => void;
  onClose?: () => void;
  onStop: () => void;
  onEnd: () => void;
}) {
  const rawVendor = meta?.vendor ?? session?.vendor;
  const knownVendor = isAgentVendor(rawVendor);
  const catalog = useModelCatalog(knownVendor ? rawVendor : DEFAULT_AGENT_VENDOR);
  const status = meta !== undefined ? workerWorkStatusOf(meta) : ended ? "done" : "running";
  const running = !ended && !readOnly && (session?.status === "running" || session?.activity === "working" || session?.activity === "preparing");
  const facts = workerMenuFactsOf({
    worker: meta,
    session,
    createdAt,
    endedAt,
    branch,
    readonly: workerReadonly,
    catalog: knownVendor ? catalog : null,
    now: Date.now(),
  });
  return (
    <WorkerDetailHeader
      title={title}
      status={status}
      facts={facts}
      onStop={running ? onStop : null}
      onEnd={!ended && !readOnly ? onEnd : null}
      backLabel={backLabel}
      onBack={onBack}
      {...(onClose !== undefined ? { onClose } : {})}
    />
  );
}

function renderInfoTab(model: ShellModel, c: ShellContent, pm: Pm, onArchived: () => void) {
  const { state, current } = model;
  const entry = c.profileEntry;
  return (
    <InfoTab
      key={c.keyOf(pm.id)}
      pm={pm}
      project={entry?.project ?? null}
      folders={entry?.folders ?? []}
      schedules={state.schedules.filter((x) => x.pmId === pm.id)}
      rev={state.personaRev[pm.id] ?? 0}
      renewing={entry !== undefined && isRenewing(state, entry.id)}
      page={c.profilePage}
      readOnly={isReadOnly(current.status)}
      onNavigate={(page) => c.openProfile(pm.id, page ?? undefined)}
      onArchived={onArchived}
      onManageProviders={() => c.openManageProviders(current.key)}
      onEditDefaults={() => c.openSettingsSection("capabilities")}
    />
  );
}

export function DesktopWorkPanel({
  model,
  content: c,
  panelContent,
  layout,
  notices,
}: {
  model: ShellModel;
  content: ShellContent;
  panelContent: WorkPanelContent;
  layout: "side" | "stack";
  notices: React.ReactNode;
}) {
  const { navigate, current, route, state, hub } = model;
  const pmId = c.active?.pm?.id ?? c.profile?.id ?? null;
  const activeWork = useMemo(() => activeWorkOf(c.railGraphs, c.railWorkers), [c.railGraphs, c.railWorkers]);
  const finishSignal = useMemo(() => finishSignalOf(c.railGraphs, c.railWorkers), [c.railGraphs, c.railWorkers]);
  const infoSummaryCompleted = useCompletedWork(pmId, panelContent.kind === "info" && panelContent.page === null, finishSignal);

  const convRoute = useMemo(
    () => (c.active ? { view: "conversation" as const, id: c.active.id, ...routeDeviceOf(current.key) } : null),
    [c.active, current.key],
  );
  const exits = useMemo(
    () => (convRoute ? workPanelExitsOf(panelContent, convRoute) : { close: { view: "conversation" as const, id: 1 }, back: null }),
    [panelContent, convRoute],
  );

  const closePanel = useCallback(() => {
    c.toggleRail(false);
    if (route?.view !== "conversation") {
      if (convRoute) navigate(exits.close);
      else c.routerSummary.onSelect();
    }
  }, [c, route?.view, convRoute, navigate, exits.close]);

  const selectTab = useCallback(
    (next: WorkPanelTab) => {
      if (next === "info") {
        if (pmId !== null) c.openProfile(pmId);
        return;
      }
      c.setWorkTab(next);
      c.toggleRail(true);
      if (route?.view !== "conversation" && convRoute !== null) navigate(convRoute);
    },
    [c, pmId, route?.view, convRoute, navigate],
  );

  if (panelContent.kind === "tab") {
    return (
      <WorkPanelTabsSheet
        layout={layout}
        tab={panelContent.tab}
        pmId={pmId}
        graphs={c.railGraphs}
        workers={c.railWorkers}
        asks={c.railAsks}
        look={c.look}
        onSelectTab={selectTab}
        onClose={closePanel}
        onOpenWorker={c.openWorkerConversation}
        onOpenAsk={c.openAsk}
        onNeedWorkers={c.ensureWorkers}
      />
    );
  }

  if (panelContent.kind === "worker") {
    const workerId = panelContent.workerId;
    const meta = c.railWorkers.find((w) => w.conversationId === workerId);
    const session = sessionOf(state, workerId);
    const title = c.workerLine?.title ?? c.workerView?.conversation.title ?? "Worker";
    const ended = workerPhaseOf(state, workerId) === "ended";
    const branch = c.workerView?.workerBranch ?? meta?.branch ?? c.workerLine?.branch ?? null;
    return (
      <WorkPanel
        layout={layout}
        label={title}
        header={
          <WorkerHeaderSlot
            title={title}
            meta={meta}
            session={session}
            ended={ended}
            createdAt={c.workerView?.conversation.createdAt ?? null}
            endedAt={c.workerView?.workerLine?.endedAt ?? null}
            branch={branch}
            workerReadonly={c.workerLine?.readonly ?? false}
            readOnly={isReadOnly(current.status)}
            backLabel={c.workerPmEntry ? `Back to ${c.workerPmEntry.name}` : "Back"}
            onBack={() => {
              c.toggleRail(true);
              if (exits.back) navigate(exits.back);
            }}
            onClose={closePanel}
            onStop={() => void hub.stop(workerId)}
            onEnd={() => void hub.client.postEndWorker(workerId).catch(() => {})}
          />
        }
      >
        <WorkerPane model={model} content={c} mobile={false} notices={notices} workerId={workerId} />
      </WorkPanel>
    );
  }

  const profile = c.profile;
  if (!profile) return null;
  const header =
    panelContent.page !== null ? (
      <WorkPanelDetailHeader
        title={<h1 className="truncate px-1 text-minor font-semibold text-foreground">{infoPageTitle(panelContent.page)}</h1>}
        backLabel="Back to Info"
        onBack={() => {
          if (exits.back) navigate(exits.back);
        }}
        onClose={closePanel}
      />
    ) : (
      <WorkPanelHeader
        tab="info"
        activeCount={activeWork.count}
        completedCount={infoSummaryCompleted.total}
        onSelectTab={selectTab}
        onClose={closePanel}
      />
    );
  return (
    <WorkPanel layout={layout} label={panelContent.page !== null ? infoPageTitle(panelContent.page) : `${profile.name}'s settings`} header={header}>
      {renderInfoTab(model, c, profile, closePanel)}
    </WorkPanel>
  );
}

export function MobileInfoPanel({
  model,
  content: c,
  pm,
  onBack,
  onSwitchTab,
}: {
  model: ShellModel;
  content: ShellContent;
  pm: Pm;
  onBack: () => void;
  onSwitchTab: (tab: Exclude<WorkPanelTab, "info">) => void;
}) {
  const activeWork = useMemo(() => activeWorkOf(c.railGraphs, c.railWorkers), [c.railGraphs, c.railWorkers]);
  const finishSignal = useMemo(() => finishSignalOf(c.railGraphs, c.railWorkers), [c.railGraphs, c.railWorkers]);
  const completed = useCompletedWork(pm.id, c.profilePage === null, finishSignal);
  const selectTab = useCallback(
    (next: WorkPanelTab) => {
      if (next === "info") return;
      onSwitchTab(next);
    },
    [onSwitchTab],
  );
  const header =
    c.profilePage !== null ? (
      <WorkPanelDetailHeader
        title={<h1 className="truncate px-1 text-minor font-semibold text-foreground">{infoPageTitle(c.profilePage)}</h1>}
        backLabel="Back to Info"
        onBack={() => c.openProfile(pm.id)}
      />
    ) : (
      <WorkPanelHeader
        tab="info"
        activeCount={activeWork.count}
        completedCount={completed.total}
        onSelectTab={selectTab}
        onClose={onBack}
        onBack={onBack}
        backLabel="Back to conversation"
      />
    );
  return (
    <WorkPanel layout="page" label={c.profilePage !== null ? infoPageTitle(c.profilePage) : `${pm.name}'s settings`} header={header}>
      {renderInfoTab(model, c, pm, onBack)}
    </WorkPanel>
  );
}

export function MobileWorkPanel({ content: c, onClose }: { content: ShellContent; onClose: () => void }) {
  const pmId = c.active?.pm?.id ?? null;
  const { openProfile, setWorkTab, openAsk } = c;
  const selectTab = useCallback(
    (next: WorkPanelTab) => {
      if (next === "info") {
        if (pmId !== null) openProfile(pmId);
        return;
      }
      setWorkTab(next);
    },
    [openProfile, setWorkTab, pmId],
  );
  const openAskAndClose = useCallback(
    (id: number) => {
      onClose();
      openAsk(id);
    },
    [openAsk, onClose],
  );
  return (
    <WorkPanelTabsSheet
      layout="page"
      tab={c.workTab}
      pmId={pmId}
      graphs={c.railGraphs}
      workers={c.railWorkers}
      asks={c.railAsks}
      look={c.look}
      onSelectTab={selectTab}
      onClose={onClose}
      onBack={onClose}
      backLabel="Back to conversation"
      onOpenWorker={c.openWorkerConversation}
      onOpenAsk={openAskAndClose}
      onNeedWorkers={c.ensureWorkers}
    />
  );
}
