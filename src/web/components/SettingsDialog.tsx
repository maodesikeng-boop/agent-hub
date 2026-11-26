import { Blocks, Cable, Monitor, Server, Settings, Shield, X, type Icon } from "../ui/icons.ts";
import type { ReactNode } from "react";
import type { SettingsDialogSection } from "../workbench-nav.ts";
import type { ComputerRenameApi } from "../settings-drafts.ts";
import type { NotifySettings } from "../notify.ts";
import { useCachedResourcesSummary } from "../resources-model.ts";
import { NOTIFY_BLOCKED, isNotifyBlocked, useUiScaleSetting, type DeviceSettings } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogClose, DialogContent } from "../ui/dialog.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { ComputersSection } from "./DeviceSettings.tsx";
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

export type SettingsBodies = Record<"capabilities" | "resources" | "account" | "providers", ReactNode>;

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
  onSectionChange,
  notify,
  devices = null,
  section,
  bodies,
  rename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSectionChange?: (section: SettingsDialogSection) => void;
  notify: NotifySettings;
  devices?: DeviceSettings | null;
  section?: SettingsDialogSection;
  bodies: SettingsBodies;
  rename: ComputerRenameApi;
}) {
  const sections = SECTIONS.filter((s) => s.id !== "computers" || devices !== null);
  const effectiveSection = section ?? (devices === null ? "general" : "computers");
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
    providers: bodies.providers,
    capabilities: bodies.capabilities,
    resources: bodies.resources,
    computers: devices && <ComputersSection {...devices} account={bodies.account} rename={rename} />,
    security: <BrowserSessionsSettings />,
  };

  // Settings is a page of the workbench laid out like the PM page: the categories sit on the year rings joined to the white
  // sheet of the open category, and both header lines stay level.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Settings"
        page
        onPointerDownOutside={(event) => {
          // A surface is hosted outside the dialog's React tree, but its outlet is inside the dialog.
          const target = event.detail.originalEvent.target;
          if (target instanceof Element && target.closest('[data-slot="dialog-content"][data-page], [data-slot="popover-content"], [data-slot="select-content"]')) event.preventDefault();
        }}
      >
        <Tabs
          value={effectiveSection}
          onValueChange={(val) => onSectionChange?.(val as SettingsDialogSection)}
          orientation="vertical"
          className="shell-group flex min-h-0 flex-1 flex-col min-[720px]:flex-row"
        >
          <div className="wood-rings shell-list flex shrink-0 flex-col max-[719px]:after:hidden min-[720px]:w-66">
            <div aria-hidden="true" data-window-drag className="groove-bottom flex h-11 shrink-0 items-center pl-4 text-title font-semibold text-list-ink max-[719px]:hidden">
              Settings
            </div>
            <TabsList
              aria-label="Settings categories"
              className="flex min-w-0 gap-1 overflow-x-auto px-2 py-1.5 min-[720px]:flex-col min-[720px]:overflow-x-visible min-[720px]:py-2"
            >
              {sections.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="flex h-9 shrink-0 cursor-pointer items-center gap-3 rounded-sm px-2 text-body whitespace-nowrap text-list-ink-soft transition-[background-color,box-shadow,color] duration-150 hover:bg-list-hover hover:text-list-ink focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] motion-reduce:transition-none data-[state=active]:row-selected data-[state=active]:text-list-ink"
                >
                  <Icon className="size-pixel shrink-0 max-[719px]:hidden" aria-hidden="true" />
                  <span className="trim-cap">{label}</span>
                  {id === "resources" && resourcesSummary.attention && (
                    <span data-testid="resources-tab-attention" aria-hidden="true" className="ml-auto size-2 shrink-0 rounded-full bg-danger" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {sections.map(({ id, label }) => (
            <TabsContent key={id} value={id} className="shell-sheet shell-sheet-joined flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none max-[719px]:rounded-none">
              <header data-window-drag className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 pl-6">
                <h2 className="min-w-0 flex-1 truncate text-title font-semibold">{label}</h2>
                <DialogClose asChild>
                  <Button variant="ghost" size="icon" className="shrink-0" aria-label="Close">
                    <X aria-hidden="true" />
                  </Button>
                </DialogClose>
              </header>
              <div className="dialog-body-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pt-5 pb-6">
                {/* Rows keep their 16px padding, so the 8px inset puts every row's text on the 24px edge of the title. */}
                <div className="grid max-w-180 grid-cols-1 content-start gap-6">
                  <FlatSettingsGroups>{content[id]}</FlatSettingsGroups>
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
