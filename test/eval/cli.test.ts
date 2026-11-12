// pnpm eval compare 整条路的自测（不花钱）：剧本项目经理代替真 claude，其余照真跑——导出两个版本的源码、用 vitest.eval.config.ts 跑试跑、
// 打印并写出对照表。能派 Worker 时用正例（每条检查两个版本都是“过”），不能时（Worker 沙箱里）用什么都不做的。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SANDBOX_EXEC, osSandboxAvailable } from "../../src/daemon/driver/write-scope.ts";
import { shortTmp } from "../e2e/harness.ts";
import type { Summary } from "./report.ts";

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

const CLI = new URL("./cli.ts", import.meta.url).pathname;
const root = mkdtempSync(join(shortTmp(), "ah-evalcli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pnpm eval compare（剧本项目经理）", { timeout: 180_000 }, () => {
  it("两个版本各跑一遍，终端打印对照表，写出 summary.md 和 summary.json", () => {
    const kind = canSpawnWorkers ? "positive" : "nothing";
    const r = spawnSync(process.execPath, [CLI, "compare", "--base", "HEAD", "--head", "HEAD", "--scripted", kind, "--scenario", "s3a-tray", "--root", root], { encoding: "utf8" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const [runId] = readdirSync(join(root, "runs"));
    const summary = JSON.parse(readFileSync(join(root, "runs", runId!, "summary.json"), "utf8")) as Summary;
    expect(summary.trials.map((t) => t.version).sort()).toEqual(["base", "head"]);
    expect(existsSync(join(root, "runs", runId!, "summary.md"))).toBe(true);
    if (kind === "positive") {
      expect(r.stdout).toContain("| A1 验收不读 diff | 过 | 过 |  |");
      for (const t of summary.trials) expect(t.checks.filter((c) => c.status !== "pass")).toEqual([]);
    } else {
      expect(r.stdout).toContain("| D0 派了托盘 Worker | 不过 | 不过 |  |");
    }
    // 被测版本的源码按提交号缓存在评测目录里，不在真仓库里建 worktree
    expect(readdirSync(join(root, "v")).length).toBe(1);
  });
});
