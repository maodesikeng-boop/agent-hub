// 编排验证的自测（docs/orchestration-eval-design.md 4.5）：剧本项目经理走和真模型同一条试跑路径（起真守护进程、假 Worker 回放、
// gh 替身、查账本），不花模型的钱，进 CI。
// - 正例：全部检查必须过（不适用也不行）；
// - 反例：对应的检查必须不过；
// - 什么都不做：“要求有”的检查必须不过，其余不能是“过”。
// 派 Worker 要系统沙箱，macOS 沙箱不能嵌套：在 Worker 里跑时，要派 Worker 的几条跳过（CI 的 Ubuntu 上全跑）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SANDBOX_EXEC, osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { shortTmp } from "../e2e/harness.ts";
import { EVAL_SCRIPTED_POLL_MS, EVAL_SCRIPTED_QUIET_MS, EVAL_SCRIPTED_TRIAL_TIMEOUT_MS } from "./limits.ts";
import { SCENARIOS } from "./scenarios.ts";
import { NEGATIVE_MUST_FAIL, SELF_TEST_SCRIPTS, type SelfTestKind } from "./selftest-scripts.ts";
import { runTrial } from "./trial.ts";
import type { Scenario, TrialResult } from "./types.ts";

const canSpawnWorkers =
  process.platform === "darwin"
    ? (() => {
        try {
          execFileSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })()
    : osSandboxAvailable();

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

describe.each(SCENARIOS)("编排验证自测 $id", { timeout: EVAL_SCRIPTED_TRIAL_TIMEOUT_MS + 30_000 }, (scenario) => {
  it.skipIf(!canSpawnWorkers)("正例：全部检查都过", async () => {
    const r = await selfTrial(scenario, "positive");
    expect(r.envError, show(r)).toBeNull();
    expect(r.checks.filter((c) => c.status !== "pass"), show(r)).toEqual([]);
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
