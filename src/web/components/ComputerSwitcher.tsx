import type * as React from "react";
import type { DeviceKey } from "../devices.ts";
import type { RailComputer } from "../rail-model.ts";

export interface ComputerSwitcherProps {
  /** popover on the desktop PM column header, drawer on the phone. */
  variant: "popover" | "drawer";
  open: boolean;
  computers: readonly RailComputer[];
  selected: DeviceKey;
  /** The header button that opens the list. */
  trigger: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: DeviceKey) => void;
  /** Opens Settings on Computers. */
  onManage: () => void;
}

/**
 * Postcondition: lists every computer with its status dot, connection text, and ask badge, marks the selected one,
 * closes after a pick, and ends with Manage computers...; offline computers stay selectable for reading.
 */
export function ComputerSwitcher(props: ComputerSwitcherProps): React.ReactElement {
  throw new Error("Not implemented");
}
