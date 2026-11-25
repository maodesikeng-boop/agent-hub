import { useCallback, useMemo } from "react";
import type * as React from "react";
import { DEFAULT_AGENT_VENDOR, isAgentVendor, type Pm, type SessionState } from "../../shared/index.ts";
import { isReadOnly, routeDeviceOf } from "../devices.ts";
import { infoPageTitle } from "../info-rows.ts";
import { useModelCatalog } from "../models.tsx";
import { isRenewing, pendingOf, sessionOf, workerOutcomesOf, workerPhaseOf, type WorkerEntry } from "../selectors.ts";
import type { useShellModel } from "../shell-model.ts";
import { workPanelExitsOf, type WorkPanelContent } from "../side-panel.ts";
import type { WorkPanelTab } from "../work-panel-model.ts";
import { workerWorkStatusOf } from "../work-status.ts";
import { InfoTab } from "./InfoTab.tsx";
import { WorkerConversation } from "./WorkerConversation.tsx";
import { WorkerDetailHeader, workerMenuFactsOf } from "./WorkerDetail.tsx";
import { WorkPanel, WorkPanelDetailHeader, WorkPanelTabsSheet } from "./WorkPanel.tsx";

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
      onTogglePin={(pinned) => c.togglePin(pm.id, pinned)}
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
  const { openAsk: focusAsk, toggleRail } = c;
  const pmId = c.active?.pm?.id ?? c.profile?.id ?? null;
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

  const openAsk = useCallback((id: number) => {
    if (layout === "stack") toggleRail(false);
    focusAsk(id);
  }, [layout, toggleRail, focusAsk]);
  const keepPanelOpen = useCallback(() => toggleRail(true), [toggleRail]);

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

  const profile = panelContent.kind === "info" ? c.profile : null;
  const page = panelContent.kind === "info" && !(profile?.archivedAt != null && panelContent.page === "capabilities") ? panelContent.page : null;
  const info = profile === null ? undefined : {
    label: `${profile.name}'s settings`,
    body: renderInfoTab(model, c, profile, closePanel),
    detailHeader: page === null ? undefined : (
      <WorkPanelDetailHeader
        title={<h1 className="truncate px-1 text-minor font-semibold text-foreground">{infoPageTitle(page)}</h1>}
        backLabel="Back to Info"
        onBack={() => {
          if (exits.back) navigate(exits.back);
        }}
        onClose={closePanel}
      />
    ),
  };
  return (
    <WorkPanelTabsSheet
      key={`${current.key}:${pmId}`}
      layout={layout}
      tab={panelContent.kind === "tab" ? panelContent.tab : "info"}
      pmId={pmId}
      graphs={c.railGraphs}
      workers={c.railWorkers}
      asks={c.railAsks}
      look={c.look}
      onSelectTab={selectTab}
      onClose={closePanel}
      onOpenWorker={c.openWorkerConversation}
      onOpenAsk={openAsk}
      onNeedWorkers={c.ensureWorkers}
      onExpand={keepPanelOpen}
      subscribeTaskGraphs={hub.subscribeTaskGraphs}
      info={info}
    />
  );
}

export function MobileWorkPanel({
  model,
  content: c,
  profile: pm,
  onBack,
  onClose,
  onSwitchTab,
}: {
  model: ShellModel;
  content: ShellContent;
  profile: Pm | null;
  onBack: () => void;
  onClose: () => void;
  onSwitchTab: (tab: Exclude<WorkPanelTab, "info">) => void;
}) {
  const pmId = pm?.id ?? c.active?.pm?.id ?? null;
  const { openProfile, openAsk, setWorkTab } = c;
  const selectTab = useCallback(
    (next: WorkPanelTab) => {
      if (next === "info") {
        if (pm === null && pmId !== null) openProfile(pmId);
      } else if (pm !== null) {
        onSwitchTab(next);
      } else {
        setWorkTab(next);
      }
    },
    [openProfile, pm, pmId, onSwitchTab, setWorkTab],
  );
  const openAskAndClose = useCallback(
    (id: number) => {
      onClose();
      openAsk(id);
    },
    [openAsk, onClose],
  );
  const page = pm?.archivedAt != null && c.profilePage === "capabilities" ? null : c.profilePage;
  const info = pm === null ? undefined : {
    label: `${pm.name}'s settings`,
    body: renderInfoTab(model, c, pm, onBack),
    detailHeader: page === null ? undefined : (
      <WorkPanelDetailHeader
        title={<h1 className="truncate px-1 text-minor font-semibold text-foreground">{infoPageTitle(page)}</h1>}
        backLabel="Back to Info"
        onBack={() => openProfile(pm.id)}
      />
    ),
  };
  return (
    <WorkPanelTabsSheet
      key={`${model.current.key}:${pmId}`}
      layout="page"
      tab={pm === null ? c.workTab : "info"}
      pmId={pmId}
      graphs={c.railGraphs}
      workers={c.railWorkers}
      asks={c.railAsks}
      look={c.look}
      onSelectTab={selectTab}
      onClose={onClose}
      onBack={pm === null ? onClose : onBack}
      backLabel="Back to conversation"
      onOpenWorker={c.openWorkerConversation}
      onOpenAsk={openAskAndClose}
      onNeedWorkers={c.ensureWorkers}
      subscribeTaskGraphs={model.hub.subscribeTaskGraphs}
      info={info}
    />
  );
}
