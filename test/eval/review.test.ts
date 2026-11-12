import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { blameRight } from "./checks.ts";
import { pmSandboxProfile, sbString } from "./isolation.ts";
import { sessionIsBusy } from "./trial.ts";
import type { Facts } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "eval-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("SBPL 路径转义引号、反斜线，拒绝控制字符", () => {
  expect(sbString('a"b\\c')).toBe('"a\\"b\\\\c"');
  expect(() => sbString("a\nb")).toThrow("控制字符");
  const profile = pmSandboxProfile({ home: root, realDataDirs: [join(root, 'a"b')], realRepo: root, claudeConfigDir: root, denyExec: ["/bin/kill"], daemonPorts: [1] });
  expect(profile).toContain('a\\"b');
});

it("后台命令、慢思考、重试和等额度均不能开始安静计时", () => {
  for (const activity of ["working", "preparing", "stopping", "background"]) expect(sessionIsBusy({ activity })).toBe(true);
  expect(sessionIsBusy({ activity: "idle", apiRetry: {} })).toBe(true);
  expect(sessionIsBusy({ activity: "idle", rateLimit: { status: "rejected", resetsAt: null, windows: {} } })).toBe(true);
  expect(sessionIsBusy({ activity: "idle", rateLimit: { status: "rejected", resetsAt: 1, windows: {} } })).toBe(false);
  expect(sessionIsBusy({ activity: "idle" })).toBe(false);
  expect(sessionIsBusy({ activity: "idle", rateLimit: { status: "allowed", resetsAt: null, windows: {} } })).toBe(false);
});

it("R5：仅凭 worker.send 不能把正常沟通判为打回作者", () => {
  const facts: Facts = {
    pmConversationId: 1, pmSessionIds: [], startedAt: 0, endedAt: 10,
    workers: [{ id: 1, title: "托盘", task: "托盘", vendor: "claude", model: null, readonly: false, branch: null, worktreePath: null, status: "done", createdAt: 0 }],
    messages: [{ id: 1, at: 1, sender: "worker", kind: "worker", text: "完成", meta: { event: "report", workerId: 1 }, status: null, failureReason: null }],
    hubCalls: [{ id: 1, command: "worker.send", at: 3, ok: true, args: { workerId: 1, text: "CI 是环境问题，请等待。" } }],
    gh: [{ seq: 1, at: 2, argv: ["pr", "checks", "288"], cwd: root, action: "pr checks", exitCode: 1, pr: 288, checks: "fail" }],
    graphs: [], tools: [], recorded: [], personaChanges: [], personaSeen: [], injected: [],
  };
  const check = blameRight({ keywords: ["托盘"], quotes: [], changedFiles: [], maxNodes: 2 });
  expect(check.run(facts).status).toBe("na");
  facts.hubCalls = [];
  expect(check.run(facts).status).toBe("pass");
});
