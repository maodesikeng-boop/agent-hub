import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../../src/shared/index.ts";
import { FLOWS } from "./flows.ts";
import { TESTER_BENCH_ALERT_RUNS } from "./limits.ts";
import type { BenchCapability, FlowObservation, FlowResult, FlowSpec, PreflightResult, RunRecord, Verdict } from "./types.ts";
import { alertsFor, classifyFlow, countsTowardRate, ExternalServiceError } from "./verdict.ts";
import type { VendorReadiness } from "./vendors.ts";

const flow = (id: string) => FLOWS.find((f) => f.id === id)!;
const ALL: BenchCapability[] = ["local_instance", "remote_instance", "remote_control", "feishu_bot", "feishu_driver", ...VENDOR_LIST.map(({ id }) => `vendor:${id}` as const)];

function ready(): VendorReadiness[] {
  return VENDOR_LIST.flatMap(({ id }) => (["local", "remote"] as const).map((instance) => ({ vendor: id, instance, status: "ready" as const, version: "1", detail: "", fix: "" })));
}

function pre(over: Partial<PreflightResult> = {}): PreflightResult {
  return { available: [...ALL], problems: [], coverage: ready(), ...over };
}

function obs(checks: Array<[string, boolean]>, over: Partial<FlowObservation> = {}): FlowObservation {
  return { checks: checks.map(([check, ok]) => ({ check, ok, detail: ok ? "fine" : "broke" })), externalErrors: [], metrics: {}, evidence: [], ...over };
}

const allPass = (spec: FlowSpec) => obs(spec.pass.map((p) => [p.check, true]));

describe("classifyFlow", () => {
  const turn = flow("model.turn.codex");
  const group = flow("feishu.group-round-trip");

  it("gives not_ready with the status and fix when a vendor is not installed or not signed in on the target computer", () => {
    const coverage = ready().map((c) => (c.vendor === "codex" && c.instance === "local" ? { ...c, status: "signed_out" as const, detail: "installed, not signed in", fix: "codex login --device-auth" } : c));
    expect(classifyFlow(turn, "local", allPass(turn), pre({ coverage }), ALL)).toEqual({ verdict: "not_ready", reason: expect.stringMatching(/codex on the local computer is signed_out .*fix: codex login --device-auth/) });
    expect(classifyFlow(turn, "local", allPass(turn), pre(), ALL).verdict).toBe("pass");
  });

  it("skips a planned coverage gap even when the CLI reports ready", () => {
    expect(classifyFlow(turn, "remote", allPass(turn), pre(), ALL)).toEqual({ verdict: "not_ready", reason: expect.stringMatching(/codex on the remote computer: accepted gap/) });
  });

  it("allows cross-device chat when only the remote Claude CLI is ready", () => {
    const crossDevice = flow("mesh.cross-device-chat");
    const coverage = ready().map((entry) => entry.vendor === "claude" && entry.instance === "local" ? { ...entry, status: "signed_out" as const } : entry);
    expect(classifyFlow(crossDevice, "local", allPass(crossDevice), pre({ coverage }), ALL).verdict).toBe("pass");
  });

  it("gives not_ready when a need is not configured on the bench, and never drops the flow", () => {
    const configured = ALL.filter((c) => c !== "feishu_driver");
    expect(classifyFlow(group, "local", null, pre(), configured)).toEqual({ verdict: "not_ready", reason: "the bench has no feishu_driver yet" });
    expect(classifyFlow(turn, "remote", null, pre(), ["local_instance", "vendor:codex"])).toEqual({ verdict: "not_ready", reason: "the bench has no remote_instance yet" });
  });

  it("gives env_unavailable when a configured need failed preflight", () => {
    const p = pre({ available: ALL.filter((c) => c !== "remote_instance"), problems: [{ service: "relay", detail: "remote_instance: device_offline" }] });
    expect(classifyFlow(group, "local", null, p, ALL)).toEqual({ verdict: "env_unavailable", reason: "relay: remote_instance: device_offline" });
  });

  it("gives env_unavailable when the runner reported an external error, even with failed checks", () => {
    const o = obs([["not-offline", false]], { externalErrors: [{ service: "feishu", detail: "HTTP 503" }] });
    expect(classifyFlow(group, "local", o, pre(), ALL)).toEqual({ verdict: "env_unavailable", reason: "feishu: HTTP 503" });
  });

  it("gives env_unavailable when the runner threw an error that names an external service", () => {
    expect(classifyFlow(group, "local", new ExternalServiceError("bench", "no driver"), pre(), ALL)).toEqual({ verdict: "env_unavailable", reason: "bench: no driver" });
  });

  it("gives quota when the runner reported vendor trouble", () => {
    const o = obs([["reply-arrives", false]], { vendorTrouble: { vendor: "codex", kind: "quota", detail: "usage limit" } });
    expect(classifyFlow(turn, "local", o, pre(), ALL)).toEqual({ verdict: "quota", reason: "codex quota: usage limit" });
  });

  it("gives pass when every check is ok", () => {
    expect(classifyFlow(group, "local", allPass(group), pre(), ALL)).toEqual({ verdict: "pass", reason: "" });
  });

  it("gives product_fail with the first failed check as the reason", () => {
    const o = obs([["not-offline", true], ["reply-arrives", false], ["reply-text", false], ["no-recall", true]]);
    expect(classifyFlow(group, "local", o, pre(), ALL)).toEqual({ verdict: "product_fail", reason: "reply-arrives: broke" });
    expect(classifyFlow(group, "local", obs([["not-offline", true]]), pre(), ALL)).toEqual({ verdict: "product_fail", reason: "reply-arrives: the runner did not report this check" });
  });

  it("gives product_fail when the runner threw an error that names no external service", () => {
    expect(classifyFlow(group, "local", new Error("no Feishu project group"), pre(), ALL)).toEqual({ verdict: "product_fail", reason: "the runner threw: no Feishu project group" });
  });
});

function result(id: string, verdict: Verdict): FlowResult {
  return { id, verdict, reason: `${verdict} reason`, checks: [], externalErrors: [], metrics: {}, evidence: [], startedAt: "", durationMs: 1 };
}

function run(n: number, results: FlowResult[], cadence: RunRecord["cadence"] = "nightly", coverage = ready()): RunRecord {
  return { runId: `r${n}`, cadence, startedAt: "", finishedAt: "", commits: {}, preflight: { available: [], problems: [], coverage }, results };
}

const series = (id: string, verdicts: Verdict[], cadence: RunRecord["cadence"] = "nightly") => verdicts.map((v, i) => run(i, [result(id, v)], cadence));

describe("alertsFor", () => {
  it("alerts a pr or rc run on any product_fail in that run", () => {
    for (const cadence of ["pr", "rc"] as const) {
      expect(alertsFor(series("model.turn.claude@local", ["product_fail"], cadence), FLOWS, cadence)).toEqual([{ flowId: "model.turn.claude@local", kind: "product", reason: "product_fail reason", runIds: ["r0"] }]);
    }
  });

  it("does not alert a nightly consecutive flow on a single product_fail", () => {
    expect(alertsFor(series("model.turn.claude@local", ["pass", "product_fail"]), FLOWS, "nightly")).toEqual([]);
  });

  it("alerts a nightly consecutive flow after the configured number of trailing product_fail runs", () => {
    const alerts = alertsFor(series("model.turn.claude@local", ["pass", "product_fail", "product_fail"]), FLOWS, "nightly");
    expect(alerts).toEqual([expect.objectContaining({ flowId: "model.turn.claude@local", kind: "product", runIds: ["r1", "r2"] })]);
  });

  it("alerts a nightly rate flow when passes in the window fall below the minimum", () => {
    expect(alertsFor(series("mesh.cold-dial", ["pass", "pass", "pass", "pass", "pass", "pass", "product_fail"]), FLOWS, "nightly")).toEqual([]);
    const alerts = alertsFor(series("mesh.cold-dial", ["pass", "pass", "product_fail", "pass", "pass", "pass", "product_fail"]), FLOWS, "nightly");
    expect(alerts).toEqual([expect.objectContaining({ flowId: "mesh.cold-dial", kind: "product", reason: expect.stringMatching(/^5 of the last 7 runs passed/) })]);
  });

  it("ignores quota and not_ready results when counting a streak or a rate window", () => {
    expect(alertsFor(series("model.turn.claude@local", ["product_fail", "quota", "not_ready", "product_fail"]), FLOWS, "nightly")).toEqual([expect.objectContaining({ kind: "product", runIds: ["r0", "r3"] })]);
    expect(alertsFor(series("model.turn.claude@local", ["product_fail", "quota"]), FLOWS, "nightly")).toEqual([]);
  });

  it("gives a coverage alert on every run for each open vendor gap, and none for an accepted gap", () => {
    const coverage = ready().map((c) =>
      c.vendor === "pi" && c.instance === "local" ? { ...c, status: "not_installed" as const, fix: "install pi" } : c.vendor === "kimi" ? { ...c, status: "signed_out" as const, acceptedGap: "no account" } : c,
    );
    const alerts = alertsFor([run(0, [], "nightly", coverage)], FLOWS, "nightly");
    expect(alerts).toEqual([expect.objectContaining({ flowId: "vendor.pi@local", kind: "coverage", reason: expect.stringContaining("fix: install pi") })]);
    const broken = ready().map((c) => (c.vendor === "kimi" && c.instance === "remote" ? { ...c, status: "install_failed" as const } : c));
    expect(alertsFor([run(0, [], "pr", broken)], FLOWS, "pr").map((a) => a.flowId)).toEqual(["vendor.kimi@remote"]);
  });

  it("gives a bench alert after TESTER_BENCH_ALERT_RUNS env_unavailable runs in a row", () => {
    const below = Array<Verdict>(TESTER_BENCH_ALERT_RUNS - 1).fill("env_unavailable");
    expect(alertsFor(series("feishu.dm-router", ["pass", ...below]), FLOWS, "nightly")).toEqual([]);
    const alerts = alertsFor(series("feishu.dm-router", ["pass", ...below, "env_unavailable"]), FLOWS, "nightly");
    expect(alerts).toEqual([expect.objectContaining({ flowId: "feishu.dm-router", kind: "bench" })]);
  });

  it("returns at most one alert per flow", () => {
    const verdicts = Array<Verdict>(7).fill("product_fail");
    const alerts = alertsFor(series("mesh.cold-dial", verdicts), FLOWS, "nightly");
    expect(alerts.filter((a) => a.flowId === "mesh.cold-dial")).toHaveLength(1);
  });

  it("ignores flows that are no longer in the catalog", () => {
    expect(alertsFor(series("feishu.retired-flow", ["product_fail"], "pr"), FLOWS, "pr")).toEqual([]);
  });
});

describe("countsTowardRate", () => {
  it("counts pass and product_fail only", () => {
    expect((["pass", "product_fail", "env_unavailable", "quota", "not_ready"] as const).map((verdict) => countsTowardRate({ verdict }))).toEqual([true, true, false, false, false]);
  });
});
