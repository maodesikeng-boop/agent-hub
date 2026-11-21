// Invariant: mobile Resources settings page delegates all state and rendering to ResourcesSettings without issuing requests on the parent settings home route.
import type { ReactNode } from "react";
import type { DeviceKey } from "../../devices.ts";
import type { DeviceSettings } from "../../settings-model.ts";

export interface ResourcesPageProps {
  readonly devices: DeviceSettings | null;
  readonly defaultDeviceKey?: DeviceKey;
}

/**
 * Precondition: rendered as the mobile #/settings/resources subpage inside SettingsPage.
 * Postcondition: renders ResourcesSettings without a redundant desktop title heading.
 */
export function ResourcesPage(_props: ResourcesPageProps): ReactNode {
  throw new Error("Not implemented");
}
