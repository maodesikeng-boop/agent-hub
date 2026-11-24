import { Blocks, Cable, Monitor, Server, Settings, Shield, X, type Icon } from "../ui/icons.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LOCAL_DEVICE, type DeviceKey } from "../devices.ts";
import type { NotifySettings } from "../notify.ts";
import { useCachedResourcesSummary } from "../resources-model.ts";
import { NOTIFY_BLOCKED, isNotifyBlocked, useUiScaleSetting, type DeviceSettings } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogClose, DialogContent } from "../ui/dialog.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { CapabilitiesSettings } from "./CapabilitiesSettings.tsx";
import { ComputersSection } from "./DeviceSettings.tsx";
import { ProvidersSettings } from "./ProvidersSettings.tsx";
import { ResourcesSettings } from "./ResourcesSettings.tsx";
import { FlatSettingsGroups, SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { UpdateSettings } from "./UpdateSettings.tsx";

export type { DeviceSettings };

function UiScaleRow() {
  const { scale, options, setScale } = useUiScaleSetting();
  return (
    <SettingsRow label="Interface scale">
      {(id) => <Segmented id={id} label="Interface scale" value={scale} options={options} onChange={setScale} />}
    </SettingsRow>
  );
}

export type SettingsDialogSection = "general" | "providers" | "capabilities" | "resources" | "computers" | "security";

const SECTIONS: readonly { id: SettingsDialogSection; label: string; icon: Icon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "providers", label: "Providers", icon: Blocks },
  { id: "capabilities", label: "Capabilities", icon: Cable },
  { id: "resources", label: "Resources", icon: Server },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "security", label: "Security & Access", icon: Shield },
];

export function SettingsDialog({
  open,
  onOpenChange,
  notify,
  devices = null,
  defaultSection,
  defaultProviderDevice = LOCAL_DEVICE,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notify: NotifySettings;
  devices?: DeviceSettings | null;
  defaultSection?: SettingsDialogSection;
  defaultProviderDevice?: DeviceKey;
}) {
  const sections = SECTIONS.filter((s) => s.id !== "computers" || devices !== null);
  const initialSection: SettingsDialogSection =
    defaultSection !== undefined && (defaultSection !== "computers" || devices !== null)
      ? defaultSection
      : devices !== null
        ? "computers"
        : "general";

  const [activeSection, setActiveSection] = useState<SettingsDialogSection>(initialSection);
  const prevSyncRef = useRef({ open, defaultSection, hasDevices: devices !== null });
  if (
    prevSyncRef.current.open !== open ||
    prevSyncRef.current.defaultSection !== defaultSection ||
    prevSyncRef.current.hasDevices !== (devices !== null)
  ) {
    const reopened = !prevSyncRef.current.open && open;
    const defaultChanged = prevSyncRef.current.defaultSection !== defaultSection && defaultSection !== undefined;
    prevSyncRef.current = { open, defaultSection, hasDevices: devices !== null };
    if (reopened || defaultChanged || (activeSection === "computers" && devices === null)) {
      setActiveSection(initialSection);
    }
  }

  const effectiveSection = activeSection === "computers" && devices === null ? initialSection : activeSection;
  const resourcesSummary = useCachedResourcesSummary();
  const tabsRef = useRef<HTMLDivElement>(null);
  // Below 720px the categories scroll sideways; keep the open one in view when Settings opens on a later category.
  useEffect(() => {
    if (open) tabsRef.current?.querySelector<HTMLElement>('[data-state="active"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [open, effectiveSection]);

  const content: Record<SettingsDialogSection, ReactNode> = {
    general: (
      <>
        <SettingsGroup title="This browser">
          <UiScaleRow />
          <SettingsRow label="Notifications" detail={NOTIFY_BLOCKED[notify.permission]}>
            {(id) => (
              <Switch
                id={id}
                aria-label="Notifications"
                checked={notify.enabled}
                disabled={isNotifyBlocked(notify)}
                onCheckedChange={(on) => void notify.setEnabled(on)}
              />
            )}
          </SettingsRow>
        </SettingsGroup>
        <UpdateSettings />
      </>
    ),
    providers: (
      <ProvidersSettings
        active={open && effectiveSection === "providers"}
        devices={devices}
        defaultDeviceKey={defaultProviderDevice}
      />
    ),
    capabilities: <CapabilitiesSettings />,
    resources: (
      <ResourcesSettings
        active={open && effectiveSection === "resources"}
        devices={devices}
        defaultDeviceKey={defaultProviderDevice}
      />
    ),
    computers: devices && <ComputersSection {...devices} />,
    security: <BrowserSessionsSettings />,
  };

  // Settings is a page of the workbench: the categories sit on the cream frame like the PM list, and the open category is a
  // white sheet whose header line stays level with the categories header.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" page>
        <Tabs
          value={effectiveSection}
          onValueChange={(val) => setActiveSection(val as SettingsDialogSection)}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col min-[720px]:flex-row"
        >
          <div className="flex shrink-0 flex-col pt-1.5 min-[720px]:w-66">
            <div aria-hidden="true" data-window-drag className="flex h-14 shrink-0 items-center border-b border-border pl-4 text-title font-semibold text-list-ink max-[719px]:hidden">
              Settings
            </div>
            <TabsList
              ref={tabsRef}
              aria-label="Settings categories"
              className="flex min-w-0 gap-1 overflow-x-auto px-2 py-1.5 max-[719px]:pr-10 max-[719px]:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] min-[720px]:flex-col min-[720px]:overflow-x-visible min-[720px]:py-2"
            >
              {sections.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="flex h-9 shrink-0 cursor-pointer items-center gap-3 rounded-sm px-2 text-body whitespace-nowrap text-list-ink-soft transition-[background-color,box-shadow,color] duration-150 outline-none hover:bg-list-hover hover:text-list-ink focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] motion-reduce:transition-none data-[state=active]:tile-selected data-[state=active]:text-list-ink"
                >
                  <Icon className="size-pixel shrink-0 max-[719px]:hidden" aria-hidden="true" />
                  {label}
                  {id === "resources" && resourcesSummary.attention && (
                    <span data-testid="resources-tab-attention" aria-hidden="true" className="ml-auto size-2 shrink-0 rounded-full bg-danger" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {sections.map(({ id, label }) => (
            <TabsContent key={id} value={id} className="shell-sheet ml-1.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none">
              <header data-window-drag className="relative flex h-14 shrink-0 items-center border-b border-border">
                <h2 className="mx-auto w-full max-w-252 min-w-0 truncate pr-14 pl-6 text-title font-semibold">{label}</h2>
                <DialogClose asChild>
                  <Button variant="ghost" size="icon" className="absolute right-3" aria-label="Close">
                    <X aria-hidden="true" />
                  </Button>
                </DialogClose>
              </header>
              <div className="@container/settings dialog-body-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pt-5 pb-10">
                {/* Rows keep their 16px padding, so the 8px inset puts every row's text on the 24px edge of the title. */}
                <div className="mx-auto grid w-full max-w-248 grid-cols-1 content-start gap-8 @min-[52rem]/settings:gap-10">
                  <FlatSettingsGroups page={id !== "capabilities"}>{content[id]}</FlatSettingsGroups>
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
