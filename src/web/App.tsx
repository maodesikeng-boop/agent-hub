import { MOBILE_SHELL_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { MobileShell } from "./mobile/MobileShell.tsx";
import { PiecesDrawer } from "./mobile/PiecesDrawer.tsx";
import { MobileSettings } from "./mobile/settings/MobileSettings.tsx";
import { mobileBack } from "./mobile/back.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "./ui/icons.ts";
import { AccentScope, FruitTint } from "./lib/accent-scope.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { RightRail, RightRailToggle } from "./components/RightRail.tsx";
import { QuotaPopover } from "./components/QuotaPopover.tsx";
import { RouterWorkbench } from "./components/RouterWorkbench.tsx";
import { WorkerConversation } from "./components/WorkerConversation.tsx";
import { PmProfile } from "./components/PmProfile.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { DeviceScope } from "./device-scope.tsx";
import { errorTitle } from "./format.ts";
import { LOCAL_DEVICE, routeDeviceOf } from "./devices.ts";
import { isRenewing, pendingOf, quotaUsage, sessionOf, visibleSessionOf, workerPhaseOf } from "./selectors.ts";
import { Button } from "./ui/button.tsx";
import { ModelCatalogProvider } from "./models.tsx";
import { ROUTER_DRAFT_KEY, useShellModel } from "./shell-model.ts";

function FullPage({ title, lines = [], titleTip, busy = false, action, testId }: { title: string; lines?: readonly string[]; titleTip?: string; busy?: boolean; action?: React.ReactNode; testId?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid={testId}>
      <div className="flex max-w-88 flex-col items-center gap-2">
        {busy ? (
          <>
            <Loader2 className="size-pixel text-muted-foreground" aria-hidden="true" />
            <p className="text-minor text-muted-foreground">{title}</p>
          </>
        ) : (
          <h1 title={titleTip} className="text-title leading-snug font-semibold">{title}</h1>
        )}
        {lines.map((line) => (
          <p key={line} className="text-minor leading-relaxed text-muted-foreground">{line}</p>
        ))}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

const SIGN_IN_ON_COMPUTER = "On a computer, open the sign-in link printed in the terminal at startup";
const SIGN_IN_ON_PHONE = "On a phone, scan the code under Settings → Security & Access → Sign in on another device on a signed-in computer";

type ShellModel = ReturnType<typeof useShellModel>;
type ShellContent = NonNullable<ShellModel["content"]>;

function gatePage({ local, route, routedDevice, fleet }: ShellModel, mobile: boolean): React.ReactNode {
  if (local.state.phase === "loading" || (route?.device !== undefined && routedDevice === undefined && !fleet.listed)) {
    return <FullPage busy title="Loading…" />;
  }
  if (local.state.phase === "unauthorized") {
    return <FullPage testId="unauthenticated" title="Not signed in" lines={mobile ? [SIGN_IN_ON_PHONE, SIGN_IN_ON_COMPUTER] : [SIGN_IN_ON_COMPUTER, SIGN_IN_ON_PHONE]} />;
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
      <header data-window-drag className="flex h-16 shrink-0 items-center px-3" />
      {connecting ? (
        <FullPage busy title="Loading…" />
      ) : (
        <FullPage title="Not connected to this computer yet" lines={[`Check that the daemon is running on ${name}`]} />
      )}
    </>
  );
}

interface PaneProps {
  model: ShellModel;
  content: ShellContent;
  mobile: boolean;
  leading: React.ReactNode;
  toolbar: React.ReactNode;
  top: React.ReactNode;
  notices: React.ReactNode;
  back: () => void;
}

function WorkerPane({ model: { state, hub, current }, content: c, mobile, leading, toolbar, top, notices, workerId }: PaneProps & { workerId: number }) {
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
      onBack={() => c.workerPmEntry && c.select({ device: current.key, id: c.workerPmEntry.id })}
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

function ChatPane(props: PaneProps & { quotaSlot: React.ReactNode; onManageLocalProviders: () => void }) {
  const { model, content: c, mobile, leading, toolbar, top, notices, back } = props;
  const { fleet, state, hub, current } = model;
  if (c.routerActive) {
    return (
      <RouterWorkbench
        leading={leading}
        toolbar={props.quotaSlot}
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
        onManageProviders={props.onManageLocalProviders}
      />
    );
  }
  if (state.phase !== "ready") return <DeviceWaiting connecting={current.status === "connecting"} name={current.info.name} />;
  const { profile, profileEntry, active, view } = c;
  if (profile) {
    return (
      <PmProfile
        key={c.keyOf(profile.id)}
        pm={profile}
        project={profileEntry?.project ?? null}
        folders={profileEntry?.folders ?? []}
        schedules={state.schedules.filter((x) => x.pmId === profile.id)}
        rev={state.personaRev[profile.id] ?? 0}
        renewing={profileEntry !== undefined && isRenewing(state, profileEntry.id)}
        onBack={mobile ? back : () => profileEntry && c.select({ device: current.key, id: profileEntry.id })}
        onManageProviders={() => c.openManageProviders(current.key)}
      />
    );
  }
  if (c.openWorker !== null) return <WorkerPane {...props} workerId={c.openWorker} />;
  if (active && view) {
    return (
      <Conversation
        mobile={mobile}
        leading={leading}
        key={c.keyOf(active.id)}
        entry={active}
        view={view}
        pending={pendingOf(state, active.id)}
        session={visibleSessionOf(state, active.id)}
        older={state.older[active.id]}
        draft={c.drafts.of(c.keyOf(active.id))}
        staging={c.staging.of(c.keyOf(active.id))}
        toolbar={toolbar}
        top={top}
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

function ShellSidebar({ content: c, mobile, quota, quotaInHeader }: { content: ShellContent; mobile: boolean; quota: ReturnType<typeof quotaUsage>; quotaInHeader: boolean }) {
  return (
    <Sidebar
      groups={c.groups}
      active={c.sidebarActiveRef}
      router={c.sidebarRouter}
      waiting={c.reminders.waiting}
      asking={c.reminders.asking}
      notify={c.reminders.notify}
      devices={c.deviceSettings}
      quota={quotaInHeader && !mobile ? undefined : quota}
      quotaFetchable={!quotaInHeader || mobile ? c.quotaFetchable : false}
      layout={mobile ? "page" : c.narrow ? "rail" : "wide"}
      settingsOpen={c.desktopSettingsOpen}
      {...(c.desktopSettingsSection !== undefined ? { defaultSettingsSection: c.desktopSettingsSection } : {})}
      defaultProviderDevice={c.defaultProviderDevice}
      onSettingsOpenChange={c.onSettingsOpenChange}
      onOpenSettings={c.openSettings}
      onSelect={c.select}
      onNewPm={c.openNewPm}
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

export function App() {
  const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const model = useShellModel({ autoSelect: !mobile });
  const { replace, qc, fleet, route, current, hub, state, content } = model;
  useEffect(() => {
    setDrawerOpen(false);
  }, [route, current.key, content?.railHasContent, mobile]);
  const openManageProvidersRef = content?.openManageProviders;
  const openCurrentProviders = useCallback(() => openManageProvidersRef?.(current.key), [openManageProvidersRef, current.key]);
  const notices = useMemo(
    () =>
      content === null ? null : (
        <Notices health={content.health} reconnecting={content.reconnecting} offline={content.offline} listFailed={fleet.listFailed} onManageProviders={openCurrentProviders} />
      ),
    [content?.health, content?.reconnecting, content?.offline, fleet.listFailed, openCurrentProviders],
  );
  const railAttention = content?.railAttention ?? false;
  const railToggle = useMemo(
    () =>
      content === null ? null : (
        <RightRailToggle
          visible={content.railHasContent}
          open={content.railOpen}
          attention={railAttention}
          look={content.look}
          onToggle={content.toggleRail}
        />
      ),
    [content === null, content?.railHasContent, content?.railOpen, railAttention, content?.look, content?.toggleRail],
  );
  const openLocalProviders = useCallback(
    () => openManageProvidersRef?.(LOCAL_DEVICE),
    [openManageProvidersRef],
  );
  const gate = gatePage(model, mobile);
  if (gate !== null) return gate;
  if (content === null) return null;

  const { active, look, compact, profile, openWorker, railOpen, routerActive, view } = content;
  const mobileToggle = <RightRailToggle visible={content.railHasContent} open={drawerOpen} attention={railAttention} look={look} onToggle={() => setDrawerOpen(!drawerOpen)} />;
  const quota = quotaUsage(state);
  const quotaInHeader = routerActive || (state.phase === "ready" && !profile && (openWorker !== null || (active && view)));
  const quotaSlot = quotaInHeader ? <QuotaPopover quota={quota} fetchable={content.quotaFetchable} placement="header" /> : null;
  const railControl = mobile ? mobileToggle : railOpen && !compact ? null : railToggle;
  const toolbar = <>{quotaSlot}{railControl}</>;
  const back = () => mobileBack(route?.view !== "conversation" && active ? { view: "conversation", id: active.id, ...routeDeviceOf(current.key) } : null, replace);
  const leading = mobile ? <Button variant="slot" size="icon" className="shrink-0" aria-label="Back" onClick={back}><ArrowLeft aria-hidden="true" /></Button> : undefined;
  const rail = !routerActive && railOpen ? <RightRail {...railProps(content)} layout={compact ? "top" : "side"} toggle={railToggle} /> : null;
  const settingsRoute = mobile && route?.view === "settings" ? route : null;
  const tintColor = routerActive || settingsRoute !== null ? null : (active?.look.color ?? null);
  const chat = (
    <AccentScope color={tintColor}>
      {settingsRoute !== null ? (
        <MobileSettings
          section={settingsRoute.section}
          notify={content.reminders.notify}
          devices={content.deviceSettings}
          defaultProviderDevice={content.defaultProviderDevice}
          onOpen={content.openSettingsSection}
          onBack={content.settingsBack}
        />
      ) : (
        <>
          <main className="chat-main tint-fade flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-chat">
            <ChatPane
              model={model}
              content={content}
              mobile={mobile}
              leading={leading}
              toolbar={toolbar}
              top={!mobile && compact ? rail : null}
              notices={notices}
              back={back}
              quotaSlot={quotaSlot}
              onManageLocalProviders={openLocalProviders}
            />
          </main>
          {!mobile && !compact && rail}
          {!routerActive && mobile && <PiecesDrawer open={drawerOpen} onOpenChange={setDrawerOpen} {...railProps(content)} />}
        </>
      )}
    </AccentScope>
  );
  return (
    <QueryClientProvider client={qc}>
      <DeviceScope client={hub.client} server={state.server}>
        <ModelCatalogProvider>
          <div className="relative flex h-full">
            <FruitTint color={tintColor}>
              <MobileShell mobile={mobile} list={route === null} sidebar={<ShellSidebar content={content} mobile={mobile} quota={quota} quotaInHeader={Boolean(quotaInHeader)} />}>{chat}</MobileShell>
              <NewPmDialog
                open={content.creating}
                devices={content.newPmDevices}
                defaultDevice={current.key}
                onOpenChange={content.setCreating}
                onCreated={content.created}
                onManageProviders={content.openManageProviders}
              />
            </FruitTint>
          </div>
        </ModelCatalogProvider>
      </DeviceScope>
    </QueryClientProvider>
  );
}
