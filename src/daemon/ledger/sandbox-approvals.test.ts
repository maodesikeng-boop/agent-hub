import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPUTER_USE, COMPUTER_USE_INVENTORY } from "../../../test/sandbox-approval-fixture.ts";
import { askOf, SANDBOX_APPROVALS_RETENTION_MS, type HubArgs } from "../../shared/index.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
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
  const create = () => createLedger(db, { pmHomeRoot: join(root, "data", "pm-home"), osSandboxed: () => true, workerPlatform: "darwin" });
  let ledger = create();
  const pm = ledger.createPm({ name: "Example", mode: "manage_only", vendor: "codex", persona: "", defaultModel: null });
  ledger.hubCall(pm.sessionId, "project.create", { folder: workspace });
  const tokens = createSessionTokens();
  const hubToken = tokens.issue(pm.sessionId);
  const agent = createAgentApi({ ledger, tokens });
  const ui = createUiServer({ ledger, db, token: TOKEN, port: PORT, staticDir: root, uploadsDir: root, sentFilesDir: root });
  const dispatch = (overrides: Partial<HubArgs<"worker.start">> = {}) => ledger.hubCall(pm.sessionId, "worker.start", {
    title: "Inspect Calculator", task: "Read the Calculator window", vendor: "codex", noWorktree: true,
    noOuterSandbox: true, caps: "custom", allow: [COMPUTER_USE], ...overrides,
  }, { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false }, capabilityInventory: COMPUTER_USE_INVENTORY }).data.worker;
  return {
    root, db, pm, agent, hubToken, ui, dispatch, get ledger() { return ledger; },
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

  it("requires fresh approval for a takeover on the same graph step", () => {
    const graph = f.ledger.hubCall(f.pm.sessionId, "graph.create", { specJson: JSON.stringify({
      title: "Desktop", steps: [{ key: "run", title: "Read window", vendor: "codex", brief: "Read the Calculator window", noOuterSandbox: true, caps: "custom", allow: [COMPUTER_USE] }],
    }) }, { workspace: { kind: "ok", isRepoWithCommit: false, hasUncommittedChanges: false } }).data.graph;
    const step = graph.nodes[0]!;
    expect(step).toMatchObject({ status: "waiting", waitingFor: "user" });
    expect(() => f.ledger.hubCall(f.pm.sessionId, "graph.decide", { graphId: graph.id, nodeKey: "run", choice: "approve" })).toThrow(/工作台确认/);
    const initial = approvalOf(step.activeWorkerId!)!;
    f.ledger.decideSandboxApproval!(initial.id, APPROVE);
    expect(f.ledger.snapshot().activeTaskGraphs[0]?.nodes[0]?.status).toBe("running");
    f.ledger.hubCall(f.pm.sessionId, "worker.end", { workerId: initial.workerId });
    const takeover = f.dispatch({ node: "run", graphId: graph.id, noOuterSandbox: undefined, caps: undefined, allow: undefined });
    expect(takeover.id).not.toBe(initial.workerId);
    expect(approvalOf(takeover.id)?.status).toBe("pending");
    expect(actionsOf(takeover.id)).toEqual([]);
  });
});
