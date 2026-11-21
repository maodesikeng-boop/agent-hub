// Invariant: discard actions always open a confirmation dialog before removing user-owned files, and routine quota denominators stay hidden below RESOURCES_WARN_RATIO.
import type { ReactNode } from "react";
import type { DeviceKey } from "../devices.ts";
import type { DeviceSettings } from "../settings-model.ts";

export interface ResourcesSettingsProps {
  readonly active?: boolean;
  readonly devices?: DeviceSettings | null;
  readonly defaultDeviceKey?: DeviceKey;
  readonly titled?: boolean;
}

/**
 * Precondition: rendered inside SettingsDialog (desktop) or ResourcesPage (mobile).
 * Postcondition: renders Needs attention held items (Keep / Discard...), Overview totals (Database, Storage, Worktrees & branches, Processes), and collapsed Kept by you rows matching the UI standard.
 */
export function ResourcesSettings(_props: ResourcesSettingsProps): ReactNode {
  throw new Error("Not implemented");
}
