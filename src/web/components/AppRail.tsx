import type * as React from "react";
import type { DeviceKey } from "../devices.ts";
import type { QuotaMeter, RailComputer } from "../rail-model.ts";
import type { QuotaVendor } from "../selectors.ts";

export interface AppRailRouter {
  active: boolean;
  pendingCount: number;
  working: boolean;
  onSelect: () => void;
}

export interface AppRailProps {
  router: AppRailRouter;
  /** Empty while only one computer is linked; the rail then shows no computer cells. */
  computers: readonly RailComputer[];
  /** The computer whose PM column is showing, or null on the Router page. */
  selectedComputer: DeviceKey | null;
  meter: QuotaMeter | null;
  quota: readonly QuotaVendor[];
  quotaFetchable: boolean;
  onSelectComputer: (key: DeviceKey) => void;
  onOpenSettings: () => void;
  onOpenUpdates: () => void;
  /** Opens Settings on Computers when an account is linked, otherwise on Security & Access. */
  onOpenAccount: () => void;
}

/**
 * Postcondition: renders the 4.5rem honey rail with the Router cell, computer cells, the Update cell while an update waits,
 * the usage meter that opens the usage popover, the Settings gear with the resources dot, and the account cell; in the
 * native macOS app the top clears the traffic lights and drags the window.
 */
export function AppRail(props: AppRailProps): React.ReactElement {
  throw new Error("Not implemented");
}
