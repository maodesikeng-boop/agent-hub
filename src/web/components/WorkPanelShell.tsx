import { useCallback } from "react";
import type * as React from "react";
import { DEFAULT_AGENT_VENDOR, isAgentVendor, type Pm, type SessionState } from "../../shared/index.ts";
import { isReadOnly, routeDeviceOf } from "../devices.ts";
import { infoPageTitle } from "../info-rows.ts";
import { useModelCatalog } from "../models.tsx";
import { isRenewing, pendingOf, sessionOf, workerOutcomesOf, workerPhaseOf, type WorkerEntry } from "../selectors.ts";
import type { useShellModel } from "../shell-model.ts";
import { workPanelExitsOf } from "../side-panel.ts";
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

interface WorkPanelShellProps {
  model: ShellModel;
  content: ShellContent;
  layout: "side" | "stack" | "page";
  onBack: () => void;
  onCloseMobile: () => void;
  onSwitchMobileTab: (tab: Exclude<WorkPanelTab, "info">) => void;
}

export function PmWorkPanel({
  model,
  content: c,
  layout,
  onBack,
  onCloseMobile,
  onSwitchMobileTab,
}: WorkPanelShellProps) {
  const { navigate, current, route, hub } = model;
  const mobile = layout === "page";
  const pm = c.profile;
  const pmId = pm?.id ?? c.active?.pm?.id ?? null;

  function closePanel() {
    if (mobile) {
      if (pm === null) onCloseMobile();
      else onBack();
      return;
    }
    c.toggleRail(false);
    if (route?.view === "conversation") return;
    if (c.active === null) c.routerSummary.onSelect();
    else navigate({ view: "conversation", id: c.active.id, ...routeDeviceOf(current.key) });
  }

  function selectTab(next: WorkPanelTab) {
    if (next === "info") {
      if (pmId !== null && pm === null) c.openProfile(pmId);
    } else if (mobile && pm !== null) {
      onSwitchMobileTab(next);
    } else {
      c.setWorkTab(next);
      if (!mobile) {
        c.toggleRail(true);
        if (route?.view !== "conversation" && c.active !== null) {
          navigate({ view: "conversation", id: c.active.id, ...routeDeviceOf(current.key) });
        }
      }
    }
  }

  const { openAsk: focusAsk, toggleRail } = c;
  const openAsk = useCallback((id: number) => {
    if (mobile) onCloseMobile();
    else if (layout === "stack") toggleRail(false);
    focusAsk(id);
  }, [mobile, onCloseMobile, layout, toggleRail, focusAsk]);
  const keepPanelOpen = useCallback(() => toggleRail(true), [toggleRail]);

  const page = c.profilePage;
  const info = pm === null ? undefined : {
    label: `${pm.name}'s settings`,
    body: renderInfoTab(model, c, pm, closePanel),
    detailHeader: page === null ? undefined : (
      <WorkPanelDetailHeader
        title={<h1 className="truncate px-1 text-minor font-semibold text-foreground">{infoPageTitle(page)}</h1>}
        backLabel="Back to Info"
        onBack={() => c.openProfile(pm.id)}
        {...(mobile ? {} : { onClose: closePanel })}
      />
    ),
  };

  return (
    <WorkPanelTabsSheet
      layout={layout}
      tab={pm === null ? c.workTab : "info"}
      pmId={pmId}
      graphs={c.railGraphs}
      workers={c.railWorkers}
      asks={c.railAsks}
      look={c.look}
      onSelectTab={selectTab}
      onClose={closePanel}
      {...(mobile ? { onBack: closePanel, backLabel: "Back to conversation" } : { onExpand: keepPanelOpen })}
      onOpenWorker={c.openWorkerConversation}
      onOpenAsk={openAsk}
      onNeedWorkers={c.ensureWorkers}
      subscribeTaskGraphs={hub.subscribeTaskGraphs}
      info={info}
    />
  );
}

export function WorkerWorkPanel({
  model,
  content: c,
  layout,
  notices,
  onBack,
  workerId,
}: Pick<WorkPanelShellProps, "model" | "content" | "layout" | "onBack"> & { notices: React.ReactNode; workerId: number }) {
  const { state, hub, current, navigate } = model;
  const mobile = layout === "page";
  const meta = c.railWorkers.find((w) => w.conversationId === workerId);
  const session = sessionOf(state, workerId);
  const title = c.workerLine?.title ?? c.workerView?.conversation.title ?? "Worker";
  const ended = workerPhaseOf(state, workerId) === "ended";
  const branch = c.workerView?.workerBranch ?? meta?.branch ?? c.workerLine?.branch ?? null;
  function openConversation(keepPanel: boolean) {
    c.toggleRail(keepPanel);
    if (c.active === null) c.routerSummary.onSelect();
    else {
      const conversation = { view: "conversation", id: c.active.id, ...routeDeviceOf(current.key) } as const;
      const exits = workPanelExitsOf({ kind: "worker", workerId }, conversation);
      navigate((keepPanel ? exits.back : exits.close) ?? conversation);
    }
  }

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
          backLabel={!mobile && c.workerPmEntry ? `Back to ${c.workerPmEntry.name}` : "Back"}
          onBack={mobile ? onBack : () => openConversation(true)}
          {...(mobile ? {} : { onClose: () => openConversation(false) })}
          onStop={() => void hub.stop(workerId)}
          onEnd={() => void hub.client.postEndWorker(workerId).catch(() => {})}
        />
      }
    >
      <WorkerPane model={model} content={c} mobile={mobile} notices={notices} workerId={workerId} />
    </WorkPanel>
  );
}
