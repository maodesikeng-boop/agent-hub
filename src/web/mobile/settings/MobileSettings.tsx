import { Activity, memo, type ReactNode } from "react";
import { ArrowLeftRight, Bell, Blocks, Cable, Download, Loader2, Monitor, QrCode, Server, Smartphone, Type } from "../../ui/icons.ts";
import { CapabilitiesSettings } from "../../components/CapabilitiesSettings.tsx";
import { SettingsGroup } from "../../components/SettingsList.tsx";
import { UpdateSettings } from "../../components/UpdateSettings.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "../../devices.ts";
import type { NotifySettings } from "../../notify.ts";
import { useCachedResourcesSummary } from "../../resources-model.ts";
import type { SettingsSection } from "../../route.ts";
import {
  describeComputersSummary,
  describeNotifySummary,
  useCachedBrowserSessionsSummary,
  useCachedProvidersSummary,
  useUiScaleSetting,
  useVendorSyncSetting,
  type DeviceSettings,
} from "../../settings-model.ts";
import { updateReminderOf, useCachedUpdateStatus, useDismissedUpdate } from "../../update-model.ts";
import { BrowsersPage } from "./BrowsersPage.tsx";
import { ComputersPage } from "./ComputersPage.tsx";
import { NotificationsPage } from "./NotificationsPage.tsx";
import { ProvidersPage } from "./ProvidersPage.tsx";
import { ResourcesPage } from "./ResourcesPage.tsx";
import { ScalePage } from "./ScalePage.tsx";
import { SettingsNavRow } from "./SettingsNavRow.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { SignInPage } from "./SignInPage.tsx";
import { VendorSyncFooter, VendorSyncPage, type VendorSync } from "./VendorSyncPage.tsx";

export interface MobileSettingsProps {
  section: SettingsSection | undefined;
  notify: NotifySettings;
  devices: DeviceSettings | null;
  defaultProviderDevice?: DeviceKey;
  onOpen: (section: SettingsSection) => void;
  onBack: () => void;
  onSignedOut?: () => void;
}

interface SubpageContext {
  notify: NotifySettings;
  devices: DeviceSettings | null;
  defaultProviderDevice: DeviceKey;
  vendor: VendorSync;
  onSignedOut?: () => void;
}

interface SubpageSpec {
  title: string;
  render: (ctx: SubpageContext) => ReactNode;
  footer?: (ctx: SubpageContext) => ReactNode;
}

const withDevices = (ctx: SubpageContext, render: (devices: DeviceSettings) => ReactNode) =>
  ctx.devices === null ? (
    <div className="flex min-h-24 items-center justify-center">
      <Loader2 className="size-pixel text-muted-foreground" aria-label="Loading" />
    </div>
  ) : (
    render(ctx.devices)
  );

const SUBPAGES: Record<SettingsSection, SubpageSpec> = {
  scale: { title: "Interface scale", render: () => <ScalePage /> },
  notifications: { title: "Notifications", render: (ctx) => <NotificationsPage notify={ctx.notify} /> },
  updates: { title: "Updates", render: () => <UpdateSettings titled={false} /> },
  providers: {
    title: "Providers",
    render: (ctx) => <ProvidersPage devices={ctx.devices} defaultDeviceKey={ctx.defaultProviderDevice} />,
  },
  "vendor-sync": {
    title: "Vendor sync",
    render: (ctx) => <VendorSyncPage vendor={ctx.vendor} />,
    footer: (ctx) => (ctx.vendor.preview === null ? null : <VendorSyncFooter vendor={ctx.vendor} />),
  },
  capabilities: { title: "Capabilities", render: () => <CapabilitiesSettings /> },
  resources: {
    title: "Resources",
    render: (ctx) => <ResourcesPage devices={ctx.devices} defaultDeviceKey={ctx.defaultProviderDevice} />,
  },
  computers: { title: "Computers", render: (ctx) => withDevices(ctx, (devices) => <ComputersPage devices={devices} />) },
  "sign-in": { title: "Sign in on another device", render: () => <SignInPage /> },
  browsers: { title: "Signed-in browsers", render: (ctx) => <BrowsersPage {...(ctx.onSignedOut !== undefined ? { onSignedOut: ctx.onSignedOut } : {})} /> },
};

function SettingsHome({
  notify,
  devices,
  vendorSynced,
  onOpen,
  onBack,
}: {
  notify: NotifySettings;
  devices: DeviceSettings | null;
  vendorSynced: boolean;
  onOpen: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  const { label: scaleLabel } = useUiScaleSetting();
  const providers = useCachedProvidersSummary();
  const resources = useCachedResourcesSummary();
  const browsers = useCachedBrowserSessionsSummary();
  const update = useCachedUpdateStatus();
  const updateReminder = updateReminderOf(update, useDismissedUpdate());
  return (
    <SettingsPage title="Settings" home onBack={onBack}>
      <SettingsGroup title="General">
        <SettingsNavRow icon={<Type aria-hidden="true" />} label="Interface scale" summary={scaleLabel} onClick={() => onOpen("scale")} />
        <SettingsNavRow icon={<Bell aria-hidden="true" />} label="Notifications" summary={describeNotifySummary(notify)} onClick={() => onOpen("notifications")} />
        <SettingsNavRow
          icon={<Download aria-hidden="true" />}
          label="Updates"
          {...(update ? { summary: `v${update.currentVersion}` } : {})}
          attention={updateReminder !== null}
          attentionTestId="update-attention"
          onClick={() => onOpen("updates")}
        />
      </SettingsGroup>
      <SettingsGroup title="Providers">
        <SettingsNavRow
          icon={<Blocks aria-hidden="true" />}
          label="Providers"
          summary={providers.summary}
          attention={providers.attention}
          attentionTestId="providers-attention"
          onClick={() => onOpen("providers")}
        />
        <SettingsNavRow
          icon={<ArrowLeftRight aria-hidden="true" />}
          label="Vendor sync"
          {...(vendorSynced ? { summary: "Synced" } : {})}
          onClick={() => onOpen("vendor-sync")}
        />
      </SettingsGroup>
      <SettingsGroup title="Capabilities">
        <SettingsNavRow icon={<Cable aria-hidden="true" />} label="Capabilities" onClick={() => onOpen("capabilities")} />
      </SettingsGroup>
      <SettingsGroup title="Resources">
        <SettingsNavRow
          icon={<Server aria-hidden="true" />}
          label="Resources"
          summary={resources.summary}
          attention={resources.attention}
          attentionTestId="resources-attention"
          onClick={() => onOpen("resources")}
        />
      </SettingsGroup>
      {devices !== null && (
        <SettingsGroup title="Computers">
          <SettingsNavRow icon={<Monitor aria-hidden="true" />} label="Computers" summary={describeComputersSummary(devices)} onClick={() => onOpen("computers")} />
        </SettingsGroup>
      )}
      <SettingsGroup title="Security & Access">
        <SettingsNavRow icon={<QrCode aria-hidden="true" />} label="Sign in on another device" onClick={() => onOpen("sign-in")} />
        <SettingsNavRow
          icon={<Smartphone aria-hidden="true" />}
          label="Signed-in browsers"
          summary={browsers.summary}
          onClick={() => onOpen("browsers")}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

// App rerenders on every streaming frame; all props here are stable.
export const MobileSettings = memo(function MobileSettings({
  section,
  notify,
  devices,
  defaultProviderDevice = LOCAL_DEVICE,
  onOpen,
  onBack,
  onSignedOut,
}: MobileSettingsProps) {
  const vendor = useVendorSyncSetting();
  const spec = section === undefined ? null : SUBPAGES[section];
  const ctx: SubpageContext = {
    notify,
    devices,
    defaultProviderDevice,
    vendor,
    ...(onSignedOut !== undefined ? { onSignedOut } : {}),
  };
  return (
    <div data-testid="mobile-settings" className="flex h-full min-w-0 flex-1 flex-col">
      <Activity mode={spec === null ? "visible" : "hidden"}>
        <SettingsHome notify={notify} devices={devices} vendorSynced={vendor.lastSummary !== null} onOpen={onOpen} onBack={onBack} />
      </Activity>
      {spec !== null && (
        <SettingsPage key={section} title={spec.title} onBack={onBack} footer={spec.footer?.(ctx)}>
          {spec.render(ctx)}
        </SettingsPage>
      )}
    </div>
  );
});
