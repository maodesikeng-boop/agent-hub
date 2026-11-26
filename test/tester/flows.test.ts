import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../../src/shared/index.ts";
import { FLOWS, matchesGlob, RUNNERS, selectFlows } from "./flows.ts";
import type { BenchCapability } from "./types.ts";

const PROVIDABLE: readonly BenchCapability[] = ["local_instance", "remote_instance", "remote_control", "feishu_bot", "feishu_driver", ...VENDOR_LIST.map(({ id }) => `vendor:${id}` as const)];

describe("FLOWS catalog", () => {
  it("has unique ids in area.name form", () => {
    const ids = FLOWS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const flow of FLOWS) expect(flow.id).toMatch(new RegExp(`^${flow.area}\\.[a-z0-9.-]+$`));
  });

  it("gives every non-manual flow exactly one runner and every runner a flow", () => {
    const auto = FLOWS.filter((f) => !f.manual).map((f) => f.id).sort();
    expect(Object.keys(RUNNERS).sort()).toEqual(auto);
    for (const flow of FLOWS.filter((f) => f.manual)) expect(RUNNERS[flow.id]).toBeUndefined();
  });

  it("gives every flow at least one pass check, one evidence file, and one cadence", () => {
    for (const flow of FLOWS) {
      expect(flow.pass.length, flow.id).toBeGreaterThan(0);
      expect(flow.evidence.length, flow.id).toBeGreaterThan(0);
      expect(flow.cadences.length, flow.id).toBeGreaterThan(0);
      expect(new Set(flow.pass.map((p) => p.check)).size, flow.id).toBe(flow.pass.length);
    }
  });

  it("gives every nightly flow on the real network a rate tolerance", () => {
    for (const flow of FLOWS.filter((f) => f.tolerance.kind === "rate")) expect(flow.boundaries.network, flow.id).toBe("relay");
    for (const flow of FLOWS.filter((f) => f.cadences.includes("nightly") && f.escapes.some((e) => e === "#409" || e === "#415"))) expect(flow.tolerance.kind, flow.id).toBe("rate");
  });

  it("lists a trigger glob for every flow that runs on pr", () => {
    for (const flow of FLOWS.filter((f) => f.cadences.includes("pr"))) expect(flow.triggers.length, flow.id).toBeGreaterThan(0);
  });

  it("names only capabilities the bench can provide", () => {
    for (const flow of FLOWS) for (const need of flow.needs) expect(PROVIDABLE, `${flow.id} needs ${need}`).toContain(need);
  });

  it("generates one turn flow per registered vendor", () => {
    for (const { id } of VENDOR_LIST) expect(FLOWS.find((f) => f.id === `model.turn.${id}`)?.perInstance).toBe(true);
  });
});

describe("selectFlows", () => {
  it("keeps catalog order and filters by cadence", () => {
    const nightly = selectFlows(FLOWS, { cadence: "nightly" });
    expect(nightly.map((f) => f.id)).toEqual(FLOWS.filter((f) => f.cadences.includes("nightly")).map((f) => f.id));
    expect(nightly.some((f) => f.id === "model.worker-round-trip")).toBe(false);
    expect(selectFlows(FLOWS, { cadence: "rc" }).some((f) => f.manual)).toBe(true);
  });

  it("narrows to named ids and throws on an unknown id", () => {
    expect(selectFlows(FLOWS, { cadence: "rc", ids: ["mesh.cold-dial", "feishu.dm-router"] }).map((f) => f.id)).toEqual(["feishu.dm-router", "mesh.cold-dial"]);
    expect(() => selectFlows(FLOWS, { cadence: "rc", ids: ["mesh.nope"] })).toThrow(/unknown flow: mesh\.nope/);
  });

  it("selects pr flows whose triggers match a changed path", () => {
    const ids = selectFlows(FLOWS, { cadence: "pr", changedPaths: ["src/daemon/feishu/stream-cards.ts"] }).map((f) => f.id);
    expect(ids).toContain("feishu.failed-turn-card");
    expect(ids).not.toContain("mesh.cold-dial");
    expect(selectFlows(FLOWS, { cadence: "pr", changedPaths: ["src/vendors/kimi/driver.ts"] }).map((f) => f.id)).toContain("model.turn.kimi");
  });

  it("selects no pr flows when no changed path matches", () => {
    expect(selectFlows(FLOWS, { cadence: "pr", changedPaths: ["README.md"] })).toEqual([]);
    expect(selectFlows(FLOWS, { cadence: "pr" })).toEqual([]);
  });
});

describe("matchesGlob", () => {
  it("lets ** span directories and * stay within one", () => {
    expect(matchesGlob("src/daemon/feishu/a/b.ts", "src/daemon/feishu/**")).toBe(true);
    expect(matchesGlob("src/daemon/feishu.ts", "src/daemon/feishu/**")).toBe(false);
    expect(matchesGlob("migrations/0001.sql", "migrations/*.sql")).toBe(true);
    expect(matchesGlob("migrations/x/0001.sql", "migrations/*.sql")).toBe(false);
    expect(matchesGlob("src\\daemon\\daemon.ts", "src/daemon/daemon.ts")).toBe(true);
  });
});
