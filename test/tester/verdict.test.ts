import { describe, it } from "vitest";

describe("classifyFlow", () => {
  it.todo("gives not_ready with the status and fix when a vendor is not installed or not signed in on the target computer");
  it.todo("gives not_ready when a need is not configured on the bench, and never drops the flow");
  it.todo("gives env_unavailable when a configured need failed preflight");
  it.todo("gives env_unavailable when the runner reported an external error, even with failed checks");
  it.todo("gives env_unavailable when the runner threw an error that names an external service");
  it.todo("gives quota when the runner reported vendor trouble");
  it.todo("gives pass when every check is ok");
  it.todo("gives product_fail with the first failed check as the reason");
  it.todo("gives product_fail when the runner threw an error that names no external service");
});

describe("alertsFor", () => {
  it.todo("alerts a pr or rc run on any product_fail in that run");
  it.todo("does not alert a nightly consecutive flow on a single product_fail");
  it.todo("alerts a nightly consecutive flow after the configured number of trailing product_fail runs");
  it.todo("alerts a nightly rate flow when passes in the window fall below the minimum");
  it.todo("ignores quota and not_ready results when counting a streak or a rate window");
  it.todo("gives a coverage alert on every run for each open vendor gap, and none for an accepted gap");
  it.todo("gives a bench alert after TESTER_BENCH_ALERT_RUNS env_unavailable runs in a row");
  it.todo("returns at most one alert per flow");
  it.todo("ignores flows that are no longer in the catalog");
});

describe("countsTowardRate", () => {
  it.todo("counts pass and product_fail only");
});
