// 要用户本人动手的事由系统挂卡、处理完接着派（docs/user-blockers-design.md）：
// 自动开工时厂商没登录、Worker 起来时报认证失败 -> 步骤等用户、对话里一张提醒卡（同一家厂商只一张）；
// 点“已处理”重查还不行留卡，能用就把卡住的步骤和 Worker 接着派出去，再点不重复派。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyActionRow } from "../../shared/actions.ts";
import { askOf, type ConversationId, type Message, type PmId, type SessionId, type TaskNode, type WorkerId } from "../../shared/domain.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../../shared/vendors.ts";
import { addWorktree } from "../git/index.ts";
import { createWorktreeCreateHandler } from "../handlers.ts";
import { migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

const stateOf = (n: Pick<TaskNode, "status" | "waitingFor">): string => (n.status === "waiting" ? `waiting:${n.waitingFor}` : n.status);

describe("要用户动手的事：系统挂卡、处理完接着派", () => {
  let db: Db;
  let root: string;
  let repoDir: string;
  let setupLogsDir: string;
  let now: number;
  let ledger: SqliteLedger;
  let enqueued: AnyActionRow[];
  let availabilityByVendor: Partial<Record<AgentVendor, VendorAvailability>>;
  let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

  beforeEach(() => {
    now = 1_710_000_000_000;
    enqueued = [];
    availabilityByVendor = {};
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-blockers-")));
    const dataHome = join(root, "data");
    setupLogsDir = join(dataHome, "state", "logs", "setup");
    repoDir = join(root, "repo");
    for (const dir of [join(dataHome, "pm-home"), join(dataHome, "worktrees"), join(dataHome, "state", "launch"), setupLogsDir, repoDir]) {
      mkdirSync(dir, { recursive: true });
    }
    git(repoDir, "init", "-b", "main");
    writeFileSync(join(repoDir, "README.md"), "# repo\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "initial commit");

    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      launchDir: join(dataHome, "state", "launch"),
      setupLogsDir,
      userHome: root,
      osSandboxed: () => true,
      deviceName: () => "测试机",
      modelCatalog: (vendor): ModelCatalog => ({
        ...bundledModelCatalog(vendor),
        availability: availabilityByVendor[vendor] ?? "available",
      }),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    ledger.onActionEnqueued((a) => enqueued.push(a));
    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "严谨", folder: repoDir });
    lin = { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
    enqueued.length = 0;
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const runWorktreeCreate = async (workerId: WorkerId) => {
    const handler = createWorktreeCreateHandler({
      ledger,
      addWorktree,
      setup: { start: () => false },
      setupLogPath: (id) => workerSetupLogPath(setupLogsDir, id),
      observeReview: async () => ({ sha: null, remote: null, pr: null }),
    });
    await handler({
      id: ++now,
      type: "worktree.create",
      dedupeKey: String(workerId),
      params: { workerId },
      status: "running",
      attempts: 1,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  };

  const showGraph = (graphId: number) => ledger.hubCall(lin.sessionId, "graph.show", { graphId }).data.graph;

  /** 项目经理对话里系统挂的提醒卡（带 blockerRef 的 ask 消息）。 */
  const blockerCards = (): Message[] =>
    db
      .all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", lin.conversationId)
      .map((r) => ledger.getMessage(r.id)!)
      .filter((m) => askOf(m)?.blockerRef !== undefined);

  const workerSendActions = (workerId: WorkerId) => {
    const conv = db.get<{ worker_conversation_id: number }>("SELECT worker_conversation_id FROM workers WHERE id = ?", workerId)!;
    const sessionIds = new Set(
      db.all<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", conv.worker_conversation_id).map((r) => r.id),
    );
    return enqueued.filter(
      (a): a is Extract<AnyActionRow, { type: "session.send" }> => a.type === "session.send" && sessionIds.has(a.params.sessionId),
    );
  };

  it("自动开工时厂商没登录：步骤等用户、挂一张写明设备和登录命令的卡；两张图同一家只挂一张；重查还不行留卡，能用就接着派且不重复派", () => {
    availabilityByVendor.agy = "signed_out";
    const first = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "验收一", steps: [{ key: "verify", title: "验收", brief: "跑一遍", vendor: "agy" }] }),
    });
    expect(first.text).toContain("已挂卡等用户");
    const second = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "验收二", steps: [{ key: "verify", title: "验收", brief: "再跑一遍", vendor: "agy" }] }),
    }).data.graph;

    const a = showGraph(first.data.graph.id).nodes[0]!;
    const b = showGraph(second.id).nodes[0]!;
    expect(stateOf(a)).toBe("waiting:user");
    expect(stateOf(b)).toBe("waiting:user");
    expect(a.activeWorkerId).toBeNull();
    expect(a.userBlocker).toMatchObject({ kind: "vendor_signed_out", vendor: "agy", device: "测试机", recheckedAs: null });
    expect(b.userBlocker?.id).toBe(a.userBlocker!.id);

    const cards = blockerCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(a.userBlocker!.askMessageId);
    expect(cards[0]!.text).toContain("这台设备（测试机）的 Antigravity 没登录");
    expect(cards[0]!.text).toContain("`agy`");
    expect(askOf(cards[0]!)?.answered).toBeUndefined();
    // 不进总助待决卡：这张卡不归项目经理关
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM router_items")!.n).toBe(0);

    const blockerId = a.userBlocker!.id;
    const stillOut = ledger.recheckUserBlocker(blockerId, "signed_out");
    expect(stillOut.resolved).toBe(false);
    expect(stillOut.blocker.recheckedAs).toBe("signed_out");
    expect(ledger.getMessage(cards[0]!.id)!.text).toContain("刚查过，还是没登录。");
    expect(askOf(ledger.getMessage(cards[0]!.id)!)?.answered).toBeUndefined();
    expect(stateOf(showGraph(first.data.graph.id).nodes[0]!)).toBe("waiting:user");

    availabilityByVendor.agy = "available";
    const done = ledger.recheckUserBlocker(blockerId, "available");
    expect(done.resolved).toBe(true);
    expect(askOf(ledger.getMessage(cards[0]!.id)!)?.answered).toBe(true);
    expect(ledger.getMessage(cards[0]!.id)!.text).not.toContain("刚查过");
    const a2 = showGraph(first.data.graph.id).nodes[0]!;
    const b2 = showGraph(second.id).nodes[0]!;
    expect(stateOf(a2)).toBe("running");
    expect(stateOf(b2)).toBe("running");
    expect(a2.userBlocker).toBeNull();
    const workerCount = db.get<{ n: number }>("SELECT count(*) AS n FROM workers")!.n;
    expect(workerCount).toBe(2);

    // 再点一次（或另一个窗口同时点）：已经解开，原样回，不重复派
    const again = ledger.recheckUserBlocker(blockerId, "available");
    expect(again.resolved).toBe(true);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM workers")!.n).toBe(workerCount);

    // 之后同一家又没登录：挂一张新卡
    availabilityByVendor.agy = "signed_out";
    ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "验收三", steps: [{ key: "verify", title: "验收", brief: "第三次", vendor: "agy" }] }),
    });
    expect(blockerCards()).toHaveLength(2);
  });

  it("推进到下一步时厂商没装：下一步等用户、卡上写没装", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "两步",
        steps: [
          { key: "impl", title: "实现", brief: "写代码" },
          { key: "verify", title: "验收", brief: "跑一遍", vendor: "cursor" },
        ],
      }),
    }).data.graph;
    const wImpl = showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wImpl);
    availabilityByVendor.cursor = "not_installed";
    enqueued.length = 0;
    // 项目经理收工 impl 并放行：推进到 verify，自动开工没成功
    ledger.hubCall(lin.sessionId, "worker.end", { workerId: wImpl });
    ledger.hubCall(lin.sessionId, "graph.done", { graphId: graph.id, nodeKey: "impl" });
    const verify = showGraph(graph.id).nodes[1]!;
    expect(stateOf(verify)).toBe("waiting:user");
    expect(verify.userBlocker).toMatchObject({ kind: "vendor_not_installed", vendor: "cursor" });
    expect(ledger.getMessage(verify.userBlocker!.askMessageId!)!.text).toContain("这台设备（测试机）没装 Cursor");
  });

  it("Worker 起来时报认证失败：步骤等用户、挂卡、项目经理被告知不用重派；能用后原消息重新排队、步骤回到在干", async () => {
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "单步", steps: [{ key: "impl", title: "实现", brief: "写代码", vendor: "codex" }] }),
    }).data.graph;
    const wid = showGraph(graph.id).nodes[0]!.activeWorkerId!;
    await runWorktreeCreate(wid);
    const send = workerSendActions(wid)[0]!;
    expect(send).toBeDefined();
    enqueued.length = 0;

    // 执行器重试用完：先把这个动作标失败，再交给账本
    db.run("UPDATE actions SET status = 'failed' WHERE id = ?", send.id);
    ledger.onActionFailed(send, "spawn_failed: codex exited before thread ready (exit 1): Error: authentication required. Run 'codex login' to log in");

    const node = showGraph(graph.id).nodes[0]!;
    expect(stateOf(node)).toBe("waiting:user");
    expect(node.activeWorkerId).toBe(wid);
    expect(node.userBlocker).toMatchObject({ kind: "vendor_signed_out", vendor: "codex", device: "测试机" });
    const cards = blockerCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain("`codex login`");
    const pmLine = db.get<{ text: string }>(
      "SELECT text FROM messages WHERE conversation_id = ? AND kind = 'worker' ORDER BY id DESC LIMIT 1",
      lin.conversationId,
    )!;
    expect(pmLine.text).toContain("已挂卡等用户");

    enqueued.length = 0;
    const res = ledger.recheckUserBlocker(node.userBlocker!.id, "available");
    expect(res.resolved).toBe(true);
    const resent = workerSendActions(wid);
    expect(resent.map((a) => a.params.messageId)).toEqual([send.params.messageId]);
    expect(ledger.getMessage(send.params.messageId)!.status).toBe("queued");
    expect(stateOf(showGraph(graph.id).nodes[0]!)).toBe("running");
  });
});
