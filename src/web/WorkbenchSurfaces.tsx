import { useCallback, useMemo, type ReactNode } from "react";
import { CapabilitiesSettings } from "./components/CapabilitiesSettings.tsx";
import { AccountSettings } from "./components/AccountSettings.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { ResourcesSettings } from "./components/ResourcesSettings.tsx";
import { PmWorkPanel, WorkerWorkPanel, type ShellContent, type ShellModel } from "./components/WorkPanelShell.tsx";
import { RouterTopBar } from "./components/RouterTopBar.tsx";
import { RouterWorkbench } from "./components/RouterWorkbench.tsx";
import { isReadOnly } from "./devices.ts";
import { AccentScope } from "./lib/accent-scope.tsx";
import { pendingOf, visibleSessionOf } from "./selectors.ts";
import { railComputerKeyOrFallback } from "./shell-actions.ts";
import { ROUTER_DRAFT_KEY } from "./shell-model.ts";
import { Surface } from "./shell-surfaces.tsx";
import { surfaceSetOf } from "./surface-set.ts";
import type { WorkPanelTab } from "./work-panel-model.ts";
import { Loader2 } from "./ui/icons.ts";

interface SurfaceChrome {
  leading: ReactNode;
  toolbar: ReactNode;
  panelLayout: "side" | "stack" | "page";
  onBack: () => void;
  onCloseMobile: () => void;
  onSwitchMobileTab: (tab: Exclude<WorkPanelTab, "info">) => void;
}

interface WorkbenchSurfacesProps {
  model: ShellModel;
  content: ShellContent;
  mobile: boolean;
  chrome: SurfaceChrome;
  notices: ReactNode;
  onManageLocalProviders: () => void;
  onManageCurrentProviders: () => void;
}

export function FullPage({
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

function DeviceWaiting({ connecting, name }: { connecting: boolean; name: string }) {
  return (
    <>
      <header data-window-drag className="flex h-11 shrink-0 items-center px-3" />
      {connecting ? (
        <FullPage busy title="Loading…" />
      ) : (
        <FullPage title="Not connected to this computer yet" lines={[`Check that the daemon is running on ${name}`]} />
      )}
    </>
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

export function WorkbenchSurfaces({ model, content: c, mobile, chrome, notices, onManageLocalProviders, onManageCurrentProviders }: WorkbenchSurfacesProps) {
  const { current, fleet, navigation, state } = model;
  const { nav } = navigation;
  const computer = railComputerKeyOrFallback(current.key, fleet.devices);
  const listComputer = useMemo(
    () => ({ key: computer.key, name: computer.info.name, status: computer.status }),
    [computer.key, computer.info.name, computer.status],
  );
  const pmId = c.profile?.id ?? c.active?.pm?.id;
  const conversationKey = c.activeId === null ? current.key : c.keyOf(c.activeId);
  const panelKey = pmId === undefined ? null : `${current.key}:${pmId}`;
  const workerKey = c.openWorker === null ? null : c.keyOf(c.openWorker);
  const set = useMemo(
    () => surfaceSetOf({ nav, conversationKey, panelKey, workerKey, managed: fleet.managed }),
    [nav, conversationKey, panelKey, workerKey, fleet.managed],
  );
  const color = c.active?.look.color ?? null;
  const { openSettingsSection } = c;
  const openComputers = useCallback(() => openSettingsSection("computers"), [openSettingsSection]);
  return (
    <>
      <Surface id="topbar">
        <RouterTopBar
          hidden={c.routerActive}
          devices={fleet.devices}
          selfId={fleet.selfId}
          lookOf={c.routerView.lookOf}
          working={c.routerSummary.working}
          routerDraft={c.drafts.of(ROUTER_DRAFT_KEY)}
          clientForDevice={c.clientForDevice}
          storeForDevice={c.storeForDevice}
          onExpand={c.routerSummary.onSelect}
          onOpenConversation={c.openDeviceConversation}
          onOpenWorker={c.openDeviceWorker}
        />
      </Surface>
      <Surface id="list">
        <ProjectList
          layout={mobile ? "page" : "column"}
          computer={listComputer}
          switchable={fleet.devices.length >= 2}
          computers={c.allDevices}
          entries={c.listEntries}
          active={c.sidebarActiveRef}
          waiting={c.reminders.waiting}
          asking={c.reminders.asking}
          readOnly={isReadOnly(current.status)}
          onSelect={c.select}
          onNewPm={c.openNewPm}
          onTogglePin={c.togglePin}
          onOpenComputers={openComputers}
          onSelectComputer={c.selectComputer}
        />
      </Surface>
      {set.router && (
        <Surface id="router">
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
        </Surface>
      )}
      {!c.routerActive && set.conversation !== null && (
        <Surface id="conversation" key={set.conversation} visible={chrome.panelLayout !== "stack"}>
          <AccentScope color={color}>
            <main className={`chat-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${mobile ? "bg-background" : ""}`}>
              <ConversationPane
                model={model}
                content={c}
                mobile={mobile}
                leading={chrome.leading}
                toolbar={chrome.toolbar}
                notices={notices}
                onManageCurrentProviders={onManageCurrentProviders}
              />
            </main>
          </AccentScope>
        </Surface>
      )}
      {state.phase === "ready" && set.panel !== null && (
        <Surface id="panel" key={set.panel}>
          <AccentScope color={color}>
            <PmWorkPanel model={model} content={c} layout={chrome.panelLayout} {...chrome} />
          </AccentScope>
        </Surface>
      )}
      {state.phase === "ready" && set.worker !== null && c.openWorker !== null && (
        <Surface id="worker" key={set.worker}>
          <AccentScope color={color}>
            <WorkerWorkPanel model={model} content={c} layout={chrome.panelLayout} notices={notices} onBack={chrome.onBack} workerId={c.openWorker} />
          </AccentScope>
        </Surface>
      )}
      {set.settings.includes("capabilities") && (
        <Surface id="settings:capabilities">
          <CapabilitiesSettings />
        </Surface>
      )}
      {set.settings.includes("resources") && (
        <Surface id="settings:resources">
          <ResourcesSettings active devices={c.deviceSettings} defaultDeviceKey={c.defaultProviderDevice} />
        </Surface>
      )}
      {set.settings.includes("account") && (
        <Surface id="settings:account">
          <AccountSettings />
        </Surface>
      )}
    </>
  );
}
