import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE, COMPUTER_USE_INVENTORY } from "../../../test/sandbox-approval-fixture.ts";
import {
  API_PATHS, APP_APPROVAL_CARDS_PER_WORKER_MAX, APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX, APP_APPROVAL_PENDING_PER_WORKER_MAX, APP_APPROVAL_WAIT_MAX_MS,
  APP_APPROVALS_RETENTION_MS, APP_APPROVALS_TERMINAL_MAX_ROWS, askOf, type AppApprovalRequest, type HubArgs,
} from "../../shared/index.ts";
import { createAgentApi } from "../agent-api/server.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { renderAskCard } from "../feishu/cards.ts";
import { canDeliverSystemMessage } from "../handlers.ts";
import { createAppApprovalStore, type AppApprovalLookup } from "./app-approvals.ts";
import { createLedgerContext } from "./context.ts";
import { workerOpsFixture } from "./test-helpers.ts";

const allow = { decision: "allow", clientId: "click-1" } as const;
const deny = { ...allow, decision: "deny" } as const;

function pendingId(result: AppApprovalLookup): number {
  expect(result.kind).toBe("pending");
  if (result.kind !== "pending") throw new Error("Expected a pending card");
  return result.approvalId;
}

function fixture() {
  const f = workerOpsFixture({ workerPlatform: "darwin" });
  const ctx = createLedgerContext(f.db, { now: f.now });
  const insert = vi.fn<() => number | null>().mockReturnValue(null);
  const settle = vi.fn();
  const notify = vi.fn();
  const store = () => createAppApprovalStore({ ctx, insertCardMessageIn: insert, settleCardMessageIn: settle, notifyWorkerIn: notify });
  const start = (options: Partial<HubArgs<"worker.start">> = {}, approve = true) => {
    const { worker } = f.ledger.hubCall(f.pm.sessionId, "worker.start", {
      title: "Inspect Calculator", task: "Check totals", vendor: "codex", noWorktree: true, noOuterSandbox: true,
      caps: "custom", allow: [COMPUTER_USE], ...options,
    }, { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false }, capabilityInventory: COMPUTER_USE_INVENTORY }).data;
    const approval = f.ledger.snapshot().pendingSandboxApprovals?.find((row) => row.workerId === worker.id);
    if (approve && approval !== undefined) f.ledger.decideSandboxApproval!(approval.id, { decision: "approve", clientId: "sandbox-click" });
    return worker;
  };
  const request = (workerId: number, change: Partial<AppApprovalRequest> = {}): AppApprovalRequest => ({
    sessionId: f.sessionOf(workerId), vendor: "codex", processKey: "process-1", requestKey: "request-1",
    capability: COMPUTER_USE, appId: "com.apple.calculator", appName: "Calculator", riskLevel: "low", warning: null, ...change,
  });
  return { ...f, ctx, start, request, store, insert, settle, notify };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(async () => { await f.close(); });

describe("application approval ledger", () => {
  it("rejects requests from Workers without an approved no-outer-sandbox record", () => {
    const store = f.store();
    for (const worker of [f.start({ noOuterSandbox: false }), f.start({}, false)]) {
      expect(store.openOrAttach(f.request(worker.id))).toMatchObject({ kind: "ineligible" });
    }
    expect(f.insert).not.toHaveBeenCalled();
  });
  it("rejects requests whose capability is not mounted on the Worker", () => {
    const worker = f.start();
    expect(f.store().openOrAttach(f.request(worker.id, { capability: "mcp:unmounted" }))).toMatchObject({ kind: "ineligible" });
    expect(f.insert).not.toHaveBeenCalled();
  });
  it("rejects requests from ended Workers and always-denied app ids", () => {
    const worker = f.start();
    const store = f.store();
    expect(store.openOrAttach(f.request(worker.id, { appId: "com.agenthub.desktop" }))).toMatchObject({ kind: "ineligible" });
    f.hub("worker.end", { workerId: worker.id });
    expect(store.openOrAttach(f.request(worker.id))).toMatchObject({ kind: "ineligible" });
  });
  it("posts one card in the PM conversation for the first request and attaches repeats for the same app", async () => {
    const worker = f.start();
    const gate = f.ledger.appApprovals;
    const control = new AbortController();
    try {
      const first = gate.request(f.request(worker.id), control.signal);
      const second = gate.request(f.request(worker.id, { requestKey: "request-2" }), control.signal);
      const [card, ...other] = f.ledger.snapshot().pendingAppApprovals ?? [];
      expect(other).toEqual([]);
      expect(card).toMatchObject({ workerId: worker.id, conversationId: f.pm.conversation.id, appId: "com.apple.calculator" });
      expect(askOf(f.ledger.getMessage(card!.messageId!)!)).toMatchObject({ appApprovalRef: { approvalId: card!.id } });
      expect(f.db.get("SELECT request_count FROM worker_app_approvals WHERE id = ?", card!.id)).toMatchObject({ request_count: 2 });
      f.ledger.decideAppApproval!(card!.id, allow);
      await expect(Promise.all([first, second])).resolves.toEqual(["accept", "accept"]);
    } finally { control.abort(); }
  });
  it("stops opening cards past the per-Worker pending and total caps", () => {
    const store = f.store();
    const worker = f.start();
    const ask = (i: number) => store.openOrAttach(f.request(worker.id, { appId: `com.apps.app${i}` }));
    const first = Array.from({ length: APP_APPROVAL_PENDING_PER_WORKER_MAX }, (_, i) => pendingId(ask(i)));
    expect(ask(first.length)).toMatchObject({ kind: "ineligible" });
    for (const id of first) store.decide(id, deny);
    for (let i = first.length; i < APP_APPROVAL_CARDS_PER_WORKER_MAX; i++) store.decide(pendingId(ask(i)), deny);
    expect(ask(APP_APPROVAL_CARDS_PER_WORKER_MAX)).toMatchObject({ kind: "ineligible" });
    expect(f.insert).toHaveBeenCalledTimes(APP_APPROVAL_CARDS_PER_WORKER_MAX);
  });
  it("allow records decided_by user and later requests for the same app return allowed without a card, also after a relaunch", () => {
    const store = f.store();
    const worker = f.start();
    const input = f.request(worker.id);
    const id = pendingId(store.openOrAttach(input));
    expect(store.decide(id, allow)).toMatchObject({ approval: { status: "allowed", decidedBy: "user", decisionClientId: allow.clientId } });
    store.endProcess(input.sessionId, input.processKey, "process_exit");
    expect(store.openOrAttach({ ...input, processKey: "relaunched" })).toEqual({ kind: "allowed", approvalId: id });
    expect(f.insert).toHaveBeenCalledTimes(1);
  });
  it("a grant does not match another Worker or another app id", () => {
    const store = f.store();
    const first = f.start();
    const second = f.start();
    const id = pendingId(store.openOrAttach(f.request(first.id)));
    store.decide(id, allow);
    expect(pendingId(store.openOrAttach(f.request(second.id)))).not.toBe(id);
    expect(pendingId(store.openOrAttach(f.request(first.id, { appId: "com.apple.clock" })))).not.toBe(id);
  });
  it("deny makes later requests for the same app in this Worker run return denied without a card", () => {
    const store = f.store();
    const input = f.request(f.start().id);
    const id = pendingId(store.openOrAttach(input));
    expect(store.decide(id, deny)).toMatchObject({ approval: { status: "denied", decidedBy: "user" } });
    expect(store.openOrAttach(input)).toEqual({ kind: "denied", approvalId: id });
    expect(f.insert).toHaveBeenCalledTimes(1);
  });
  it("repeating the same clientId returns the stored decision and a different decision conflicts", () => {
    const store = f.store();
    const id = pendingId(store.openOrAttach(f.request(f.start().id)));
    const decision = store.decide(id, allow);
    expect(store.decide(id, allow)).toEqual(decision);
    expect(() => store.decide(id, deny)).toThrow(/ended|decided|conflict/i);
    expect(() => store.decide(id, { ...allow, clientId: "another" })).toThrow(/ended|decided|conflict/i);
  });
  it("allow after every native request ended queues one system note to the Worker", async () => {
    const worker = f.start();
    const input = f.request(worker.id);
    const controller = new AbortController();
    const requested = f.ledger.appApprovals.request(input, controller.signal);
    controller.abort();
    await expect(requested).resolves.toBe("cancel");
    const id = f.ledger.snapshot().pendingAppApprovals![0]!.id;
    f.ledger.decideAppApproval!(id, allow);
    f.ledger.decideAppApproval!(id, allow);
    const notes = f.db.all<{ id: number; text: string }>(
      "SELECT id, text FROM messages WHERE session_id = ? AND sender = 'system' AND json_extract(meta, '$.source') = 'app_approval'", input.sessionId,
    );
    expect(notes).toEqual([{ id: expect.any(Number), text: expect.stringContaining(input.appName) }]);
    expect(canDeliverSystemMessage(f.ledger, input.sessionId, notes[0]!.id)).toBe(true);
    f.hub("worker.end", { workerId: worker.id });
    expect(canDeliverSystemMessage(f.ledger, input.sessionId, notes[0]!.id)).toBe(false);
  });
  it("endProcess expires that process's pending rows and closes their cards, keeping decided rows", () => {
    const store = f.store();
    const input = f.request(f.start().id);
    const pmMessageId = f.ledger.snapshot().pendingSandboxApprovals?.[0]?.messageId ?? f.db.get<{ id: number }>("SELECT id FROM messages ORDER BY id LIMIT 1")!.id;
    f.insert.mockReturnValue(pmMessageId);
    const allowed = pendingId(store.openOrAttach(input));
    store.decide(allowed, allow);
    const waiting = pendingId(store.openOrAttach({ ...input, appId: "com.apple.clock" }));
    const elsewhere = pendingId(store.openOrAttach({ ...input, appId: "com.apple.notes", processKey: "another" }));
    store.endProcess(input.sessionId, input.processKey, "process_exit");
    expect(store.getById(allowed)?.status).toBe("allowed");
    expect(store.getById(waiting)?.status).toBe("expired");
    expect(store.getById(elsewhere)?.status).toBe("pending");
    expect(f.settle).toHaveBeenLastCalledWith(expect.anything(), pmMessageId, { by: "close" });
  });
  it("Worker end revokes every row for the Worker", () => {
    const store = f.store();
    const worker = f.start();
    const input = f.request(worker.id);
    const allowed = pendingId(store.openOrAttach(input));
    store.decide(allowed, allow);
    const denied = pendingId(store.openOrAttach({ ...input, appId: "com.apple.clock" }));
    store.decide(denied, deny);
    const waiting = pendingId(store.openOrAttach({ ...input, appId: "com.apple.notes" }));
    f.hub("worker.end", { workerId: worker.id });
    expect([allowed, denied, waiting].map((id) => store.getById(id)?.status)).toEqual(["revoked", "revoked", "expired"]);
  });
  it("expireDue expires pending rows at expires_at", () => {
    const store = f.store();
    const id = pendingId(store.openOrAttach(f.request(f.start().id)));
    const expiresAt = f.now() + APP_APPROVAL_WAIT_MAX_MS;
    expect(store.expireDue(expiresAt - 1)).toEqual([]);
    expect(store.expireDue(expiresAt)).toEqual([id]);
    expect(store.getById(id)?.status).toBe("expired");
    expect(() => store.decide(id, allow)).toThrow();
  });
  it("endAllAtStartup ends every live row after a daemon restart", () => {
    const store = f.store();
    const input = f.request(f.start().id);
    const granted = pendingId(store.openOrAttach(input));
    store.decide(granted, allow);
    const waiting = pendingId(store.openOrAttach({ ...input, appId: "com.apple.notes" }));
    f.ledger.recoverAfterRestart();
    expect(store.getById(granted)?.status).toBe("revoked");
    expect(store.getById(waiting)?.status).toBe("expired");
  });
  it("pruneTerminal keeps retention by age and row count", () => {
    const store = f.store();
    const id = pendingId(store.openOrAttach(f.request(f.start().id)));
    store.expireDue(f.now() + APP_APPROVAL_WAIT_MAX_MS);
    f.db.run("UPDATE worker_app_approvals SET updated_at = ? WHERE id = ?", f.now() - APP_APPROVALS_RETENTION_MS - 1, id);
    f.db.run(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < ?)
      INSERT INTO worker_app_approvals (worker_id, session_id, sandbox_approval_id, pm_id, conversation_id, vendor, process_key, app_id,
        app_name, status, created_at, expires_at, updated_at)
      SELECT a.worker_id, a.session_id, a.sandbox_approval_id, a.pm_id, a.conversation_id, a.vendor, a.process_key,
        a.app_id, a.app_name, 'expired', ?, ?, ? + n FROM worker_app_approvals a CROSS JOIN copies WHERE a.id = ?`,
    APP_APPROVALS_TERMINAL_MAX_ROWS + 1, f.now(), f.now(), f.now(), id);
    expect(store.pruneTerminal(f.now())).toBe(2);
    expect(store.getById(id)).toBeNull();
    expect(f.db.get("SELECT MIN(id) AS oldest, COUNT(*) AS remaining FROM worker_app_approvals")).toEqual({
      oldest: id + 2, remaining: APP_APPROVALS_TERMINAL_MAX_ROWS,
    });
  });
  it("hub commands and agent-api have no path that decides an app approval", async () => {
    const gate = f.ledger.appApprovals;
    const worker = f.start();
    const controller = new AbortController();
    const answer = gate.request(f.request(worker.id), controller.signal);
    const tokens = createSessionTokens();
    const agent = createAgentApi({ ledger: f.ledger, tokens });
    try {
      const card = f.ledger.snapshot().pendingAppApprovals![0]!;
      expect(() => f.hub("ask.close", { itemId: card.messageId! })).toThrow();
      await agent.ready();
      expect(agent.hasRoute({ method: "POST", url: "/api/app-approvals/:id/decide" })).toBe(false);
      const res = await agent.inject({ method: "POST", url: API_PATHS.decideAppApproval(card.id),
        headers: { authorization: `Bearer ${tokens.issue(f.pm.sessionId)}` }, payload: allow });
      expect(res.statusCode).toBe(400);
      expect(f.ledger.snapshot().pendingAppApprovals).toEqual([card]);
    } finally {
      controller.abort();
      await expect(answer).resolves.toBe("cancel");
      await agent.close();
    }
  });
  it("bounds the real request count before attaching the next native wait", async () => {
    const worker = f.start();
    const controllers = Array.from({ length: APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX }, () => new AbortController());
    const ask = (requestKey: string, signal = new AbortController().signal) =>
      f.ledger.appApprovals.request(f.request(worker.id, { requestKey }), signal);
    const waiting = controllers.map(({ signal }, i) => ask(String(i), signal));
    try {
      await expect(ask("overflow")).resolves.toBe("decline");
      const [card] = f.ledger.snapshot().pendingAppApprovals!;
      expect(f.db.get("SELECT request_count FROM worker_app_approvals WHERE id = ?", card!.id)).toEqual({
        request_count: APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX,
      });
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(waiting);
    }
  });
  it("shows a workbench reminder in Feishu with no action or form", async () => {
    const worker = f.start();
    const controller = new AbortController();
    const answer = f.ledger.appApprovals.request(f.request(worker.id), controller.signal);
    try {
      const [pending] = f.ledger.snapshot().pendingAppApprovals!;
      const message = f.ledger.getMessage(pending!.messageId!)!;
      const rendered = JSON.stringify(renderAskCard(message, askOf(message)!, { kind: "pending" }));
      expect(rendered).toContain("Calculator");
      expect(rendered).toContain("请在 Bellwood 工作台确认或拒绝");
      expect(rendered).not.toMatch(/"tag":"(?:button|input|form)"/);
    } finally {
      controller.abort();
      await answer;
    }
  });
});
