import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../../src/shared/index.ts";
import { FLOWS } from "./flows.ts";
import { TESTER_SUMMARY_TEXT_MAX_CHARS } from "./limits.ts";
import { renderSummary, safeText, summarize } from "./report.ts";
import type { Alert, FlowResult, RunRecord, Verdict } from "./types.ts";
import { withRecipe } from "./vendors.ts";

const result = (id: string, verdict: Verdict, reason = ""): FlowResult => ({ id, verdict, reason, checks: [], externalErrors: [], metrics: {}, evidence: [], startedAt: "", durationMs: 1234 });

function record(cadence: RunRecord["cadence"], results: FlowResult[]): RunRecord {
  const coverage = VENDOR_LIST.flatMap(({ id }) =>
    (["local", "remote"] as const).map((instance) => withRecipe({ vendor: id, instance, status: id === "kimi" ? "signed_out" : "ready", version: "1.0", detail: "", fix: id === "kimi" ? "kimi login" : "" })),
  );
  return { runId: "20261123T233000Z-nightly", cadence, startedAt: "2026-11-23T23:30:00Z", finishedAt: "2026-11-23T23:42:00Z", commits: { mac: "a".repeat(40) }, preflight: { available: [], problems: [], coverage }, results };
}

const product: Alert = { flowId: "mesh.cold-dial", kind: "product", reason: "4 of the last 7 runs passed", runIds: ["r1"] };
const bench: Alert = { flowId: "feishu.dm-router", kind: "bench", reason: "env_unavailable in 3 runs", runIds: ["r1"] };

describe("summarize", () => {
  it("is alert when any alert is a product alert", () => {
    expect(summarize(record("nightly", []), [bench, product], "/runs/x").status).toBe("alert");
  });

  it("is bench when only bench alerts exist", () => {
    expect(summarize(record("nightly", []), [bench, { ...bench, kind: "coverage" }], "/runs/x").status).toBe("bench");
  });

  it("is clean with no alerts", () => {
    expect(summarize(record("nightly", []), [], "/runs/x").status).toBe("clean");
  });

  it("counts results by verdict", () => {
    const s = summarize(record("nightly", [result("a", "pass"), result("b", "pass"), result("c", "not_ready")]), [], "/runs/x");
    expect(s.counts).toEqual({ pass: 2, product_fail: 0, env_unavailable: 0, quota: 0, not_ready: 1 });
  });
});

describe("renderSummary", () => {
  const rec = record("rc", [result("mesh.cold-dial", "product_fail", "dials-succeed: 7 of 10"), result("model.turn.kimi@local", "not_ready", "accepted gap")]);
  const md = renderSummary(summarize(rec, [product], "/runs/x"), rec, FLOWS);

  it("starts with the status and counts", () => {
    expect(md.split("\n")[0]).toBe("# Tester run 20261123T233000Z-nightly: ALERT (0 pass, 1 product_fail, 0 env_unavailable, 0 quota, 1 not_ready)");
  });

  it("lists each alert and one row per flow", () => {
    expect(md).toContain("- [product] mesh.cold-dial: 4 of the last 7 runs passed (runs r1)");
    expect(md).toContain("| mesh.cold-dial | product_fail | dials-succeed: 7 of 10 | 1.2 s |");
    expect(md).toContain("| model.turn.kimi@local | not_ready | accepted gap | 1.2 s |");
    for (const { label } of VENDOR_LIST) expect(md.match(new RegExp(`^\\| ${label} \\|`, "gm"))).toHaveLength(2);
    expect(md).toMatch(/\| Kimi Code \| local \| accepted gap \| signed_out \| 1\.0 \| accepted: /);
    expect(md).toContain("Evidence: /runs/x");
  });

  it("lists the manual checklist for rc runs", () => {
    expect(md).toContain("## Manual checklist for the owner");
    expect(md).toContain("- [ ] Stop from the phone:");
    const nightly = record("nightly", []);
    expect(renderSummary(summarize(nightly, [], "/r"), nightly, FLOWS)).not.toContain("Manual checklist");
  });

  it("never prints tokens or secrets and truncates message text to 200 characters", () => {
    const leaky = record("pr", [result("feishu.dm-router", "product_fail", `reply-final: token u-${"a".repeat(40)} and sk-ant-${"b".repeat(30)} at /auth?token=abc ${"x".repeat(400)}`)]);
    const out = renderSummary(summarize(leaky, [], "/r"), leaky, FLOWS);
    expect(out).not.toMatch(/u-a{20}|sk-ant-b|token=abc/);
    const row = out.split("\n").find((l) => l.startsWith("| feishu.dm-router"))!;
    expect(row.split(" | ")[2]!.length).toBeLessThanOrEqual(TESTER_SUMMARY_TEXT_MAX_CHARS);
    expect(safeText("a | b", false)).toBe("a | b");
    expect(safeText("a | b")).toBe("a \\| b");
  });
});
