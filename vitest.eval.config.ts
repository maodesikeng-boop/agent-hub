// 编排验证（真模型）的 vitest 配置：只认 test/eval/run.eval.ts，由 pnpm eval compare 调起（test/eval/cli.ts）。
// 不进 pnpm test（vitest.config.ts 只认 *.test.ts）、不进 CI；评测自己的自测 test/eval/*.test.ts 照常在 pnpm test 和 CI 里跑。
import { defineConfig } from "vitest/config";
import { EVAL_DEFAULT_PARALLEL, EVAL_TRIAL_TIMEOUT_MS } from "./test/eval/limits.ts";

// 一次试跑最多 20 分钟，再留关守护进程、取数、清现场的时间
const timeout = EVAL_TRIAL_TIMEOUT_MS + 5 * 60_000;

export default defineConfig({
  test: {
    name: "eval",
    environment: "node",
    include: ["test/eval/run.eval.ts"],
    setupFiles: ["test/clean-env.ts"],
    testTimeout: timeout,
    hookTimeout: timeout,
    maxConcurrency: Number(process.env.EVAL_PARALLEL) || EVAL_DEFAULT_PARALLEL,
    reporters: ["verbose"],
  },
});
