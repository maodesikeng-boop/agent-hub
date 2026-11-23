import { Blocks, Cable, Monitor, Server, Settings, Shield, type Icon } from "../ui/icons.ts";
import { useRef, useState, type ReactNode } from "react";
import { LOCAL_DEVICE, type DeviceKey } from "../devices.ts";
import type { NotifySettings } from "../notify.ts";
import { useCachedResourcesSummary } from "../resources-model.ts";
import { NOTIFY_BLOCKED, isNotifyBlocked, useUiScaleSetting, type DeviceSettings } from "../settings-model.ts";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { CapabilitiesSettings } from "./CapabilitiesSettings.tsx";
import { ComputersSection } from "./DeviceSettings.tsx";
import { ProvidersSettings } from "./ProvidersSettings.tsx";
import { ResourcesSettings } from "./ResourcesSettings.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsList.tsx";
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

  const content: Record<SettingsDialogSection, ReactNode> = {
    general: (
      <>
        <SettingsGroup label="General">
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" titleClassName="sr-only" className="h-[min(35rem,calc(100%-3rem))] max-w-195 gap-0 p-0">
        <Tabs
          value={effectiveSection}
          onValueChange={(val) => setActiveSection(val as SettingsDialogSection)}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col min-[720px]:flex-row"
        >
          <div className="flex shrink-0 items-center border-b-2 border-list-edge bg-list pr-14 min-[720px]:block min-[720px]:border-r-2 min-[720px]:border-b-0 min-[720px]:pr-0">
            <TabsList
              aria-label="Settings categories"
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-3 py-3 min-[720px]:w-48 min-[720px]:flex-col min-[720px]:overflow-x-visible min-[720px]:py-4"
            >
              {sections.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="flex h-9 shrink-0 cursor-pointer items-center gap-3 border-2 border-transparent px-3 text-body whitespace-nowrap text-list-ink-soft transition-colors outline-none hover:bg-list-hover hover:text-list-ink focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] data-[state=active]:border-select-line data-[state=active]:bg-background data-[state=active]:text-list-ink"
                >
                  <Icon className="size-pixel shrink-0 max-[719px]:hidden" aria-hidden="true" />
                  {label}
                  {id === "resources" && resourcesSummary.attention && (
                    <span data-testid="resources-tab-attention" aria-hidden="true" className="ml-auto size-2 shrink-0 bg-caution" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {sections.map(({ id, label }) => (
            <TabsContent key={id} value={id} className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel outline-none">
              <h2 className="shrink-0 px-6 pt-6 pr-14 pb-5 text-title font-semibold">{label}</h2>
              <div className="dialog-body-fade grid min-h-0 flex-1 grid-cols-1 content-start gap-6 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pt-1 pb-6">{content[id]}</div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
