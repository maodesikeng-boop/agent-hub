import { memo } from "react";
import { ProvidersSettings } from "./components/ProvidersSettings.tsx";
import type { SettingsBodies } from "./components/SettingsDialog.tsx";
import { FlatSettingsGroups } from "./components/SettingsList.tsx";
import { VendorSyncSettings } from "./components/VendorSyncSettings.tsx";
import { useClient } from "./device-scope.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "./devices.ts";
import { MobileSettings, type MobileSettingsProps } from "./mobile/settings/MobileSettings.tsx";
import { useHubQueryClient } from "./query-client.ts";
import { useFetchedQuota } from "./quota.ts";
import { useServerInfo } from "./server-info.tsx";
import { useProvidersSetting, useVendorSyncSetting } from "./settings-model.ts";
import { Surface, SurfaceOutlet } from "./shell-surfaces.tsx";

export const settingsBodies = {
  capabilities: <SurfaceOutlet id="settings:capabilities" />,
  resources: <SurfaceOutlet id="settings:resources" />,
  account: <SurfaceOutlet id="settings:account" />,
  providers: <SurfaceOutlet id="settings:providers" />,
} satisfies SettingsBodies;

function MobileWorkbenchSettings({ quotaReady, ...props }: MobileSettingsProps & { quotaReady: boolean }) {
  const current = useServerInfo().currentQuota === true;
  const { rows } = useFetchedQuota(useHubQueryClient(), useClient(), {
    enabled: current && quotaReady && props.section === undefined,
    current,
  });
  return <MobileSettings {...props} quota={current ? rows : props.quota} />;
}

export const WorkbenchSettings = memo(function WorkbenchSettings({ mobile, defaultProviderDevice, quotaReady, ...props }: Omit<MobileSettingsProps, "bodies" | "vendor"> & {
  mobile: boolean;
  defaultProviderDevice: DeviceKey;
  quotaReady: boolean;
}) {
  const currentDevice = useClient().device ?? LOCAL_DEVICE;
  const vendorSyncPage = props.section === "vendor-sync";
  const showProviders = props.section === "providers" || (!mobile && vendorSyncPage);
  const providers = useProvidersSetting({
    enabled: showProviders,
    devices: props.devices?.devices ?? null,
    defaultDeviceKey: vendorSyncPage ? currentDevice : defaultProviderDevice,
    selectionPage: vendorSyncPage ? "vendor-sync" : "providers",
  });
  const vendor = useVendorSyncSetting(providers.targetClient);
  return (
    <>
      {showProviders && (
        <Surface id="settings:providers">
          <FlatSettingsGroups flat={!mobile}>
            <ProvidersSettings mobile={mobile} model={providers} vendorSync={<VendorSyncSettings vendor={vendor} showScan={!mobile} />} />
          </FlatSettingsGroups>
        </Surface>
      )}
      {mobile && (
        <Surface id="settings:mobile">
          <MobileWorkbenchSettings {...props} bodies={settingsBodies} vendor={vendor} quotaReady={quotaReady} />
        </Surface>
      )}
    </>
  );
});
