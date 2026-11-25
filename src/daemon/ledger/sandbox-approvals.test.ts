import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE, COMPUTER_USE_INVENTORY } from "../../../test/sandbox-approval-fixture.ts";
import { askOf, hubPath, isTaskNodeWaitingDecision, SANDBOX_APPROVALS_RETENTION_MS, SANDBOX_APPROVALS_TERMINAL_MAX_ROWS, type CapabilityInventory, type HubArgs } from "../../shared/index.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { canDeliverSystemMessage } from "../handlers.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createUiServer } from "../ui-server/server.ts";
import { loginCookie } from "../ui-server/test-login.ts";
import { createLedger } from "./ledger.ts";

const TOKEN = "fixture-token-0123456789abcdef";
const PORT = 4041;
const HOST = `127.0.0.1:${PORT}`;
const APPROVE = { decision: "approve", clientId: "browser-click" } as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hub-approval-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const db = openTestDb();
  const create = () => createLedger(db, {
    pmHomeRoot: join(root, "data", "pm-home"), worktreesDir: join(root, "worktrees"),
    osSandboxed: () => true, workerPlatform: "darwin",
  });
  let ledger = create();
  const pm = ledger.createPm({ name: "Example", mode: "manage_only", vendor: "codex", persona: "", defaultModel: null });
  ledger.hubCall(pm.sessionId, "project.create", { folder: workspace });
  const tokens = createSessionTokens();
  const hubToken = tokens.issue(pm.sessionId);
  const getInventory = vi.fn<() => Promise<CapabilityInventory>>().mockResolvedValue(COMPUTER_USE_INVENTORY);
  const agent = createAgentApi({ ledger, tokens, capabilityInventory: { get: getInventory } });
  const ui = createUiServer({ ledger, db, token: TOKEN, port: PORT, staticDir: root, uploadsDir: root, sentFilesDir: root });
  const dispatch = (overrides: Partial<HubArgs<"worker.start">> = {}) => ledger.hubCall(pm.sessionId, "worker.start", {
    title: "Inspect Calculator", task: "Read the Calculator window", vendor: "codex", noWorktree: true,
    noOuterSandbox: true, caps: "custom", allow: [COMPUTER_USE], ...overrides,
  }, { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false }, capabilityInventory: COMPUTER_USE_INVENTORY }).data.worker;
  return {
    root, db, pm, agent, hubToken, ui, dispatch, getInventory, get ledger() { return ledger; },
    restart() { ledger.close(); ledger = create(); return ledger.recoverAfterRestart(); },
    async close() { await Promise.all([agent.close(), ui.close()]); ledger.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

function approvalOf(workerId: number) {
  return f.ledger.snapshot().pendingSandboxApprovals?.find((approval) => approval.workerId === workerId);
}

function actionsOf(workerId: number) {
  return f.db.all<{ type: string }>(`SELECT type FROM actions WHERE type IN ('worktree.create', 'session.start', 'session.send') AND (
    json_extract(params, '$.workerId') = ? OR json_extract(params, '$.sessionId') IN (SELECT id FROM agent_sessions WHERE worker_id = ?))`, workerId, workerId).map((row) => row.type);
}

function sessionIdOf(workerId: number) {
  return f.db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!.id;
}

function request(id: number | string, payload: unknown, cookie?: string) {
  return f.ui.inject({ method: "POST", url: `/api/sandbox-approvals/${id}/decide`, headers: {
    host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }),
  }, payload: JSON.stringify(payload),
  });
}

function createSandboxGraph(isRepoWithCommit = false) {
  return f.ledger.hubCall(f.pm.sessionId, "graph.create", { specJson: JSON.stringify({
    title: "Desktop",
    steps: [{ key: "run", title: "Read window", vendor: "codex", brief: "Read the Calculator window", noOuterSandbox: true, caps: "custom", allow: [COMPUTER_USE] }],
  }) }, { workspace: { kind: "ok", isRepoWithCommit, hasUncommittedChanges: false } }).data.graph;
}

function requestTakeoverWithOpenGate() {
  const graph = createSandboxGraph();
  const initial = approvalOf(graph.nodes[0]!.activeWorkerId!)!;
  f.ledger.decideSandboxApproval!(initial.id, APPROVE);
  const { messageId } = f.ledger.hubCall(f.pm.sessionId, "ask", {
    graphId: graph.id, node: "run", text: "Which window should we inspect?", options: ["Calculator", "Clock"],
  }).data;
  const worker = f.dispatch({ node: "run", graphId: graph.id });
  return { graph, messageId, worker, approval: approvalOf(worker.id)! };
}

describe("Worker sandbox approval", () => {
  it("rejects an implicit request without creating a Worker", () => {
    expect(() => f.dispatch({ caps: "inherit", allow: undefined })).toThrow(/Computer Use/);
    expect(f.db.all("SELECT id FROM workers")).toEqual([]);
  });

  it.each([true, false])("holds the Worker, including across restart (main workspace: %s)", (noWorktree) => {
    const worker = f.dispatch({ noWorktree });
    const pending = approvalOf(worker.id)!;
    expect(pending).toMatchObject({ status: "pending", workerId: worker.id, workerTitle: worker.title });
    expect(askOf(f.ledger.getMessage(pending.messageId!)!)).toMatchObject({ sandboxApprovalRef: { approvalId: pending.id, workerId: worker.id } });
    expect(actionsOf(worker.id)).toEqual([]);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "worker.send", { workerId: worker.id, text: "continue" })).toThrow(/确认沙箱/);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "worker.max-time", { workerId: worker.id, maxTimeMs: 60_000 })).toThrow(/尚未开始计时/);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "ask.close", { itemId: pending.id })).toThrow(/没有编号/);
    f.restart();
    expect(approvalOf(worker.id)?.status).toBe("pending");
    expect(actionsOf(worker.id)).toEqual([]);
  });

  it("only accepts the approval on UI auth and only releases the named Worker", async () => {
    const first = f.dispatch();
    const second = f.dispatch();
    const normal = f.dispatch({ noOuterSandbox: false });
    const pending = approvalOf(first.id)!;
    expect((await request(pending.id, APPROVE)).statusCode).toBe(401);
    await f.agent.ready();
    expect(f.agent.hasRoute({ method: "POST", url: "/api/sandbox-approvals/:id/decide" })).toBe(false);
    expect((await f.agent.inject({ method: "POST", url: `/api/sandbox-approvals/${pending.id}/decide`, headers: { authorization: `Bearer ${f.hubToken}` }, payload: APPROVE })).statusCode).toBeGreaterThanOrEqual(400);
    const cookie = await loginCookie(f.ui, { token: TOKEN, port: PORT });
    for (const payload of [{ ...APPROVE, decision: "yes" }, { ...APPROVE, clientId: "" }, { ...APPROVE, clientId: "x".repeat(201) }, { ...APPROVE, decidedBy: "pm" }]) {
      expect((await request(pending.id, payload, cookie)).statusCode).toBe(400);
    }
    expect((await request("bad", APPROVE, cookie)).statusCode).toBe(400);
    expect((await request(pending.id, APPROVE, cookie)).json()).toMatchObject({ approval: { status: "approved", decidedBy: "user" }, workerStatus: "open" });
    expect((await request(pending.id, APPROVE, cookie)).statusCode).toBe(200);
    expect((await request(pending.id, { ...APPROVE, clientId: "second-click" }, cookie)).statusCode).toBe(409);
    expect(actionsOf(first.id).sort()).toEqual(["session.send", "session.start"]);
    expect(actionsOf(second.id)).toEqual([]);
    expect(actionsOf(normal.id).sort()).toEqual(["session.send", "session.start"]);
    expect(f.ledger.getLaunchContext(sessionIdOf(normal.id)).outerSandboxApproval).toBeUndefined();
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: first.id });
    expect(f.ledger.getSandboxApproval!(pending.id)?.status).toBe("revoked");
    expect((await request(pending.id, APPROVE, cookie)).statusCode).toBe(409);
  });

  it("declines without launching and closes a pending card on Worker end", () => {
    const declined = f.dispatch();
    const rejected = approvalOf(declined.id)!;
    expect(f.ledger.decideSandboxApproval!(rejected.id, { ...APPROVE, decision: "reject" })).toMatchObject({ approval: { status: "rejected" }, workerStatus: "ended" });
    expect(askOf(f.ledger.getMessage(rejected.messageId!)!)).toMatchObject({ answered: true, chosenOption: "Rejected" });
    expect(actionsOf(declined.id)).toEqual([]);
    const cancelled = f.dispatch();
    const pending = approvalOf(cancelled.id)!;
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: cancelled.id });
    expect(f.ledger.getSandboxApproval!(pending.id)?.status).toBe("revoked");
    expect(askOf(f.ledger.getMessage(pending.messageId!)!)).toMatchObject({ answered: true, closed: true });
  });

  it("shows sandbox confirmation in worker list and show until the user approves", () => {
    const worker = f.dispatch({ noWorktree: false });
    const normal = f.dispatch({ noWorktree: false, noOuterSandbox: false });
    const list = () => f.ledger.hubCall(f.pm.sessionId, "worker.list", { vendor: "codex" }).text;
    const show = () => f.ledger.hubCall(f.pm.sessionId, "worker.show", { workerId: worker.id }).text;
    expect(list()).toContain(`#${worker.id} ${worker.title} · 等待沙箱确认`);
    expect(list()).toContain(`#${normal.id} ${normal.title} · 准备中`);
    expect(show()).toContain("等待沙箱确认");
    expect(show()).not.toContain("现在：worktree 还没建好");

    f.ledger.decideSandboxApproval!(approvalOf(worker.id)!.id, APPROVE);
    expect(list()).toContain(`#${worker.id} ${worker.title} · 准备中`);
    expect(show()).toContain("现在：worktree 还没建好");
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: worker.id });
    expect(list()).toContain(`#${worker.id} ${worker.title} · 已收工`);
  });

  it("keeps the rejection notice deliverable until the PM replaces the Worker", () => {
    const graph = createSandboxGraph();
    const workerId = graph.nodes[0]!.activeWorkerId!;
    const approval = approvalOf(workerId)!;
    const sent: number[] = [];
    const unsubscribe = f.ledger.onActionEnqueued(({ type, params }) => {
      if (type === "session.send" && params.sessionId === f.pm.sessionId) sent.push(params.messageId);
    });
    try {
      f.ledger.decideSandboxApproval!(approval.id, { ...APPROVE, decision: "reject" });
      expect(sent).toHaveLength(1);
      const [messageId] = sent;
      expect(f.ledger.getMessage(messageId!)?.text).toContain(`用户拒绝取消 Worker #${workerId}`);
      expect(canDeliverSystemMessage(f.ledger, f.pm.sessionId, messageId!)).toBe(true);
      expect(f.ledger.hubCall(f.pm.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes[0]).toMatchObject({
        status: "waiting", waitingFor: "pm", activeWorkerId: null,
      });

      const replacement = f.dispatch({ node: "run", graphId: graph.id });
      expect(approvalOf(replacement.id)?.status).toBe("pending");
      expect(f.ledger.getMessage(messageId!)?.status).toBe("stopped");
      expect(canDeliverSystemMessage(f.ledger, f.pm.sessionId, messageId!)).toBe(false);
    } finally { unsubscribe(); }
  });

  it("rejects an approval if project policy changed while the card was pending", () => {
    const pending = approvalOf(f.dispatch().id)!;
    f.ledger.patchCapabilities({ kind: "pm", pmId: f.pm.pm.id }, { set: { [COMPUTER_USE]: false } });
    expect(() => f.ledger.decideSandboxApproval!(pending.id, APPROVE)).toThrow(/没有启用/);
    expect(actionsOf(pending.workerId)).toEqual([]);
  });

  it("revokes approvals when a project is archived", () => {
    const approved = approvalOf(f.dispatch().id)!;
    f.ledger.decideSandboxApproval!(approved.id, APPROVE);
    const pending = approvalOf(f.dispatch().id)!;
    f.ledger.archivePm(f.pm.pm.id);
    expect(f.ledger.getSandboxApproval!(approved.id)?.status).toBe("revoked");
    expect(f.ledger.getSandboxApproval!(pending.id)?.status).toBe("revoked");
  });

  it("defers worktree creation until approval and revokes it if worktree creation fails", () => {
    const worker = f.dispatch({ noWorktree: false });
    const pending = approvalOf(worker.id)!;
    let worktree: Parameters<typeof f.ledger.onActionFailed>[0] | undefined;
    const unsubscribe = f.ledger.onActionEnqueued((action) => { if (action.type === "worktree.create") worktree = action; });
    try {
      expect(worktree).toBeUndefined();
      f.ledger.decideSandboxApproval!(pending.id, APPROVE);
      expect(worktree).toMatchObject({ type: "worktree.create", params: { workerId: worker.id } });
      f.ledger.onActionFailed(worktree!, "git failed");
      expect(f.ledger.getSandboxApproval!(pending.id)?.status).toBe("revoked");
      expect(actionsOf(worker.id)).toEqual(["worktree.create"]);
    } finally { unsubscribe(); }
  });

  it("prunes old ended approvals while keeping pending and approved open Workers", () => {
    const ended = approvalOf(f.dispatch().id)!;
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: ended.workerId });
    const approved = approvalOf(f.dispatch().id)!;
    f.ledger.decideSandboxApproval!(approved.id, APPROVE);
    const pending = approvalOf(f.dispatch().id)!;
    f.ledger.purgeGrowingTables(Date.now() + SANDBOX_APPROVALS_RETENTION_MS + 1);
    expect(f.ledger.getSandboxApproval!(ended.id)).toBeNull();
    expect(f.ledger.getSandboxApproval!(approved.id)?.status).toBe("approved");
    expect(f.ledger.getSandboxApproval!(pending.id)?.status).toBe("pending");
  });

  it("keeps only the sandbox approval open and blocks graph completion and decisions while it is pending", () => {
    const graph = createSandboxGraph();
    const step = graph.nodes[0]!;
    const approval = approvalOf(step.activeWorkerId!)!;
    const pendingStep = { status: "waiting", waitingFor: "user", sandboxApproval: { id: approval.id, text: expect.stringContaining("Read the Calculator window") } };
    expect(step).toMatchObject(pendingStep);
    expect(f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0]).toMatchObject(pendingStep);
    expect(isTaskNodeWaitingDecision(step)).toBe(false);
    const status = f.ledger.hubCall(f.pm.sessionId, "status", {});
    expect(status.text).toContain("等用户确认 Worker 沙箱：run");
    expect(status.text).not.toContain("等用户拍板：run");
    expect(status.data).toMatchObject({ activeTaskGraphs: [{ id: graph.id, waitingUserCount: 1 }] });
    expect(() => f.ledger.hubCall(f.pm.sessionId, "graph.done", { graphId: graph.id, nodeKey: "run" })).toThrow(/等用户确认 Worker 沙箱/);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "graph.finish", { graphId: graph.id, summary: "Done" })).toThrow(/run \[等用户确认 Worker 沙箱\]/);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "ask", { graphId: graph.id, node: "run", text: "Pick one", options: ["A", "B"] })).toThrow(/等用户确认 Worker 沙箱/);
    expect(() => f.ledger.hubCall(f.pm.sessionId, "graph.decide", { graphId: graph.id, nodeKey: "run", choice: "approve" })).toThrow(/工作台确认/);
    expect(() => f.ledger.decideTaskNode(graph.id, "run", { clientId: "regular-gate", note: "approve" })).toThrow(/工作台确认/);
    expect(actionsOf(approval.workerId)).toEqual([]);
    expect(f.ledger.snapshot().pendingSandboxApprovals?.map((a) => a.id)).toEqual([approval.id]);
    f.ledger.decideSandboxApproval!(approval.id, APPROVE);
    const resumed = f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0];
    expect(resumed).toMatchObject({ status: "running", waitingFor: null, gateAskMessageId: null });
    expect(resumed?.sandboxApproval).toBeUndefined();
  });

  it("counts ordinary step decisions without counting sandbox approval in the Router digest", () => {
    createSandboxGraph();
    const count = () => f.ledger.getRouterDigest().pms.find((pm) => pm.pmId === f.pm.pm.id)?.pendingDecisionCount;
    expect(count()).toBe(0);
    f.ledger.hubCall(f.pm.sessionId, "graph.create", { specJson: JSON.stringify({
      title: "Review", steps: [{ key: "check", title: "Check the plan", question: "Use the current plan?" }],
    }) });
    expect(count()).toBe(1);
  });

  it("lists the step agent settings alongside sandbox approval without adding them to the slim snapshot", () => {
    const graph = createSandboxGraph();
    const approval = approvalOf(graph.nodes[0]!.activeWorkerId!)!;
    const show = f.ledger.hubCall(f.pm.sessionId, "graph.show", { graphId: graph.id });
    const list = f.ledger.hubCall(f.pm.sessionId, "graph.list", {});
    for (const view of [show, list]) {
      expect(view.text).toContain("[等用户确认 Worker 沙箱] run：Read window");
      expect(view.text).toMatch(/厂商 .*Codex.* · 模型 .* · 思考程度 /);
    }
    const pending = { vendor: "codex", model: graph.nodes[0]!.model, effort: graph.nodes[0]!.effort, sandboxApproval: { id: approval.id } };
    expect(show.data.graph.nodes[0]).toMatchObject(pending);
    expect(list.data.graphs[0]?.nodes[0]).toMatchObject(pending);
    const slim = f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0];
    expect(slim).toMatchObject({ sandboxApproval: { id: approval.id } });
    expect(slim?.vendor).toBeUndefined();
  });

  it("holds a fork until approval and uses the renamed upstream branch when it creates the worktree", () => {
    const workspace = { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } as const;
    const graph = f.ledger.hubCall(f.pm.sessionId, "graph.create", { specJson: JSON.stringify({
      title: "Desktop fork",
      steps: [
        { key: "prepare", title: "Prepare" },
        { key: "inspect", title: "Inspect", deps: ["prepare"], vendor: "codex", brief: "Inspect the window",
          noOuterSandbox: true, caps: "custom", allow: [COMPUTER_USE] },
        { key: "other", title: "Other", deps: ["prepare"] },
      ],
    }) }, { workspace }).data.graph;
    const upstream = f.dispatch({ graphId: graph.id, node: "prepare", noWorktree: false, noOuterSandbox: false });
    f.ledger.onWorktreeCreated(upstream.id, "base");
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: upstream.id });
    const opened = f.ledger.hubCall(f.pm.sessionId, "graph.done", { graphId: graph.id, nodeKey: "prepare", branch: upstream.branch! }, { workspace }).data.graph;
    const workerId = opened.nodes.find((node) => node.key === "inspect")!.activeWorkerId!;
    const approval = approvalOf(workerId)!;
    expect(actionsOf(workerId)).toEqual([]);
    expect(f.ledger.getWorktreeTask(workerId)).toBeNull();

    expect(f.ledger.syncWorktreeBranch!(upstream.worktreePath!, "feature/renamed")).toMatchObject({
      updatedWorkerIds: [upstream.id], updatedGraphIds: [graph.id],
    });
    const current = f.ledger.hubCall(f.pm.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    expect(current.nodes.find((node) => node.key === "prepare")?.artifact?.branch).toBe("feature/renamed");
    expect(current.nodes.find((node) => node.key === "inspect")?.sandboxApproval?.id).toBe(approval.id);
    expect(f.ledger.getWorktreeTask(workerId)).toBeNull();

    f.ledger.decideSandboxApproval!(approval.id, APPROVE);
    expect(actionsOf(workerId)).toEqual(["worktree.create"]);
    expect(f.ledger.getWorktreeTask(workerId)?.checkout).toMatchObject({ kind: "branch", base: "feature/renamed" });
  });

  it("keeps the step waiting for sandbox approval when the PM closes its older gate card", () => {
    const { graph, messageId, worker, approval } = requestTakeoverWithOpenGate();
    expect(() => f.ledger.decideTaskNode(graph.id, "run", { clientId: "old-gate", askMessageId: messageId, choice: "Invalid option" }))
      .toThrow(/工作台确认/);
    expect(askOf(f.ledger.getMessage(messageId)!)?.answered).toBeUndefined();

    f.ledger.hubCall(f.pm.sessionId, "ask.close", { messageId });
    expect(askOf(f.ledger.getMessage(messageId)!)?.closed).toBe(true);
    expect(f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0]).toMatchObject({
      status: "waiting", waitingFor: "user", gateAskPending: false, sandboxApproval: { id: approval.id },
    });
    expect(actionsOf(worker.id)).toEqual([]);

    f.ledger.decideSandboxApproval!(approval.id, APPROVE);
    expect(f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0]).toMatchObject({ status: "running", waitingFor: null });
  });

  it("does not expose a sandbox wait as a gate checkpoint while an older decision card is still open", () => {
    const { graph, messageId, worker, approval } = requestTakeoverWithOpenGate();
    f.db.run("UPDATE task_graph_steps SET artifact_json = ? WHERE active_worker_id = ?",
      JSON.stringify({ checkpointPending: true }), worker.id);
    const node = f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0];
    expect(node).toMatchObject({ gateAskMessageId: messageId, gateAskPending: true, sandboxApproval: { id: approval.id } });
    expect(node?.gateCheckpoint).toBeUndefined();
    expect(isTaskNodeWaitingDecision(node!)).toBe(false);
    expect(f.ledger.getRouterDigest().pms.find((pm) => pm.pmId === f.pm.pm.id)?.pendingDecisionCount).toBe(1);

    f.ledger.decideSandboxApproval!(approval.id, APPROVE);
    const resumed = f.ledger.hubCall(f.pm.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes[0]!;
    expect(resumed).toMatchObject({ status: "running", gateAskMessageId: messageId, gateAskPending: true, gateCheckpoint: true });
    expect(isTaskNodeWaitingDecision(resumed)).toBe(true);
  });

  it("checks current inventory and requires a fresh approval for a takeover on the same graph step", async () => {
    const graph = createSandboxGraph();
    const step = graph.nodes[0]!;
    const initial = approvalOf(step.activeWorkerId!)!;
    f.ledger.decideSandboxApproval!(initial.id, APPROVE);
    const start = () => f.agent.inject({
      method: "POST", url: hubPath("worker.start"), headers: { authorization: `Bearer ${f.hubToken}` },
      payload: { node: "run", graphId: graph.id, noWorktree: true },
    });
    f.getInventory.mockResolvedValueOnce({ ...COMPUTER_USE_INVENTORY, items: [] });
    const denied = await start();
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain("没有安装");
    expect(f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0]?.activeWorkerId).toBe(initial.workerId);
    const accepted = await start();
    expect(accepted.statusCode).toBe(200);
    const takeover = f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0];
    expect(takeover?.activeWorkerId).not.toBe(initial.workerId);
    expect(takeover?.sandboxApproval?.id).toBe(approvalOf(takeover!.activeWorkerId!)?.id);
    expect(actionsOf(takeover!.activeWorkerId!)).toEqual([]);
    expect(f.ledger.getSandboxApproval!(initial.id)?.status).toBe("revoked");
  });

  it("queues only the inherited worktree task and holds it until the predecessor process exits", () => {
    const graph = createSandboxGraph(true);
    const initial = approvalOf(graph.nodes[0]!.activeWorkerId!)!;
    f.ledger.decideSandboxApproval!(initial.id, APPROVE);
    const path = f.db.get<{ worktree_path: string }>("SELECT worktree_path FROM workers WHERE id = ?", initial.workerId)!.worktree_path;
    mkdirSync(path, { recursive: true });
    f.ledger.onWorktreeCreated(initial.workerId, "base");
    const oldSession = sessionIdOf(initial.workerId);
    f.db.run("UPDATE agent_sessions SET pid = 4242 WHERE id = ?", oldSession);
    const takeover = f.dispatch({ node: "run", graphId: graph.id, noWorktree: false, noOuterSandbox: undefined, caps: undefined, allow: undefined });
    expect(takeover).toMatchObject({ workspace: "worktree", worktreePath: path, baseCommit: "base" });
    expect(actionsOf(takeover.id)).toEqual([]);
    f.ledger.decideSandboxApproval!(approvalOf(takeover.id)!.id, APPROVE);
    expect(actionsOf(takeover.id)).toEqual(["session.send"]);
    const newSession = sessionIdOf(takeover.id);
    const first = f.db.get<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND status = 'queued'", takeover.workerConversationId)!.id;
    expect(f.ledger.waitsForFirstTurn(newSession, first)).toBe(true);
    f.db.run("UPDATE agent_sessions SET status = 'ended', pid = NULL WHERE id = ?", oldSession);
    expect(f.ledger.waitsForFirstTurn(newSession, first)).toBe(false);
  });

  it("prunes the oldest terminal approval when the count cap is exceeded", () => {
    const approvals = Array.from({ length: SANDBOX_APPROVALS_TERMINAL_MAX_ROWS + 1 }, () => {
      const approval = approvalOf(f.dispatch().id)!;
      f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: approval.workerId });
      return approval;
    });
    const [oldest, ...retained] = approvals;
    const now = 1_000;
    f.db.run("UPDATE worker_sandbox_approvals SET updated_at = ?", now);
    f.ledger.purgeGrowingTables(now);
    expect(f.ledger.getSandboxApproval!(oldest!.id)).toBeNull();
    expect(retained.every((approval) => f.ledger.getSandboxApproval!(approval.id)?.status === "revoked")).toBe(true);
  });
});
