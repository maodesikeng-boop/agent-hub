// 真模型的试跑（由 cli.ts 经 vitest.eval.config.ts 调起，不进 pnpm test、不进 CI）：读 EVAL_PLAN 里的计划，每次试跑一条用例，
// 并发数由配置的 maxConcurrency 管。检查不过不算用例失败（那是测量结果，写进对照表）；环境出错才让这条用例失败，方便在输出里看到。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlanFile } from "./cli.ts";
import { scrubProcessEnv } from "./isolation.ts";
import { EVAL_POLL_MS, EVAL_QUIET_MS, EVAL_SCRIPTED_POLL_MS, EVAL_SCRIPTED_QUIET_MS, EVAL_SCRIPTED_TRIAL_TIMEOUT_MS, EVAL_TRIAL_TIMEOUT_MS } from "./limits.ts";
import { scenarioById } from "./scenarios.ts";
import { SELF_TEST_SCRIPTS } from "./selftest-scripts.ts";
import { runTrial } from "./trial.ts";

scrubProcessEnv();
const planFile = process.env.EVAL_PLAN;
if (!planFile) throw new Error("没有 EVAL_PLAN：用 pnpm eval compare 跑，不要直接跑这个文件");
const plan = JSON.parse(readFileSync(planFile, "utf8")) as PlanFile;

const real = plan.pm.mode === "real";

describe.concurrent(real ? "编排验证（真 claude 项目经理）" : "编排验证（剧本项目经理）", () => {
  for (const t of plan.trials) {
    it(`${t.scenario} @ ${t.version.label}`, async () => {
      const r = await runTrial({
        scenario: scenarioById(t.scenario),
        version: t.version,
        pm: plan.pm.mode === "real" ? plan.pm : { mode: "scripted", script: SELF_TEST_SCRIPTS[t.scenario][plan.pm.kind] },
        project: real ? { kind: "real", sourceRepo: plan.sourceRepo } : { kind: "synthetic" },
        workRoot: plan.workRoot,
        resultDir: t.resultDir,
        timings: real
          ? { trialMs: EVAL_TRIAL_TIMEOUT_MS, pollMs: EVAL_POLL_MS, quietMs: EVAL_QUIET_MS }
          : { trialMs: EVAL_SCRIPTED_TRIAL_TIMEOUT_MS, pollMs: EVAL_SCRIPTED_POLL_MS, quietMs: EVAL_SCRIPTED_QUIET_MS },
        keepWork: plan.keepWork,
      });
      const line = r.checks.map((c) => `${c.id}:${c.status === "pass" ? "过" : c.status === "fail" ? "不过" : "不适用"}`).join(" ");
      console.log(`${t.scenario} @ ${t.version.label}：${r.envError ? `环境出错：${r.envError}` : line}`);
      expect(r.envError, `${t.scenario} @ ${t.version.label}`).toBeNull();
    });
  }
});
