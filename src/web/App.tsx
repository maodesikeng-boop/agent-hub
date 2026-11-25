import { QueryClientProvider } from "@tanstack/react-query";
import { Activity, useCallback, useEffect, useMemo, useState } from "react";
import { pickableVendorCatalogs, type Pm } from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { AppRail } from "./components/AppRail.tsx";
import { CapabilityProjects } from "./components/CapabilitiesSettings.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { ProfilePanel } from "./components/ProfilePanel.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { PieceMeta, PiecesSlot, RailGroups } from "./components/RightRail.tsx";
import { RouterWorkbench } from "./components/RouterWorkbench.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { WorkerConversation } from "./components/WorkerConversation.tsx";
import { DeviceScope } from "./device-scope.tsx";
import { LOCAL_DEVICE, isReadOnly, routeDeviceOf } from "./devices.ts";
import { errorTitle } from "./format.ts";
import { AccentScope } from "./lib/accent-scope.tsx";
import { SHELL_CHAT_MIN_REM, SHELL_LIST_REM, SHELL_PANEL_REM } from "./limits.ts";
import { mobileBack } from "./mobile/back.ts";
import { MobileShell } from "./mobile/MobileShell.tsx";
import { PiecesDrawer } from "./mobile/PiecesDrawer.tsx";
import { TabBar, mobileTabOf, type MobileTab } from "./mobile/TabBar.tsx";
import { MobileSettings } from "./mobile/settings/MobileSettings.tsx";
import { ModelCatalogProvider, useServerModelCatalogs } from "./models.tsx";
import { usePaneWidths } from "./pane-widths.ts";
import { useCurrentQuota } from "./quota.ts";
import { quotaMeterOf } from "./rail-model.ts";
import { useResourcesAttention } from "./resources-model.ts";
import type { ProfilePage } from "./route.ts";
import { isRenewing, pendingOf, quotaUsage, sessionOf, visibleSessionOf, workerPhaseOf } from "./selectors.ts";
import { useShellTier } from "./shell-layout.ts";
import { railComputerKeyOrFallback } from "./shell-actions.ts";
import { ROUTER_DRAFT_KEY, useShellModel } from "./shell-model.ts";
import { panelExitsOf, sidePanelOf, type SidePanelContent } from "./side-panel.ts";
import { Button } from "./ui/button.tsx";
import { ArrowLeft, Loader2 } from "./ui/icons.ts";
import { Pane, PaneGroup, PaneHandle } from "./ui/resizable.tsx";
import { useUpdateReminder } from "./update-model.ts";
import { useAutoHideScrollbars } from "./useAutoHideScrollbars.ts";
import { MOBILE_SHELL_QUERY, useMediaQuery } from "./useMediaQuery.ts";

const SIGN_IN_ON_COMPUTER = "On a computer, open the sign-in link printed in the terminal at startup";
const SIGN_IN_ON_PHONE = "On a phone, scan the code under Settings → Security & Access → Sign in on another device on a signed-in computer";

const PROFILE_PAGE_TITLES: Readonly<Record<ProfilePage, string>> = {
  capabilities: "Capabilities",
  persona: "Persona",
  memory: "Memory files",
  worktree: "Worktree setup",
  history: "History",
};

type ShellModel = ReturnType<typeof useShellModel>;
type ShellContent = NonNullable<ShellModel["content"]>;

function FullPage({
  title,
  lines = [],
  titleTip,
  busy = false,
  action,
  testId,
}: {
  title: string;
  lines?: readonly string[];
  titleTip?: string;
  busy?: boolean;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid={testId}>
      <div className="flex max-w-88 flex-col items-center gap-2">
        {busy ? (
          <>
            <Loader2 className="size-pixel text-muted-foreground" aria-hidden="true" />
            <p className="text-minor text-muted-foreground">{title}</p>
          </>
        ) : (
          <h1 title={titleTip} className="text-title leading-snug font-semibold">
            {title}
          </h1>
        )}
        {lines.map((line) => (
          <p key={line} className="text-minor leading-relaxed text-muted-foreground">
            {line}
          </p>
        ))}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

function gatePage({ local, route, routedDevice, fleet }: ShellModel, mobile: boolean): React.ReactNode {
  if (local.state.phase === "loading" || (route?.device !== undefined && routedDevice === undefined && !fleet.listed)) {
    return <FullPage busy title="Loading…" />;
  }
  if (local.state.phase === "unauthorized") {
    return (
      <FullPage
        testId="unauthenticated"
        title="Not signed in"
        lines={mobile ? [SIGN_IN_ON_PHONE, SIGN_IN_ON_COMPUTER] : [SIGN_IN_ON_COMPUTER, SIGN_IN_ON_PHONE]}
      />
    );
  }
  if (local.state.phase === "error") {
    const error = local.state.loadError;
    return (
      <FullPage
        title={error?.text ?? "Can't reach the daemon"}
        titleTip={error ? errorTitle(error) : undefined}
        lines={error?.hint ? [error.hint] : []}
        action={<Button onClick={() => void fleet.hub(LOCAL_DEVICE).reload()}>Retry</Button>}
      />
    );
  }
  return null;
}

function DeviceWaiting({ connecting, name }: { connecting: boolean; name: string }) {
  return (
    <>
      <header data-window-drag className="flex h-14 shrink-0 items-center px-3" />
      {connecting ? (
        <FullPage busy title="Loading…" />
      ) : (
        <FullPage title="Not connected to this computer yet" lines={[`Check that the daemon is running on ${name}`]} />
      )}
    </>
  );
}

function WorkerPane({
  model: { state, hub, current },
  content: c,
  mobile,
  leading,
  toolbar,
  top,
  notices,
  workerId,
}: {
  model: ShellModel;
  content: ShellContent;
  mobile: boolean;
  leading?: React.ReactNode;
  toolbar?: React.ReactNode;
  top?: React.ReactNode;
  notices: React.ReactNode;
  workerId: number;
}) {
  return (
    <WorkerConversation
      mobile={mobile}
      leading={leading}
      key={c.keyOf(workerId)}
      title={c.workerLine?.title ?? c.workerView?.conversation.title ?? "Piece"}
      readonly={c.workerLine?.readonly ?? false}
      phase={workerPhaseOf(state, workerId)}
      pm={{ name: c.workerPmEntry?.name ?? "Project manager", look: c.workerPmEntry?.look ?? c.look }}
      meta={c.railWorkers.find((w) => w.conversationId === workerId)}
      view={c.workerView}
      loading={c.workerLoading}
      pending={pendingOf(state, workerId)}
      session={sessionOf(state, workerId)}
      older={state.older[workerId]}
      draft={c.drafts.of(c.keyOf(workerId))}
      staging={c.staging.of(c.keyOf(workerId))}
      toolbar={toolbar}
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

function railProps(c: ShellContent) {
  return {
    asks: c.railAsks,
    workers: c.railWorkers,
    activeGraphs: c.railGraphs,
    projectId: c.railProjectId,
    openWorkerId: c.openWorker,
    look: c.look,
    onOpenAsk: c.openAsk,
    onOpenWorker: c.openWorkerConversation,
    onLoadMoreWorkers: c.railLoadMoreWorkers,
    onNeedWorkers: c.ensureWorkers,
  };
}

function renderProfilePanel(
  model: ShellModel,
  c: ShellContent,
  variant: "panel" | "page",
  pm: Pm,
  onClose: () => void,
) {
  const { state, current } = model;
  const entry = c.profileEntry;
  return (
    <ProfilePanel
      key={c.keyOf(pm.id)}
      variant={variant}
      pm={pm}
      project={entry?.project ?? null}
      folders={entry?.folders ?? []}
      schedules={state.schedules.filter((x) => x.pmId === pm.id)}
      rev={state.personaRev[pm.id] ?? 0}
      renewing={entry !== undefined && isRenewing(state, entry.id)}
      page={c.profilePage}
      readOnly={isReadOnly(current.status)}
      onNavigate={(page) => c.openProfile(pm.id, page ?? undefined)}
      onClose={onClose}
      onTogglePin={(pinned) => c.togglePin(pm.id, pinned)}
      onManageProviders={() => c.openManageProviders(current.key)}
      onEditDefaults={() => c.openSettingsSection("capabilities")}
    />
  );
}

function DesktopSidePanel({
  model,
  content: c,
  panelContent,
  layout,
  notices,
}: {
  model: ShellModel;
  content: ShellContent;
  panelContent: SidePanelContent;
  layout: "side" | "stack";
  notices: React.ReactNode;
}) {
  const { navigate, current } = model;
  const convRoute = useMemo(
    () => (c.active ? { view: "conversation" as const, id: c.active.id, ...routeDeviceOf(current.key) } : null),
    [c.active, current.key],
  );
  const exits = useMemo(
    () => (convRoute ? panelExitsOf(panelContent, convRoute) : { close: { view: "conversation" as const, id: 1 }, back: null, backOpensPieces: false }),
    [panelContent, convRoute],
  );

  if (panelContent.kind === "pieces") {
    return (
      <SidePanel
        layout={layout}
        label="Pieces"
        title={<span className="truncate px-1 text-title font-semibold text-foreground">Pieces</span>}
        onClose={() => c.toggleRail()}
        closeLabel="Close Pieces"
      >
        <RailGroups {...railProps(c)} className="pb-3" />
      </SidePanel>
    );
  }

  if (panelContent.kind === "worker") {
    const meta = c.railWorkers.find((w) => w.conversationId === panelContent.workerId);
    const title = c.workerLine?.title ?? c.workerView?.conversation.title ?? "Piece";
    const readonly = c.workerLine?.readonly ?? false;
    return (
      <SidePanel
        layout={layout}
        label={title}
        title={
          <div className="flex min-w-0 items-center gap-2">
            <span title={title} className="min-w-0 truncate text-body font-semibold text-foreground">
              {title}
            </span>
            {readonly && <span className="tool-badge shrink-0 px-2 py-0.5 text-xs font-medium">Read-only</span>}
            {meta && <PieceMeta worker={meta} />}
          </div>
        }
        onBack={() => {
          if (exits.backOpensPieces) c.toggleRail(true);
          if (exits.back) navigate(exits.back);
        }}
        backLabel={c.workerPmEntry ? `Back to ${c.workerPmEntry.name}` : "Back"}
        onClose={() => {
          if (convRoute) navigate(exits.close);
          else c.routerSummary.onSelect();
        }}
        closeLabel="Close Piece"
      >
        <WorkerPane model={model} content={c} mobile={false} notices={notices} workerId={panelContent.workerId} />
      </SidePanel>
    );
  }

  const profile = c.profile;
  if (!profile) return null;
  const headerTitle = panelContent.page !== null ? PROFILE_PAGE_TITLES[panelContent.page] : "Settings";
  return (
    <SidePanel
      layout={layout}
      label={`${profile.name}'s settings`}
      title={<span className="truncate px-1 text-title font-semibold text-foreground">{headerTitle}</span>}
      {...(exits.back !== null ? { onBack: () => navigate(exits.back!), backLabel: "Back to settings summary" } : {})}
      onClose={() => {
        if (convRoute) navigate(exits.close);
        else c.routerSummary.onSelect();
      }}
      closeLabel="Close settings"
    >
      {renderProfilePanel(model, c, "panel", profile, () => {
        if (convRoute) navigate(exits.close);
      })}
    </SidePanel>
  );
}

function ConversationPane({
  model,
  content: c,
  mobile,
  leading,
  toolbar,
  notices,
  onManageCurrentProviders,
}: {
  model: ShellModel;
  content: ShellContent;
  mobile: boolean;
  leading?: React.ReactNode;
  toolbar?: React.ReactNode;
  notices: React.ReactNode;
  onManageCurrentProviders: () => void;
}) {
  const { state, hub, current } = model;
  if (state.phase !== "ready") return <DeviceWaiting connecting={current.status === "connecting"} name={current.info.name} />;
  if (c.active && c.view) {
    return (
      <Conversation
        mobile={mobile}
        leading={leading}
        key={c.keyOf(c.active.id)}
        entry={c.active}
        view={c.view}
        pending={pendingOf(state, c.active.id)}
        session={visibleSessionOf(state, c.active.id)}
        older={state.older[c.active.id]}
        draft={c.drafts.of(c.keyOf(c.active.id))}
        staging={c.staging.of(c.keyOf(c.active.id))}
        toolbar={toolbar}
        top={null}
        notices={notices}
        onSend={c.send}
        onRetry={hub.retrySend}
        onStop={hub.stop}
        onRewind={hub.rewind}
        onLoadOlder={c.handleLoadOlder}
        actions={c.actions}
        focus={c.focus}
        onFocusDone={c.clearFocus}
        onOpenProfile={c.openProfile}
        onManageProviders={onManageCurrentProviders}
        link={c.link}
      />
    );
  }
  return (
    <>
      {notices}
      <div className="flex flex-1 items-center justify-center text-minor text-muted-foreground">No conversations yet</div>
    </>
  );
}

function DesktopWorkbench({
  model,
  content: c,
  notices,
  quota,
  onManageLocalProviders,
  onManageCurrentProviders,
}: {
  model: ShellModel;
  content: ShellContent;
  notices: React.ReactNode;
  quota: ReturnType<typeof quotaUsage>;
  onManageLocalProviders: () => void;
  onManageCurrentProviders: () => void;
}) {
  const [shellEl, setShellEl] = useState<HTMLElement | null>(null);
  const { widths, commit, reset } = usePaneWidths((s) => s);
  const { fleet, state, current, route } = model;

  const panelRaw = c.routerActive ? null : sidePanelOf({ route, piecesOpen: c.railOpen, piecesHasContent: c.railHasContent });
  const panelContent = panelRaw !== null && panelRaw.kind === "profile" && c.profile === null ? null : panelRaw;
  const panelVisible = panelContent !== null && !c.routerActive && state.phase === "ready";
  const tier = useShellTier(shellEl, panelVisible);
  const stackPanel = tier === "stack" && panelVisible;
  const meter = useMemo(() => quotaMeterOf(quota), [quota]);
  const computer = useMemo(() => railComputerKeyOrFallback(current.key, fleet.devices), [current.key, fleet.devices]);
  const listComputer = useMemo(
    () => ({ key: computer.key, name: computer.info.name, status: computer.status }),
    [computer.key, computer.info.name, computer.status],
  );
  const { activeId, openSettingsSection, toggleRail, select } = c;
  const openComputers = useCallback(() => openSettingsSection("computers"), [openSettingsSection]);
  const switchable = fleet.devices.length >= 2;
  const readOnly = isReadOnly(current.status);
  const tintColor = c.routerActive ? null : (c.active?.look.color ?? null);

  const routeView = route?.view;
  const togglePieces = useCallback(() => {
    if (activeId === null) return;
    if (routeView === "worker" || routeView === "profile") {
      toggleRail(true);
      select({ device: current.key, id: activeId });
    } else {
      toggleRail();
    }
  }, [activeId, routeView, toggleRail, select, current.key]);

  const piecesOpen = panelContent?.kind === "pieces";
  const toolbar = useMemo(
    () => (
      <PiecesSlot
        visible={c.railHasContent}
        open={piecesOpen}
        attention={c.railAttention}
        look={c.look}
        onToggle={togglePieces}
      />
    ),
    [c.railHasContent, piecesOpen, c.railAttention, c.look, togglePieces],
  );

  const listNode = (layout: "column" | "strip") => (
    <ProjectList
      layout={layout}
      computer={listComputer}
      switchable={switchable}
      computers={c.allDevices}
      entries={c.listEntries}
      active={c.sidebarActiveRef}
      waiting={c.reminders.waiting}
      asking={c.reminders.asking}
      readOnly={readOnly}
      onSelect={c.select}
      onNewPm={c.openNewPm}
      onTogglePin={c.togglePin}
      onOpenComputers={openComputers}
      onSelectComputer={c.selectComputer}
    />
  );

  return (
    <div ref={setShellEl} data-shell="desktop" className="relative flex h-full w-full min-w-0 overflow-hidden bg-rail">
      <AppRail
        router={c.routerSummary}
        computers={c.railComputers}
        selectedComputer={c.routerActive ? null : current.key}
        meter={meter}
        quota={quota}
        quotaFetchable={state.server.currentQuota === true || c.quotaFetchable}
        onSelectComputer={c.selectComputer}
        onOpenSettings={() => c.openSettingsSection("scale")}
        settingsOpen={c.desktopSettingsOpen}
        onOpenUpdates={() => c.openSettingsSection("updates")}
        onOpenAccount={() => c.openSettingsSection(c.accountTarget)}
      />

      <div className="shell-frame flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {c.routerActive ? (
          <main className="shell-sheet chat-main ml-1.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <RouterWorkbench
              toolbar={null}
              notices={notices}
              view={c.routerView}
              devices={fleet.devices}
              selfId={fleet.selfId}
              draft={c.drafts.of(ROUTER_DRAFT_KEY)}
              staging={c.staging.of(ROUTER_DRAFT_KEY)}
              clientForDevice={c.clientForDevice}
              storeForDevice={c.storeForDevice}
              onOpenConversation={c.openDeviceConversation}
              onOpenWorker={c.openDeviceWorker}
              onManageProviders={onManageLocalProviders}
            />
          </main>
        ) : (
          <>
            {tier !== "wide" && <div className="flex shrink-0 py-1.5 pr-1.5">{listNode("strip")}</div>}
            <PaneGroup id="shell-panes">
              {tier === "wide" && (
                <>
                  <Pane
                    key="list"
                    id="list"
                    defaultRem={widths.list}
                    minRem={SHELL_LIST_REM.min}
                    maxRem={SHELL_LIST_REM.max}
                    onCommit={(rem) => commit("list", rem)}
                  >
                    <div className="flex min-h-0 flex-1 flex-col py-1.5">{listNode("column")}</div>
                  </Pane>
                  <PaneHandle label="Resize project list" onReset={() => reset("list")} />
                </>
              )}

              <Pane
                key="chat"
                id="chat"
                {...(stackPanel ? { defaultRem: 0, minRem: 0, maxRem: 0, className: "hidden" } : { minRem: SHELL_CHAT_MIN_REM })}
              >
                <Activity mode={stackPanel ? "hidden" : "visible"}>
                  <AccentScope color={tintColor}>
                    <main className="shell-sheet chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                      <ConversationPane
                        model={model}
                        content={c}
                        mobile={false}
                        toolbar={toolbar}
                        notices={notices}
                        onManageCurrentProviders={onManageCurrentProviders}
                      />
                    </main>
                  </AccentScope>
                </Activity>
              </Pane>

              {panelVisible && !stackPanel && <PaneHandle label="Resize side panel" onReset={() => reset("panel")} />}

              {panelVisible && (
                <Pane
                  key="panel"
                  id="panel"
                  {...(stackPanel
                    ? { className: "min-w-0 flex-1" }
                    : {
                        defaultRem: widths.panel,
                        minRem: SHELL_PANEL_REM.min,
                        maxRem: SHELL_PANEL_REM.max,
                        onCommit: (rem: number) => commit("panel", rem),
                      })}
                >
                  <AccentScope color={tintColor}>
                    <DesktopSidePanel
                      model={model}
                      content={c}
                      panelContent={panelContent}
                      layout={stackPanel ? "stack" : "side"}
                      notices={notices}
                    />
                  </AccentScope>
                </Pane>
              )}
            </PaneGroup>
          </>
        )}
      </div>

      <SettingsDialog
        open={c.desktopSettingsOpen}
        onOpenChange={c.onSettingsOpenChange}
        {...(c.desktopSettingsSection !== undefined ? { defaultSection: c.desktopSettingsSection } : {})}
        {...(c.defaultProviderDevice !== undefined ? { defaultProviderDevice: c.defaultProviderDevice } : {})}
        notify={c.reminders.notify}
        devices={c.deviceSettings}
      />
    </div>
  );
}

function MobileWorkbench({
  model,
  content: c,
  notices,
  quota,
  drawerOpen,
  setDrawerOpen,
  onManageLocalProviders,
  onManageCurrentProviders,
}: {
  model: ShellModel;
  content: ShellContent;
  notices: React.ReactNode;
  quota: ReturnType<typeof quotaUsage>;
  drawerOpen: boolean;
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onManageLocalProviders: () => void;
  onManageCurrentProviders: () => void;
}) {
  const { fleet, state, current, route, replace, navigate } = model;
  useEffect(() => {
    setDrawerOpen(false);
  }, [route, current.key, c.railHasContent, setDrawerOpen]);
  const updateWaiting = useUpdateReminder() !== null;
  const resources = useResourcesAttention();
  const settingsAttention = updateWaiting || resources.attention;

  const mobileTab = mobileTabOf(route);
  const computer = useMemo(() => railComputerKeyOrFallback(current.key, fleet.devices), [current.key, fleet.devices]);
  const listComputer = useMemo(
    () => ({ key: computer.key, name: computer.info.name, status: computer.status }),
    [computer.key, computer.info.name, computer.status],
  );
  const { activeId } = c;
  const openComputers = useCallback(() => navigate({ view: "settings", section: "computers" }), [navigate]);
  const switchable = fleet.devices.length >= 2;
  const readOnly = isReadOnly(current.status);
  const tintColor = route?.view === "router" || route?.view === "settings" ? null : (c.active?.look.color ?? null);

  const routeView = route?.view;
  const back = useCallback(
    () =>
      mobileBack(
        routeView !== "conversation" && activeId !== null
          ? { view: "conversation", id: activeId, ...routeDeviceOf(current.key) }
          : null,
        replace,
      ),
    [routeView, activeId, current.key, replace],
  );
  const leading = useMemo(
    () => (
      <Button variant="slot" size="icon" className="shrink-0" aria-label="Back" onClick={back}>
        <ArrowLeft aria-hidden="true" />
      </Button>
    ),
    [back],
  );
  const toggleMobileDrawer = useCallback(() => setDrawerOpen((open) => !open), [setDrawerOpen]);
  const mobileToolbar = useMemo(
    () => (
      <PiecesSlot
        visible={c.railHasContent}
        open={drawerOpen}
        attention={c.railAttention}
        look={c.look}
        onToggle={toggleMobileDrawer}
      />
    ),
    [c.railHasContent, drawerOpen, c.railAttention, c.look, toggleMobileDrawer],
  );

  const selectMobileTab = (tab: MobileTab) => {
    if (tab === "projects") replace(null);
    else if (tab === "router") c.routerSummary.onSelect();
    else c.openSettings();
  };

  const sidebar = (
    <ProjectList
      layout="page"
      computer={listComputer}
      switchable={switchable}
      computers={c.allDevices}
      entries={c.listEntries}
      active={c.sidebarActiveRef}
      waiting={c.reminders.waiting}
      asking={c.reminders.asking}
      readOnly={readOnly}
      onSelect={c.select}
      onNewPm={c.openNewPm}
      onTogglePin={c.togglePin}
      onOpenComputers={openComputers}
      onSelectComputer={c.selectComputer}
    />
  );

  const tabBar = mobileTab !== null ? (
    <TabBar active={mobileTab} routerBadge={c.routerSummary.pendingCount} settingsAttention={settingsAttention} onSelect={selectMobileTab} />
  ) : undefined;

  let body: React.ReactNode = null;
  if (route?.view === "settings") {
    body = (
      <MobileSettings
        section={route.section}
        notify={c.reminders.notify}
        devices={c.deviceSettings}
        quota={quota}
        defaultProviderDevice={c.defaultProviderDevice}
        onOpen={c.openSettingsSection}
        onBack={c.settingsBack}
      />
    );
  } else if (route?.view === "router") {
    body = (
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <RouterWorkbench
          toolbar={null}
          notices={notices}
          view={c.routerView}
          devices={fleet.devices}
          selfId={fleet.selfId}
          draft={c.drafts.of(ROUTER_DRAFT_KEY)}
          staging={c.staging.of(ROUTER_DRAFT_KEY)}
          clientForDevice={c.clientForDevice}
          storeForDevice={c.storeForDevice}
          onOpenConversation={c.openDeviceConversation}
          onOpenWorker={c.openDeviceWorker}
          onManageProviders={onManageLocalProviders}
        />
      </main>
    );
  } else if (state.phase !== "ready") {
    body = (
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <DeviceWaiting connecting={current.status === "connecting"} name={current.info.name} />
      </main>
    );
  } else if (route?.view === "profile" && c.profile !== null) {
    body = renderProfilePanel(model, c, "page", c.profile, back);
  } else if (c.openWorker !== null) {
    body = (
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkerPane model={model} content={c} mobile leading={leading} toolbar={null} notices={notices} workerId={c.openWorker} />
      </main>
    );
  } else {
    body = (
      <>
        <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <ConversationPane
            model={model}
            content={c}
            mobile
            leading={leading}
            toolbar={mobileToolbar}
            notices={notices}
            onManageCurrentProviders={onManageCurrentProviders}
          />
        </main>
        <PiecesDrawer open={drawerOpen} onOpenChange={setDrawerOpen} {...railProps(c)} />
      </>
    );
  }

  return (
    <MobileShell mobile list={route === null} sidebar={sidebar} tabBar={tabBar}>
      <AccentScope color={tintColor}>{body}</AccentScope>
    </MobileShell>
  );
}

function FirstRunProviderCheck({ client, onDone }: { client: HubClient; onDone: (openProviders: boolean) => void }) {
  const catalogs = useServerModelCatalogs({ enabled: true, client });
  useEffect(() => {
    if (catalogs === undefined || catalogs.length === 0) return;
    onDone(pickableVendorCatalogs(catalogs).length === 0);
  }, [catalogs, onDone]);
  return null;
}

export function App() {
  useAutoHideScrollbars();
  const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const model = useShellModel({ autoSelect: !mobile });
  const { qc, fleet, current, hub, state, content } = model;
  const mobileUsageVisible = mobile && model.route?.view === "settings" && model.route.section === undefined;
  const currentQuota = useCurrentQuota(qc, hub.client, {
    enabled: state.phase === "ready" && state.server.currentQuota === true && (!mobile || mobileUsageVisible),
    visible: mobileUsageVisible,
  });
  const hasContent = content !== null;
  const openManageProvidersRef = content?.openManageProviders;
  const openCurrentProviders = useCallback(() => openManageProvidersRef?.(current.key), [openManageProvidersRef, current.key]);
  const openLocalProviders = useCallback(() => openManageProvidersRef?.(LOCAL_DEVICE), [openManageProvidersRef]);
  const health = content?.health;
  const reconnecting = content?.reconnecting;
  const offline = content?.offline;
  const notices = useMemo(
    () =>
      !hasContent ? null : (
        <Notices health={health!} reconnecting={reconnecting!} offline={offline!} listFailed={fleet.listFailed} onManageProviders={openCurrentProviders} />
      ),
    [hasContent, health, reconnecting, offline, fleet.listFailed, openCurrentProviders],
  );
  const gate = gatePage(model, mobile);
  if (gate !== null) return gate;
  if (content === null) return null;

  const quota = state.server.currentQuota ? currentQuota : quotaUsage(state);

  return (
    <QueryClientProvider client={qc}>
      <DeviceScope client={hub.client} server={state.server}>
        <ModelCatalogProvider>
          <CapabilityProjects pms={model.local.state.pms}>
            <div className="relative flex h-full">
              {mobile ? (
                <MobileWorkbench
                  model={model}
                  content={content}
                  notices={notices}
                  quota={quota}
                  drawerOpen={drawerOpen}
                  setDrawerOpen={setDrawerOpen}
                  onManageLocalProviders={openLocalProviders}
                  onManageCurrentProviders={openCurrentProviders}
                />
              ) : (
                <DesktopWorkbench
                  model={model}
                  content={content}
                  notices={notices}
                  quota={quota}
                  onManageLocalProviders={openLocalProviders}
                  onManageCurrentProviders={openCurrentProviders}
                />
              )}
              <NewPmDialog
                open={content.creating}
                devices={content.newPmDevices}
                defaultDevice={current.key}
                onOpenChange={content.setCreating}
                onCreated={content.created}
                onManageProviders={content.openManageProviders}
              />
              {content.firstRunCheck !== null && (
                <FirstRunProviderCheck client={content.firstRunCheck.client} onDone={content.firstRunCheck.onDone} />
              )}
            </div>
          </CapabilityProjects>
        </ModelCatalogProvider>
      </DeviceScope>
    </QueryClientProvider>
  );
}
