import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickableVendorCatalogs } from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { AppRail } from "./components/AppRail.tsx";
import { CapabilityProjects } from "./components/CapabilitiesSettings.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { WorkPanelToggle } from "./components/WorkPanel.tsx";
import type { ShellContent, ShellModel } from "./components/WorkPanelShell.tsx";
import { useComputerRename, type ComputerRenameApi } from "./settings-drafts.ts";
import { SurfaceOutlet, SurfaceScope } from "./shell-surfaces.tsx";
import { settingsBodies, WorkbenchSettings } from "./WorkbenchSettings.tsx";
import { FullPage, WorkbenchSurfaces } from "./WorkbenchSurfaces.tsx";
import { dialogTabOf, sectionForDialogTab } from "./workbench-nav.ts";
import { DeviceScope } from "./device-scope.tsx";
import { LOCAL_DEVICE, routeDeviceOf } from "./devices.ts";
import { errorTitle } from "./format.ts";
import { SHELL_LIST_REM, SHELL_PANEL_REM } from "./limits.ts";
import { mobileBack } from "./mobile/back.ts";
import { MobileShell } from "./mobile/MobileShell.tsx";
import { TabBar, mobileTabOf, type MobileTab } from "./mobile/TabBar.tsx";
import { ModelCatalogProvider, useServerModelCatalogs } from "./models.tsx";
import { usePaneWidths } from "./pane-widths.ts";
import { quotaMeterOf } from "./rail-model.ts";
import { useResourcesAttention } from "./resources-model.ts";
import { quotaUsage } from "./selectors.ts";
import { useMobileShell, useShellFit } from "./shell-layout.ts";
import { workPanelOf } from "./side-panel.ts";
import { useShellModel } from "./shell-model.ts";
import { Button } from "./ui/button.tsx";
import { ArrowLeft } from "./ui/icons.ts";
import { Pane, PaneGroup, PaneHandle } from "./ui/resizable.tsx";
import { useUpdateReminder } from "./update-model.ts";
import { useAutoHideScrollbars } from "./useAutoHideScrollbars.ts";

const SIGN_IN_ON_COMPUTER = "On a computer, open the sign-in link printed in the terminal at startup";
const SIGN_IN_ON_PHONE = "On a phone, scan the code under Settings → Security & Access → Sign in on another device on a signed-in computer";
const NO_SESSION_QUOTA: ReturnType<typeof quotaUsage> = [];

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
        action={<Button size="sm" onClick={() => void fleet.hub(LOCAL_DEVICE).reload()}>Retry</Button>}
      />
    );
  }
  return null;
}

interface LayoutProps {
  model: ShellModel;
  content: ShellContent;
  quota: ReturnType<typeof quotaUsage>;
  panel: "panel" | "worker" | null;
  rename: ComputerRenameApi;
}

function DesktopWorkbench({
  model: { current, state, navigation },
  content: c,
  quota,
  panel,
  rename,
  setShellElement,
  chatMinRem,
  stackPanel,
}: LayoutProps & { setShellElement: (element: HTMLElement | null) => void; chatMinRem: number; stackPanel: boolean }) {
  const { widths, commit, reset } = usePaneWidths((s) => s);
  const meter = useMemo(() => quotaMeterOf(quota), [quota]);
  const settings = navigation.nav.settings;
  const tab = dialogTabOf(settings?.section, c.deviceSettings !== null);
  return (
    <div ref={setShellElement} data-shell="desktop" className="wood relative flex h-full w-full min-w-0 flex-col overflow-hidden">
      <SurfaceOutlet id="topbar" />
      <div className="flex min-h-0 min-w-0 flex-1">
        <AppRail
          router={c.routerSummary}
          computers={c.railComputers}
          selectedComputer={c.routerActive ? null : current.key}
          meter={meter}
          quota={quota}
          quotaFetchable={state.server.currentQuota === true || c.quotaFetchable}
          quotaReady={state.phase === "ready"}
          onSelectComputer={c.selectComputer}
          onOpenSettings={() => c.openSettingsSection("scale")}
          settingsOpen={settings !== null}
          onOpenUpdates={() => c.openSettingsSection("updates")}
          onOpenAccount={() => c.openSettingsSection(c.accountTarget)}
        />
        <div className="shell-frame flex min-h-0 min-w-0 flex-1">
          {c.routerActive ? (
            <main className="shell-group chat-main flex min-h-0 min-w-0 flex-1 flex-col bg-background">
              <SurfaceOutlet id="router" />
            </main>
          ) : (
            <div className="shell-group flex min-h-0 min-w-0 flex-1">
              <PaneGroup id="shell-panes">
                <Pane
                  key="list"
                  id="list"
                  defaultRem={widths.list}
                  minRem={SHELL_LIST_REM.min}
                  maxRem={SHELL_LIST_REM.max}
                  preserveWidth={stackPanel}
                  onCommit={(rem) => commit("list", rem)}
                >
                  <SurfaceOutlet id="list" />
                </Pane>
                <PaneHandle seam="joint" label="Resize project list" onReset={() => reset("list")} />
                {!stackPanel && (
                  <Pane
                    key="chat"
                    id="chat"
                    minRem={chatMinRem}
                    className="shell-sheet shell-sheet-joined"
                  >
                    <SurfaceOutlet id="conversation" />
                  </Pane>
                )}
                {panel !== null && !stackPanel && <PaneHandle seam="gap" label="Resize side panel" onReset={() => reset("panel")} />}
                {panel !== null && (
                  <Pane
                    key="panel"
                    id="panel"
                    {...(stackPanel
                      ? { className: "shell-sheet shell-sheet-joined" }
                      : {
                          className: "shell-sheet",
                          defaultRem: widths.panel,
                          minRem: SHELL_PANEL_REM.min,
                          maxRem: SHELL_PANEL_REM.max,
                          onCommit: (rem: number) => commit("panel", rem),
                        })}
                  >
                    <SurfaceOutlet id={panel} />
                  </Pane>
                )}
              </PaneGroup>
            </div>
          )}
        </div>
      </div>
      <SettingsDialog
        open={settings !== null}
        onOpenChange={(open) => { if (!open) navigation.closeSettings(); }}
        onSectionChange={(next) => navigation.showSettingsSection(sectionForDialogTab(next, settings?.section, c.deviceSettings !== null))}
        {...(tab === undefined ? {} : { section: tab })}
        notify={c.reminders.notify}
        devices={c.deviceSettings}
        rename={rename}
        bodies={settingsBodies}
      />
    </div>
  );
}

function MobileWorkbench({ model, content: c, panel }: Omit<LayoutProps, "quota" | "rename">) {
  const { route, navigation, replace } = model;
  const settings = navigation.nav.settings;
  const tab = settings === null ? mobileTabOf(route) : settings.section === undefined ? "settings" : null;
  const updateWaiting = useUpdateReminder() !== null;
  const resources = useResourcesAttention();

  const selectTab = (next: MobileTab) => {
    if (next === "projects") replace(null);
    else if (next === "router") c.routerSummary.onSelect();
    else c.openSettings();
  };

  let body: React.ReactNode;
  if (settings !== null) {
    body = <SurfaceOutlet id="settings:mobile" />;
  } else if (panel !== null) {
    body = <SurfaceOutlet id={panel} />;
  } else if (route?.view === "router") {
    body = (
      <main className="chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <SurfaceOutlet id="router" />
      </main>
    );
  } else {
    body = <SurfaceOutlet id="conversation" />;
  }
  return (
    <MobileShell
      tabBar={tab === null ? undefined : (
        <TabBar active={tab} routerBadge={c.routerSummary.pendingCount} settingsAttention={updateWaiting || resources.attention} onSelect={selectTab} />
      )}
    >
      {settings === null && route === null ? <SurfaceOutlet id="list" /> : body}
    </MobileShell>
  );
}

function Workbench({
  model,
  content: c,
  mobile,
  quota,
  notices,
  openLocalProviders,
  openCurrentProviders,
}: Omit<LayoutProps, "panel" | "rename"> & {
  mobile: boolean;
  notices: React.ReactNode;
  openLocalProviders: () => void;
  openCurrentProviders: () => void;
}) {
  const { route, current, state, replace, navigate } = model;
  const rename = useComputerRename();
  const settings = model.navigation.nav.settings;
  const computersOpen = c.deviceSettings !== null && settings !== null && (settings.section === undefined || settings.section === "computers");
  useEffect(() => {
    if (!computersOpen || (rename.rename !== null && !c.deviceSettings?.devices.some((device) => device.key === rename.rename?.deviceKey))) rename.finish();
  }, [computersOpen, rename, c.deviceSettings]);
  const [shellElement, setShellElement] = useState<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const keepPanelOpen = useRef(false);
  useEffect(() => {
    if (keepPanelOpen.current) keepPanelOpen.current = false;
    else setDrawerOpen(false);
  }, [route, current.key]);
  const panelContent = workPanelOf({ route, open: c.railOpen, tab: c.workTab });
  const desktopPanel = !c.routerActive && state.phase === "ready" && panelContent !== null &&
    (panelContent.kind !== "info" || c.profile !== null);
  const mobilePanel = !c.routerActive && state.phase === "ready" && (
    route?.view === "profile" ? c.profile !== null : c.openWorker !== null || drawerOpen
  );
  const panel = (mobile ? mobilePanel : desktopPanel) ? c.openWorker === null ? "panel" : "worker" : null;
  const { tier, chatMinRem } = useShellFit(shellElement, desktopPanel);
  const stackPanel = tier === "stack" && desktopPanel;

  const back = useCallback(() => {
    mobileBack(
      route?.view !== "conversation" && c.activeId !== null
        ? { view: "conversation", id: c.activeId, ...routeDeviceOf(current.key) } : null,
      replace,
    );
  }, [route?.view, c.activeId, current.key, replace]);

  const toggleWorkPanel = useCallback(() => {
    if (mobile) {
      setDrawerOpen((open) => !open);
    } else if (c.activeId !== null && desktopPanel && (route?.view === "worker" || route?.view === "profile")) {
      c.toggleRail(false);
      c.select({ device: current.key, id: c.activeId });
    } else {
      c.toggleRail();
    }
  }, [mobile, c.activeId, c.toggleRail, c.select, desktopPanel, route?.view, current.key]);

  const leading = useMemo(() => mobile ? (
    <Button variant="slot" size="icon" className="shrink-0" aria-label="Back" onClick={back}>
      <ArrowLeft aria-hidden="true" />
    </Button>
  ) : null, [mobile, back]);
  const closeMobilePanel = useCallback(() => setDrawerOpen(false), []);
  const panelOpen = mobile ? drawerOpen : desktopPanel;
  const toolbar = useMemo(() => c.activeId === null ? null : (
    <WorkPanelToggle open={panelOpen} attention={c.railAttention} look={c.look} onToggle={toggleWorkPanel} />
  ), [c.activeId, panelOpen, c.railAttention, c.look, toggleWorkPanel]);

  return (
    <SurfaceScope>
      {mobile
        ? <MobileWorkbench model={model} content={c} panel={panel} />
        : <DesktopWorkbench model={model} content={c} quota={quota} panel={panel} rename={rename} setShellElement={setShellElement} chatMinRem={chatMinRem} stackPanel={stackPanel} />}
      {(mobile || settings !== null) && (
        <WorkbenchSettings
          mobile={mobile}
          open={settings !== null}
          section={settings?.section}
          notify={c.reminders.notify}
          devices={c.deviceSettings}
          quota={quota}
          quotaReady={state.phase === "ready"}
          defaultProviderDevice={c.defaultProviderDevice}
          onOpen={c.openSettingsSection}
          onBack={model.navigation.settingsBack}
          rename={rename}
        />
      )}
      <WorkbenchSurfaces
        model={model}
        content={c}
        mobile={mobile}
        notices={notices}
        onManageLocalProviders={openLocalProviders}
        onManageCurrentProviders={openCurrentProviders}
        chrome={{
          leading,
          toolbar,
          panelLayout: mobile ? "page" : stackPanel ? "stack" : "side",
          onBack: back,
          onCloseMobile: closeMobilePanel,
          onSwitchMobileTab: (tab) => {
            c.setWorkTab(tab);
            keepPanelOpen.current = true;
            setDrawerOpen(true);
            if (c.active !== null) navigate({ view: "conversation", id: c.active.id, ...routeDeviceOf(current.key) });
          },
        }}
      />
    </SurfaceScope>
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
  const mobile = useMobileShell();
  const model = useShellModel({ mobile });
  const { qc, fleet, current, hub, state, content } = model;
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
  if (gate !== null) {
    return (
      <div data-window-drag className="wood flex h-full w-full p-[var(--frame-inset)] pt-[var(--topbar-height)]">
        <main className="shell-sheet flex min-h-0 min-w-0 flex-1 flex-col">{gate}</main>
      </div>
    );
  }
  if (content === null) return null;

  const quota = state.server.currentQuota === true ? NO_SESSION_QUOTA : quotaUsage(state);

  return (
    <QueryClientProvider client={qc}>
      <DeviceScope client={hub.client} server={state.server}>
        <ModelCatalogProvider>
          <CapabilityProjects pms={model.local.state.pms}>
            <div className="relative flex h-full">
              <Workbench
                model={model}
                content={content}
                mobile={mobile}
                notices={notices}
                quota={quota}
                openLocalProviders={openLocalProviders}
                openCurrentProviders={openCurrentProviders}
              />
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
