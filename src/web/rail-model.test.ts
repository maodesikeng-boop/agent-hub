import { describe, expect, it } from "vitest";
import { LOCAL_DEVICE } from "./devices.ts";
import { quotaMeterOf, railComputersOf, type RailComputerInput } from "./rail-model.ts";
import type { QuotaVendor } from "./selectors.ts";

describe("railComputersOf", () => {
  const mac: RailComputerInput = { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online" };
  const office: RailComputerInput = { key: "tokyo", name: "Office Mini", platform: "linux", status: "offline" };

  it("returns no cells when computers is empty and one cell on single-computer setups", () => {
    expect(railComputersOf([], new Set())).toEqual([]);
    const single = railComputersOf([mac], new Set(["1"]));
    expect(single.map((c) => ({ key: c.key, badge: c.badge }))).toEqual([{ key: LOCAL_DEVICE, badge: 1 }]);
  });

  it("returns one cell per computer in device order once two are linked", () => {
    const cells = railComputersOf([mac, office], new Set());
    expect(cells.map((c) => c.key)).toEqual([LOCAL_DEVICE, "tokyo"]);
    expect(cells.map((c) => c.badge)).toEqual([0, 0]);
  });

  it("counts asks per computer, including the local computer's unprefixed keys", () => {
    const asking = new Set(["1", "4", "tokyo/9", "tokyo/11", "tokyo/12", "other/2"]);
    const cells = railComputersOf([mac, office], asking);
    expect(cells.map((c) => c.badge)).toEqual([2, 3]);
  });

  it("returns the same array for the same inputs", () => {
    const computers = [mac, office];
    const asking = new Set(["1", "tokyo/9"]);
    expect(railComputersOf(computers, asking)).toBe(railComputersOf(computers, asking));
  });
});

describe("quotaMeterOf", () => {
  it("picks the fullest window across vendors and keeps vendor order on ties", () => {
    const quota: QuotaVendor[] = [
      {
        id: "claude",
        name: "Claude Code",
        exhausted: false,
        windows: [
          { key: "five_hour", short: "5h", percent: 45, resetsAt: null, warning: false },
          { key: "seven_day", short: "7d", percent: 60, resetsAt: null, warning: false },
        ],
      },
      {
        id: "codex",
        name: "Codex",
        exhausted: false,
        windows: [{ key: "five_hour", short: "5h", percent: 60, resetsAt: null, warning: false }],
      },
    ];
    expect(quotaMeterOf(quota)).toEqual({
      vendorName: "Claude Code",
      windowShort: "7d",
      percent: 60,
      warning: false,
      full: false,
    });
    expect(quotaMeterOf(quota)).toBe(quotaMeterOf(quota));
  });

  it("warns at 80% and when the window itself warns, and marks full at 100%", () => {
    const warnByThreshold: QuotaVendor[] = [
      { id: "v", name: "Vendor", exhausted: false, windows: [{ key: "w", short: "5h", percent: 80, resetsAt: null, warning: false }] },
    ];
    expect(quotaMeterOf(warnByThreshold)).toMatchObject({ warning: true, full: false });

    const warnByFlag: QuotaVendor[] = [
      { id: "v", name: "Vendor", exhausted: false, windows: [{ key: "w", short: "5h", percent: 30, resetsAt: null, warning: true }] },
    ];
    expect(quotaMeterOf(warnByFlag)).toMatchObject({ warning: true, full: false });

    const full: QuotaVendor[] = [
      { id: "v", name: "Vendor", exhausted: true, windows: [{ key: "w", short: "5h", percent: 100, resetsAt: null, warning: true }] },
    ];
    expect(quotaMeterOf(full)).toMatchObject({ warning: true, full: true, percent: 100 });
  });

  it("returns null when no window reports usage", () => {
    expect(quotaMeterOf([])).toBeNull();
    expect(quotaMeterOf([{ id: "v", name: "Vendor", exhausted: false, windows: [] }])).toBeNull();
  });
});
