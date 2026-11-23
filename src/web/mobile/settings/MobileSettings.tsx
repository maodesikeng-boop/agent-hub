import { Activity, memo, type ReactNode } from "react";
import { ArrowLeftRight, Bell, Blocks, Cable, Download, Loader2, Monitor, QrCode, Server, Smartphone, Type } from "../../ui/icons.ts";
import { CapabilitiesSettings } from "../../components/CapabilitiesSettings.tsx";
import { SettingsGroup } from "../../components/SettingsList.tsx";
import { UpdateSettings } from "../../components/UpdateSettings.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "../../devices.ts";
import { formatQuotaReset } from "../../format.ts";
import { cn } from "../../lib/utils.ts";
import type { NotifySettings } from "../../notify.ts";
import { useCachedResourcesSummary } from "../../resources-model.ts";
import type { SettingsSection } from "../../route.ts";
import type { QuotaVendor } from "../../selectors.ts";
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
  quota?: readonly QuotaVendor[];
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

function UsageGroup({ quota }: { quota: readonly QuotaVendor[] }) {
  const vendors = quota.filter((v) => v.windows.length > 0);
  if (vendors.length === 0) return null;
  return (
    <SettingsGroup title="Usage">
      {vendors.map((vendor) => (
        <div key={vendor.id} className="grid gap-2.5 px-4 py-3">
          <div className="text-minor font-semibold text-foreground">{vendor.group ? `${vendor.name} (${vendor.group})` : vendor.name}</div>
          {vendor.windows.map((w) => {
            const full = w.percent >= 100 || (vendor.exhausted && !vendor.windows.some((x) => x.percent >= 100));
            const barClass = full ? "bg-danger" : w.warning || w.percent >= 80 ? "bg-caution" : "bg-rail-ink";
            const fillWidth = Math.min(100, Math.max(0, w.percent));
            return (
              <div key={w.key} className="grid gap-1.5">
                <div className="flex items-baseline gap-2 text-minor">
                  <span className="shrink-0 font-medium text-foreground">{w.short}</span>
                  {w.resetsAt !== null && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">Resets {formatQuotaReset(w.resetsAt)}</span>
                  )}
                  <span className={cn("ml-auto shrink-0 font-semibold tabular-nums", full ? "text-danger" : "text-foreground")}>{w.percent}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${vendor.name} ${w.short} usage`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={w.percent}
                  className="h-2 overflow-hidden border border-border-strong bg-panel"
                >
                  <div className={cn("h-full", barClass)} style={{ width: `${fillWidth}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </SettingsGroup>
  );
}

function SettingsHome({
  notify,
  devices,
  quota,
  vendorSynced,
  onOpen,
  onBack,
}: {
  notify: NotifySettings;
  devices: DeviceSettings | null;
  quota: readonly QuotaVendor[];
  vendorSynced: boolean;
  onOpen: (section: SettingsSection) => void;
  onBack?: () => void;
}) {
  const { label: scaleLabel } = useUiScaleSetting();
  const providers = useCachedProvidersSummary();
  const resources = useCachedResourcesSummary();
  const browsers = useCachedBrowserSessionsSummary();
  const update = useCachedUpdateStatus();
  const updateReminder = updateReminderOf(update, useDismissedUpdate());
  return (
    <SettingsPage title="Settings" home {...(onBack !== undefined ? { onBack } : {})}>
      <UsageGroup quota={quota} />
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

const NO_QUOTA: readonly QuotaVendor[] = [];

// App rerenders on every streaming frame; all props here are stable.
export const MobileSettings = memo(function MobileSettings({
  section,
  notify,
  devices,
  quota = NO_QUOTA,
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
        <SettingsHome notify={notify} devices={devices} quota={quota} vendorSynced={vendor.lastSummary !== null} onOpen={onOpen} />
      </Activity>
      {spec !== null && (
        <SettingsPage key={section} title={spec.title} onBack={onBack} footer={spec.footer?.(ctx)}>
          {spec.render(ctx)}
        </SettingsPage>
      )}
    </div>
  );
});
