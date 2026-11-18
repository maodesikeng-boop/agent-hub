import { MOBILE_SHELL_QUERY, useMediaQuery } from "./useMediaQuery.ts";
import { MobileShell } from "./mobile/MobileShell.tsx";
import { PiecesDrawer } from "./mobile/PiecesDrawer.tsx";
import { MobileSettings } from "./mobile/settings/MobileSettings.tsx";
import { mobileBack } from "./mobile/back.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * 整页状态（加载中、没登录、连不上、设备没连上）：居中一列，最宽 22rem、左右留 24px；
 * 标题 17px 600，下面的说明 13.5px 灰，一屏最多一个主按钮。
 */
function FullPage({ title, lines = [], titleTip, busy = false, action, testId }: { title: string; lines?: readonly string[]; titleTip?: string; busy?: boolean; action?: React.ReactNode; testId?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid={testId}>
      <div className="flex max-w-88 flex-col items-center gap-2">
        {busy ? (
          <>
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
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

export function App() {
  const mobile = useMediaQuery(MOBILE_SHELL_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { replace, qc, fleet, route, local, routedDevice, current, hub, state, content } = useShellModel({ autoSelect: !mobile });
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
          avatarKey={content.avatarKey}
          onToggle={content.toggleRail}
        />
      ),
    [content === null, content?.railHasContent, content?.railOpen, railAttention, content?.avatarKey, content?.toggleRail],
  );
  const openLocalProviders = useCallback(
    () => openManageProvidersRef?.(LOCAL_DEVICE),
    [openManageProvidersRef],
  );
  // 整页的加载中、没登录、连不上只看入口本机；别的设备连不上在主区里说
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
        title={error?.text ?? "连不上守护进程"}
        titleTip={error ? errorTitle(error) : undefined}
        lines={error?.hint ? [error.hint] : []}
        action={<Button onClick={() => void fleet.hub(LOCAL_DEVICE).reload()}>Retry</Button>}
      />
    );
  }

  if (content === null) return null;
  const {
    active,
    actions,
    avatarKey,
    clearFocus,
    clientForDevice,
    storeForDevice,
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
    workerLoading,
    workerPmEntry,
    workerView,
    railLoadMoreWorkers,
    ensureWorkers,
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
      onLoadMoreWorkers={railLoadMoreWorkers}
      onNeedWorkers={ensureWorkers}
    />
  ) : null;
  const top = !mobile && compact ? rail : null;

  // 别的设备还没加载好：加载中，或者一次都没连上（联机第 4.3 节）
  const deviceWaiting =
    routerActive || state.phase === "ready" ? null : current.status === "connecting" ? (
      <FullPage busy title="Loading…" />
    ) : (
      <FullPage title="Not connected to this computer yet" lines={[`Check that Tailscale is on and the daemon is running on ${current.info.name}`]} />
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
                storeForDevice={storeForDevice}
                onOpenConversation={openDeviceConversation}
                onOpenWorker={openDeviceWorker}
                onManageProviders={openLocalProviders}
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
                loading={workerLoading}
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
                <div className="flex flex-1 items-center justify-center text-minor text-muted-foreground">No conversations yet</div>
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
              onLoadMoreWorkers={railLoadMoreWorkers}
              onNeedWorkers={ensureWorkers}
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
