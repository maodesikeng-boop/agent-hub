import { LOCAL_DEVICE, type DeviceKey, type DeviceStatus } from "./devices.ts";
import type { QuotaVendor } from "./selectors.ts";

// Invariant: rail data is derived only from the device list, the asking set, and quota usage; results are cached per input.

const EMPTY_RAIL_COMPUTERS: readonly RailComputer[] = [];
const railComputersCache = new WeakMap<readonly RailComputerInput[], WeakMap<ReadonlySet<string>, readonly RailComputer[]>>();
const quotaMeterCache = new WeakMap<readonly QuotaVendor[], QuotaMeter | null>();

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
  warning: boolean;
  full: boolean;
}

/**
 * Precondition: asking holds conversationKey values across every computer.
 * Postcondition: returns an empty array when computers is empty; otherwise one cell per computer in input order with
 * its ask count; returns the same array for the same inputs.
 */
export function railComputersOf(computers: readonly RailComputerInput[], asking: ReadonlySet<string>): readonly RailComputer[] {
  if (computers.length === 0) return EMPTY_RAIL_COMPUTERS;

  let byAsking = railComputersCache.get(computers);
  const hit = byAsking?.get(asking);
  if (hit !== undefined) return hit;

  const counts = new Map<DeviceKey, number>();
  for (const convKey of asking) {
    const slash = convKey.indexOf("/");
    const deviceKey = (slash === -1 ? LOCAL_DEVICE : convKey.slice(0, slash)) as DeviceKey;
    counts.set(deviceKey, (counts.get(deviceKey) ?? 0) + 1);
  }

  const cells: readonly RailComputer[] = computers.map((computer) => ({
    ...computer,
    badge: counts.get(computer.key) ?? 0,
  }));

  if (!byAsking) {
    byAsking = new WeakMap();
    railComputersCache.set(computers, byAsking);
  }
  byAsking.set(asking, cells);
  return cells;
}

/**
 * Postcondition: picks the window with the highest percent across vendors, keeping vendor order on ties, warns at 80% or
 * when the window warns, marks full at 100%, and returns null when no window reports usage; returns the same object for
 * the same quota array.
 */
export function quotaMeterOf(quota: readonly QuotaVendor[]): QuotaMeter | null {
  if (quotaMeterCache.has(quota)) return quotaMeterCache.get(quota)!;

  let best: QuotaMeter | null = null;
  for (const vendor of quota) {
    for (const win of vendor.windows) {
      const percent = Math.max(0, Math.min(100, Math.round(win.percent)));
      if (best === null || percent > best.percent) {
        const full = percent >= 100 || (vendor.exhausted && !vendor.windows.some((x) => x.percent >= 100));
        best = {
          vendorName: vendor.name,
          windowShort: win.short,
          percent,
          warning: win.warning || percent >= 80,
          full,
        };
      }
    }
  }

  quotaMeterCache.set(quota, best);
  return best;
}
