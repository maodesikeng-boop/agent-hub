import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX, type AppApprovalRecord, type AppApprovalRequest } from "../../shared/index.ts";
import type { AppApprovalLookup, AppApprovalStore } from "../ledger/app-approvals.ts";
import { createAppApprovalBroker } from "./broker.ts";

const request: AppApprovalRequest = { sessionId: 1, vendor: "codex", processKey: "p1", requestKey: "1",
  capability: "mcp:cua_repl", appId: "com.apple.calculator", appName: "Calculator", riskLevel: "low", warning: null };
const row: AppApprovalRecord = {
  id: 1, workerId: 2, workerTitle: "Check totals", sessionId: 1, sandboxApprovalId: 3, pmId: 4, conversationId: 5, messageId: 6,
  vendor: "codex", processKey: "p1", appId: request.appId, appName: request.appName, riskLevel: "low", warning: null,
  status: "pending", decidedBy: null, decisionClientId: null, requestCount: 1, createdAt: 0,
  expiresAt: 100, decidedAt: null, endedAt: null, updatedAt: 0,
};
const close: Array<() => void> = [];
afterEach(() => { for (const dispose of close.splice(0)) dispose(); vi.useRealTimers(); });

function fixture(lookup: AppApprovalLookup = { kind: "pending", approvalId: 1, expiresAt: 100 }) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let changed: (id: number) => void = () => {};
  let current = row;
  const set = (status: AppApprovalRecord["status"]) => { current = { ...row, status }; changed(1); };
  const store = {
    openOrAttach: vi.fn<AppApprovalStore["openOrAttach"]>().mockReturnValue(lookup),
    getById: () => current,
    endProcess: vi.fn(() => set("expired")),
    expireDue: vi.fn(() => { set("expired"); return [1]; }),
    listPendingSummaries: vi.fn(), decide: vi.fn(), revokeForWorkerIn: vi.fn(), endAllAtStartup: vi.fn(), pruneTerminal: vi.fn(),
  } satisfies AppApprovalStore;
  const unsubscribe = vi.fn();
  const broker = createAppApprovalBroker({ store, onRowChanged: (listener) => { changed = listener; return unsubscribe; } });
  close.push(() => broker.close());
  const ask = (controller = new AbortController(), requestKey = "1") => broker.request({ ...request, requestKey }, controller.signal);
  const fill = () => Array.from({ length: APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX }, (_, i) => {
    const controller = new AbortController();
    return { controller, answer: ask(controller, String(i)) };
  });
  return { broker, store, ask, set, fill, unsubscribe };
}

describe("app approval broker", () => {
  it("accepts at once when the store reports an allowed grant", async () => {
    await expect(fixture({ kind: "allowed", approvalId: 1 }).ask()).resolves.toBe("accept");
  });
  it("declines at once for denied or ineligible lookups", async () => {
    await expect(fixture({ kind: "denied", approvalId: 1 }).ask()).resolves.toBe("decline");
    await expect(fixture({ kind: "ineligible", reason: "not mounted" }).ask()).resolves.toBe("decline");
  });
  it("waits on a pending row and accepts when the user allows it", async () => {
    const f = fixture();
    const settled = vi.fn();
    const answer = f.ask().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.set("allowed");
    await answer;
    expect(settled).toHaveBeenCalledWith("accept");
  });
  it("declines a waiting request when the user denies it", async () => {
    const f = fixture();
    const answer = f.ask();
    f.set("denied");
    await expect(answer).resolves.toBe("decline");
  });
  it("declines a waiting request when the row expires", async () => {
    const f = fixture();
    const answer = f.ask();
    await vi.advanceTimersByTimeAsync(100);
    await expect(answer).resolves.toBe("decline");
    expect(f.store.expireDue).toHaveBeenCalledExactlyOnceWith(100);
  });
  it("cancels when the driver aborts the wait and leaves the card open", async () => {
    const f = fixture();
    const controller = new AbortController();
    const answer = f.ask(controller);
    controller.abort();
    await expect(answer).resolves.toBe("cancel");
    expect(f.store.getById().status).toBe("pending");
  });
  it("settles every wait attached to the same row with one decision", async () => {
    const f = fixture();
    const answers = [f.ask(), f.ask(undefined, "2")];
    expect(vi.getTimerCount()).toBe(1);
    f.set("allowed");
    await expect(Promise.all(answers)).resolves.toEqual(["accept", "accept"]);
  });
  it("processEnded ends the rows and settles their waits", async () => {
    const f = fixture();
    const answer = f.ask();
    f.broker.processEnded(1, "p1");
    await expect(answer).resolves.toBe("decline");
    expect(f.store.endProcess).toHaveBeenCalledExactlyOnceWith(1, "p1", "process_exit");
  });
  it("close cancels open waits and declines later requests", async () => {
    const f = fixture();
    const answer = f.ask();
    f.broker.close();
    await expect(answer).resolves.toBe("cancel");
    await expect(f.ask()).resolves.toBe("decline");
    expect(f.unsubscribe).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("declines at the concurrent limit before opening or attaching to a row", async () => {
    const f = fixture();
    f.fill();
    await expect(f.ask(undefined, "overflow")).resolves.toBe("decline");
    expect(f.store.openOrAttach).toHaveBeenCalledTimes(APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX);
  });
  it.each(["allow", "deny", "abort", "expire", "process exit"])("returns a wait slot on %s", async (reason) => {
    const f = fixture();
    const all = f.fill();
    if (reason === "allow") f.set("allowed");
    else if (reason === "deny") f.set("denied");
    else if (reason === "abort") all[0]!.controller.abort();
    else if (reason === "expire") await vi.advanceTimersByTimeAsync(100);
    else f.broker.processEnded(1, "p1");
    await all[0]!.answer;
    f.store.openOrAttach.mockReturnValue({ kind: "allowed", approvalId: 2 });
    await expect(f.ask(undefined, "replacement")).resolves.toBe("accept");
  });
});
