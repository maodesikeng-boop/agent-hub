import type { DeviceKey, DeviceStatus } from "./devices.ts";
import type { QuotaVendor } from "./selectors.ts";

// Invariant: rail data is derived only from the device list, the asking set, and quota usage; results are cached per input.

export const RAIL_QUOTA_CELLS = 5;

export interface RailComputerInput {
  key: DeviceKey;
  name: string;
  platform: string;
  status: DeviceStatus;
}

export interface RailComputer extends RailComputerInput {
  /** Unanswered asks on this computer. */
  badge: number;
}

export interface QuotaMeter {
  vendorName: string;
  windowShort: string;
  percent: number;
  /** Filled cells out of RAIL_QUOTA_CELLS. */
  cells: number;
  warning: boolean;
  full: boolean;
}

/**
 * Precondition: asking holds conversationKey values across every computer.
 * Postcondition: returns an empty array while fewer than two computers are linked; otherwise one cell per computer in
 * input order with its ask count; returns the same array for the same inputs.
 */
export function railComputersOf(computers: readonly RailComputerInput[], asking: ReadonlySet<string>): readonly RailComputer[] {
  throw new Error("Not implemented");
}

/**
 * Postcondition: picks the window with the highest percent across vendors, keeping vendor order on ties, fills
 * ceil(percent / 20) cells, warns at 80% or when the window warns, marks full at 100%, and returns null when no window
 * reports usage; returns the same object for the same quota array.
 */
export function quotaMeterOf(quota: readonly QuotaVendor[]): QuotaMeter | null {
  throw new Error("Not implemented");
}
