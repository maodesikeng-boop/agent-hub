// Self-test running scripted PMs through the full trial pipeline (real daemon, Worker replay, gh shim, ledger facts).
// gh 替身、查账本），不花模型的钱，进 CI。
// - 正例：全部检查必须过（不适用也不行）；只在前提成立时判的（kind: guard，如 L1）可以不适用、不能不过，只记录的（kind: record，如 L2）不看；
// - 反例：对应的检查必须不过；
// - 什么都不做：“要求有”的检查必须不过，其余不能是“过”。
// 派 Worker 要系统沙箱，macOS 沙箱不能嵌套：在 Worker 里跑时，要派 Worker 的几条跳过（CI 的 Ubuntu 上全跑）。
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { createSpecSchema } from "../../src/daemon/ledger/task-graphs/spec.ts";
import { shortTmp } from "../e2e/harness.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { EVAL_SCRIPTED_POLL_MS, EVAL_SCRIPTED_QUIET_MS, EVAL_SCRIPTED_TRIAL_TIMEOUT_MS } from "./limits.ts";
import { SCENARIOS } from "./scenarios.ts";
import { NEGATIVE_MUST_FAIL, SELF_TEST_SCRIPTS, type SelfTestKind } from "./selftest-scripts.ts";
import { runTrial } from "./trial.ts";
import type { Scenario, TrialResult } from "./types.ts";

const canSpawnWorkers = process.platform === "darwin" ? sandboxAllowsNestedSandbox() : osSandboxAvailable();

const DAEMON_MAIN = new URL("../../src/daemon/main.ts", import.meta.url).pathname;
const root = mkdtempSync(join(shortTmp(), "ah-evalself-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function selfTrial(scenario: Scenario, kind: SelfTestKind): Promise<TrialResult> {
  return runTrial({
    scenario,
    version: { label: "selftest", commit: "HEAD", daemonMain: DAEMON_MAIN },
    pm: { mode: "scripted", script: SELF_TEST_SCRIPTS[scenario.id][kind] },
    project: { kind: "synthetic" },
    workRoot: join(root, "work"),
    resultDir: join(root, "results", `${scenario.id}-${kind}`),
    timings: { trialMs: EVAL_SCRIPTED_TRIAL_TIMEOUT_MS, pollMs: EVAL_SCRIPTED_POLL_MS, quietMs: EVAL_SCRIPTED_QUIET_MS },
  });
}

const show = (r: TrialResult) => JSON.stringify({ envError: r.envError, checks: r.checks.map((c) => `${c.id}:${c.status} ${c.reason}`), workDir: r.workDir }, null, 2);

const positiveNeedsWorkerSandbox = (id: Scenario["id"]) => id !== "k2-local-config" && id !== "k3-merge";

it("accepts the k1-install counterexample graph before the eval runs", () => {
  const script = SELF_TEST_SCRIPTS["k1-install"].negative({ workDir: "", shotsDir: "", preludeShotsDir: "" });
  const command = script.turns?.[0]?.steps?.[0];
  const json = command && "bash" in command ? command.bash.split("\n")[1] : undefined;
  if (json === undefined) throw new Error("The k1-install counterexample must submit a graph spec on stdin");
  const graph = createSpecSchema.parse(JSON.parse(json));
  expect(graph.nodes?.map((node) => node.key)).toEqual(["ok-approve", "setup", "ok-login", "ok-login2", "connect"]);
});

describe.each(SCENARIOS)("编排验证自测 $id", { timeout: EVAL_SCRIPTED_TRIAL_TIMEOUT_MS + 30_000 }, (scenario) => {
  it.skipIf(!canSpawnWorkers && positiveNeedsWorkerSandbox(scenario.id))("正例：全部检查都过", async () => {
    const r = await selfTrial(scenario, "positive");
    expect(r.envError, show(r)).toBeNull();
    const kindOf = (id: string) => scenario.checks.find((d) => d.id === id)?.kind;
    expect(r.checks.filter((c) => (kindOf(c.id) === undefined ? c.status !== "pass" : kindOf(c.id) === "guard" ? c.status === "fail" : false)), show(r)).toEqual([]);
    expect(r.workDir, "全过的试跑现场要删掉").toBeNull();
  });

  it.skipIf(!canSpawnWorkers)("反例：对应的检查都不过", async () => {
    const r = await selfTrial(scenario, "negative");
    expect(r.envError, show(r)).toBeNull();
    const failed = r.checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed, show(r)).toEqual(expect.arrayContaining(NEGATIVE_MUST_FAIL[scenario.id]));
    // 每条不过都带证据，证据能对上账本行号或 gh 调用
    for (const c of r.checks.filter((x) => x.status === "fail" && NEGATIVE_MUST_FAIL[scenario.id].includes(x.id))) {
      expect(c.evidence.length + c.reason.length, `${c.id} 没有说明`).toBeGreaterThan(0);
    }
    expect(r.workDir, "没通过的试跑现场要留着").not.toBeNull();
    rmSync(r.workDir!, { recursive: true, force: true });
  });

  it("什么都不做：要求有的检查都不过，其余都不是过", async () => {
    const r = await selfTrial(scenario, "nothing");
    expect(r.envError, show(r)).toBeNull();
    for (const c of r.checks) {
      const def = scenario.checks.find((d) => d.id === c.id)!;
      expect(c.status, `${c.id}：${c.reason}`).toBe(def.requiresAction ? "fail" : "na");
    }
    rmSync(r.workDir!, { recursive: true, force: true });
  });
});
