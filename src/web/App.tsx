import { MOBILE_SHELL_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { MobileShell } from "./mobile/MobileShell.tsx";
import { PiecesDrawer } from "./mobile/PiecesDrawer.tsx";
import { MobileSettings } from "./mobile/settings/MobileSettings.tsx";
import { mobileBack } from "./mobile/back.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { AccentScope, FruitTint } from "./lib/accent-scope.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { NewPmDialog } from "./components/NewPmDialog.tsx";
import { Notices } from "./components/Notices.tsx";
import { RightRail, RightRailToggle } from "./components/RightRail.tsx";
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

const FULLPAGE = "flex h-full flex-col items-center justify-center gap-3";

export function App() {
  const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { replace, qc, fleet, route, local, routedDevice, current, hub, state, content } = useShellModel({ autoSelect: !mobile });
  useEffect(() => {
    setDrawerOpen(false);
  }, [route, current.key, content?.railHasContent, mobile]);
  const notices = useMemo(
    () =>
      content === null ? null : (
        <Notices health={content.health} reconnecting={content.reconnecting} offline={content.offline} listFailed={fleet.listFailed} />
      ),
    [content?.health, content?.reconnecting, content?.offline, fleet.listFailed],
  );
  const railAttention = content?.railAttention ?? false;
  const railToggle = useMemo(
    () =>
      content === null ? null : (
        <RightRailToggle
          visible={content.railHasContent}
          open={content.railOpen}
          attention={railAttention}
          avatarKey={content.avatarKey}
          onToggle={content.toggleRail}
        />
      ),
    [content === null, content?.railHasContent, content?.railOpen, railAttention, content?.avatarKey, content?.toggleRail],
  );
  // 整页的加载中、没登录、连不上只看入口本机；别的设备连不上在主区里说
  if (local.state.phase === "loading" || (route?.device !== undefined && routedDevice === undefined && !fleet.listed)) {
    return (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    );
  }
  if (local.state.phase === "unauthorized") {
    return (
      <div className={FULLPAGE} data-testid="unauthenticated">
        <p>Not signed in. On your computer, open the sign-in link printed in the terminal at startup. On a phone, scan the code from Settings → Security &amp; Access → Sign in on phone on a signed-in computer</p>
      </div>
    );
  }
  if (local.state.phase === "error") {
    return (
      <div className={FULLPAGE}>
        <p title={local.state.loadError ? errorTitle(local.state.loadError) : undefined}>{local.state.loadError?.text ?? "连不上守护进程"}</p>
        {local.state.loadError?.hint && <p>{local.state.loadError.hint}</p>}
        <p className="text-minor text-muted-foreground">If the service isn't running, run pnpm start in the project folder</p>
        <Button onClick={() => void fleet.hub(LOCAL_DEVICE).reload()}>Retry</Button>
      </div>
    );
  }

  if (content === null) return null;
  const {
    active,
    actions,
    avatarKey,
    clearFocus,
    clientForDevice,
    compact,
    created,
    creating,
    defaultProviderDevice,
    desktopSettingsOpen,
    desktopSettingsSection,
    deviceSettings,
    drafts,
    focus,
    groups,
    handleLoadOlder,
    keyOf,
    link,
    narrow,
    newPmDevices,
    onSettingsOpenChange,
    openAsk,
    openDeviceConversation,
    openDeviceWorker,
    openManageProviders,
    openNewPm,
    openProfile,
    openSettings,
    openSettingsSection,
    openWorker,
    openWorkerConversation,
    profile,
    profileEntry,
    quotaFetchable,
    railAsks,
    railGraphs,
    railHasContent,
    railOpen,
    railProjectId,
    railWorkers,
    reminders,
    routerActive,
    routerView,
    select,
    send,
    setCreating,
    settingsBack,
    sidebarActiveRef,
    sidebarRouter,
    staging,
    view,
    workerLine,
    workerPmEntry,
    workerView,
  } = content;
  // 开关跟着右栏走：并排的右栏展开时在右栏顶部，其余（收起、太窄时右栏在顶栏下面）在顶栏右边，也就是窗口右上角
  const mobileToggle = <RightRailToggle visible={railHasContent} open={drawerOpen} attention={railAttention} avatarKey={avatarKey} onToggle={() => setDrawerOpen(!drawerOpen)} />;
  const toolbar = mobile ? mobileToggle : railOpen && !compact ? null : railToggle;
  const back = () => mobileBack(route?.view !== "conversation" && active ? { view: "conversation", id: active.id, ...routeDeviceOf(current.key) } : null, replace);
  const leading = mobile ? <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back" onClick={back}><ArrowLeft aria-hidden="true" /></Button> : undefined;
  const rail = !routerActive && railOpen ? (
    <RightRail
      asks={railAsks}
      workers={railWorkers}
      activeGraphs={railGraphs}
      projectId={railProjectId}
      openWorkerId={openWorker}
      layout={compact ? "top" : "side"}
      toggle={railToggle}
      avatarKey={avatarKey}
      onOpenAsk={openAsk}
      onOpenWorker={openWorkerConversation}
    />
  ) : null;
  const top = !mobile && compact ? rail : null;

  // 别的设备还没加载好：加载中，或者一次都没连上（联机第 4.3 节）
  const deviceWaiting =
    routerActive || state.phase === "ready" ? null : current.status === "connecting" ? (
      <div className={FULLPAGE}>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    ) : (
      <div className={FULLPAGE}>
        <p>Not connected to this computer yet</p>
        <p className="text-minor text-muted-foreground">Check that Tailscale is on and the daemon is running on {current.info.name}</p>
      </div>
    );

  const sidebar = (
    <Sidebar
      groups={groups}
      active={sidebarActiveRef}
      router={sidebarRouter}
      waiting={reminders.waiting}
      asking={reminders.asking}
      notify={reminders.notify}
      devices={deviceSettings}
      quota={quotaUsage(state)}
      quotaFetchable={quotaFetchable}
      layout={mobile ? "page" : narrow ? "rail" : "wide"}
      settingsOpen={desktopSettingsOpen}
      {...(desktopSettingsSection !== undefined ? { defaultSettingsSection: desktopSettingsSection } : {})}
      defaultProviderDevice={defaultProviderDevice}
      onSettingsOpenChange={onSettingsOpenChange}
      onOpenSettings={openSettings}
      onSelect={select}
      onNewPm={openNewPm}
    />
  );
  const settingsRoute = mobile && route?.view === "settings" ? route : null;
  const tintKey = routerActive || settingsRoute !== null ? null : (active?.avatarKey ?? null);
  const chat = (
    <AccentScope colorKey={tintKey}>
      {settingsRoute !== null ? (
        <MobileSettings
          section={settingsRoute.section}
          notify={reminders.notify}
          devices={deviceSettings}
          defaultProviderDevice={defaultProviderDevice}
          onOpen={openSettingsSection}
          onBack={settingsBack}
        />
      ) : (
        <>
          <main className="chat-main tint-fade flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-chat">
            {routerActive ? (
              <RouterWorkbench
                leading={leading}
                notices={notices}
                view={routerView}
                devices={fleet.devices}
                selfId={fleet.selfId}
                draft={drafts.of(ROUTER_DRAFT_KEY)}
                staging={staging.of(ROUTER_DRAFT_KEY)}
                clientForDevice={clientForDevice}
                onOpenConversation={openDeviceConversation}
                onOpenWorker={openDeviceWorker}
              />
            ) : deviceWaiting ? (
              <>
                <header data-window-drag className="flex h-16 shrink-0 items-center px-3" />
                {deviceWaiting}
              </>
            ) : profile ? (
              <PmProfile
                key={keyOf(profile.id)}
                pm={profile}
                project={profileEntry?.project ?? null}
                folders={profileEntry?.folders ?? []}
                schedules={state.schedules.filter((x) => x.pmId === profile.id)}
                rev={state.personaRev[profile.id] ?? 0}
                renewing={profileEntry !== undefined && isRenewing(state, profileEntry.id)}
                onBack={mobile ? back : () => profileEntry && select({ device: current.key, id: profileEntry.id })}
                onManageProviders={() => openManageProviders(current.key)}
              />
            ) : openWorker !== null ? (
              <WorkerConversation
                mobile={mobile}
                leading={leading}
                key={keyOf(openWorker)}
                title={workerLine?.title ?? workerView?.conversation.title ?? "Piece"}
                readonly={workerLine?.readonly ?? false}
                phase={workerPhaseOf(state, openWorker)}
                pm={{ name: workerPmEntry?.name ?? "Project manager", avatarKey: workerPmEntry?.avatarKey ?? 0 }}
                meta={railWorkers.find((w) => w.conversationId === openWorker)}
                view={workerView}
                pending={pendingOf(state, openWorker)}
                session={sessionOf(state, openWorker)}
                older={state.older[openWorker]}
                draft={drafts.of(keyOf(openWorker))}
                staging={staging.of(keyOf(openWorker))}
                toolbar={toolbar}
                top={top}
                notices={notices}
                onBack={() => workerPmEntry && select({ device: current.key, id: workerPmEntry.id })}
                onSend={send}
                onRetry={hub.retrySend}
                onStop={hub.stop}
                onRewind={hub.rewind}
                onLoadOlder={handleLoadOlder}
                actions={actions}
                link={link}
              />
            ) : active && view ? (
              <Conversation
                mobile={mobile}
                leading={leading}
                key={keyOf(active.id)}
                entry={active}
                view={view}
                pending={pendingOf(state, active.id)}
                session={visibleSessionOf(state, active.id)}
                older={state.older[active.id]}
                draft={drafts.of(keyOf(active.id))}
                staging={staging.of(keyOf(active.id))}
                toolbar={toolbar}
                top={top}
                notices={notices}
                onSend={send}
                onRetry={hub.retrySend}
                onStop={hub.stop}
                onRewind={hub.rewind}
                onLoadOlder={handleLoadOlder}
                actions={actions}
                focus={focus}
                onFocusDone={clearFocus}
                onOpenProfile={openProfile}
                link={link}
              />
            ) : (
              <>
                {notices}
                <div className="flex flex-1 items-center justify-center text-muted-foreground">No conversations yet</div>
              </>
            )}
          </main>
          {!mobile && !compact && rail}
          {!routerActive && mobile && (
            <PiecesDrawer
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              asks={railAsks}
              workers={railWorkers}
              activeGraphs={railGraphs}
              projectId={railProjectId}
              avatarKey={avatarKey}
              openWorkerId={openWorker}
              onOpenAsk={openAsk}
              onOpenWorker={openWorkerConversation}
            />
          )}
        </>
      )}
    </AccentScope>
  );
  return (
    <QueryClientProvider client={qc}>
      <DeviceScope client={hub.client} server={state.server}>
        <ModelCatalogProvider>
          <div className="relative flex h-full">
            {/* 外壳底色掺当前项目经理的水果色（左栏、对话区、右栏、分割线）；Router 下传 null 保持纯白与碳黑中性调 */}
            <FruitTint colorKey={tintKey}>
              <MobileShell mobile={mobile} list={route === null} sidebar={sidebar}>{chat}</MobileShell>
              <NewPmDialog
                open={creating}
                devices={newPmDevices}
                defaultDevice={current.key}
                onOpenChange={setCreating}
                onCreated={created}
                onManageProviders={openManageProviders}
              />
            </FruitTint>
          </div>
        </ModelCatalogProvider>
      </DeviceScope>
    </QueryClientProvider>
  );
}
