// Invariant: mobile Resources settings page delegates all state and rendering to ResourcesSettings without issuing requests on the parent settings home route.
import type { ReactNode } from "react";
import { ResourcesSettings } from "../../components/ResourcesSettings.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "../../devices.ts";
import type { DeviceSettings } from "../../settings-model.ts";

export interface ResourcesPageProps {
  readonly devices: DeviceSettings | null;
  readonly defaultDeviceKey?: DeviceKey;
}

/**
 * Precondition: rendered as the mobile #/settings/resources subpage inside SettingsPage.
 * Postcondition: renders ResourcesSettings without a redundant desktop title heading.
 */
export function ResourcesPage({ devices, defaultDeviceKey = LOCAL_DEVICE }: ResourcesPageProps): ReactNode {
  return <ResourcesSettings active devices={devices} defaultDeviceKey={defaultDeviceKey} titled={false} />;
}
