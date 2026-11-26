import { afterEach, describe, expect, it } from "vitest";
import { bundledModelCatalog, vendorSpec } from "../../shared/index.ts";
import { workerOpsFixture } from "../ledger/test-helpers.ts";
import { createRouterDispatcher, type RouterDispatcher } from "./dispatcher.ts";
import { createRouterSandboxGuard } from "./sandbox.ts";
import { createLocalTargetPort, createRouterTargetRegistry, RouterTargetError, type RouterTargetOp } from "./target-port.ts";

const firstRetry = { retryId: "retry-1", fromRetryId: null };
const catalog = bundledModelCatalog("claude");
const preset = vendorSpec("claude").models.routerDefault;

function fixture() {
  const f = workerOpsFixture();
  const first = f.pm;
  const second = f.ledger.createPm({ name: "PM Two", vendor: "claude", mode: "manage_only", persona: "" });
  f.ledger.updateRouterSettings({ vendor: "claude", model: null, effort: null });
  const dispatchers: RouterDispatcher[] = [];
  const targetCalls: RouterTargetOp[] = [];
  const h = {
    turns: 0,
    recipients: [first.pm.id],
    failPlanning: false,
    loseTargetResponse: false,
  };

  function openDispatcher() {
    const localPort = createLocalTargetPort({ deviceId: "device", deviceName: "Device", ledger: f.ledger });
    const registry = createRouterTargetRegistry({
      localPort: {
        ...localPort,
        async executeOp(op) {
          targetCalls.push(op);
          const result = await localPort.executeOp(op);
          if (h.loseTargetResponse) throw new RouterTargetError("device_timeout", "Target response lost");
          return result;
        },
      },
    });
    const sandboxGuard = createRouterSandboxGuard();
    const dispatcher: RouterDispatcher = createRouterDispatcher({
      ledger: f.ledger,
      sandboxGuard,
      targetRegistry: registry,
      models: { list: async () => [{
        ...catalog,
        availability: "available",
        source: "vendor",
        defaultModelId: preset.model,
        models: [{ id: preset.model, label: "Claude", description: null, efforts: ["low", "medium", "high"] }],
      }] },
      resolveAttachment: () => null,
      runTurn: async (request) => {
        const sessionId = ++h.turns;
        const end = request.onSession?.(sessionId);
        try {
          const commandId = sandboxGuard.commandOf(sessionId);
          if (commandId === null || h.failPlanning) throw new Error("Planning interrupted");
          const outcomes = await Promise.allSettled(h.recipients.map((pmId) =>
            dispatcher.handleAgentDispatch(sessionId, commandId, { op: "pm", device: "self", pmId, verbatim: true }),
          ));
          if (outcomes.some((outcome) => outcome.status === "rejected")) throw new Error("Dispatch interrupted");
          return { ok: true, text: "Sent", usage: null, durationMs: 1 };
        } catch (error) {
          return { ok: false, reason: "error", error: String(error), partialText: "", durationMs: 1 };
        } finally {
          end?.();
        }
      },
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  }

  return {
    ...f, first, second, h, targetCalls, openDispatcher,
    messages: () => f.db.all<{ id: number; conversationId: number; text: string }>(
      "SELECT id, conversation_id AS conversationId, text FROM messages WHERE sender = 'user' ORDER BY id",
    ),
    failReceiptWrites: () => f.db.run(`CREATE TRIGGER test_router_receipt_fault BEFORE UPDATE OF dispatched_json ON router_commands
      WHEN NEW.dispatched_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END`),
    restoreReceiptWrites: () => f.db.run("DROP TRIGGER test_router_receipt_fault"),
    async close() {
      for (const dispatcher of dispatchers) await dispatcher.close();
      await f.close();
    },
  };
}

describe("Router delivery recovery", () => {
  const fixtures: ReturnType<typeof fixture>[] = [];
  function setup() {
    const f = fixture();
    fixtures.push(f);
    return f;
  }
  afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.close();
  });

  it("allows a normal retry to replan when no target operation was attempted", async () => {
    const f = setup();
    const dispatcher = f.openDispatcher();
    f.h.failPlanning = true;
    const failed = await dispatcher.submitCommand({ clientId: "no-delivery", text: "Send this" });
    expect(failed.status).toBe("failed");
    expect(f.messages()).toEqual([]);

    f.h.failPlanning = false;
    f.h.recipients = [f.second.pm.id];
    const result = await dispatcher.retryCommand(failed.id, firstRetry);
    expect(result).toMatchObject({ status: "dispatched", dispatched: [{ pmId: f.second.pm.id }] });
    expect(f.h.turns).toBe(2);
    expect(f.messages()).toMatchObject([{ conversationId: f.second.conversation.id, text: "Send this" }]);
  });

  it.each(["planned", "direct"])("finishes only the receipt after a %s delivery has committed", async (track) => {
    const f = setup();
    const dispatcher = f.openDispatcher();
    f.failReceiptWrites();
    const accepted = await dispatcher.submitCommand({
      clientId: "receipt-failure",
      text: "Send this",
      ...(track === "direct" ? { target: { pmId: f.first.pm.id } } : {}),
    }, { background: true });
    await expect.poll(() => f.ledger.getRouterCommand(accepted.id)?.status).toBe("failed");
    const before = f.messages();
    expect(before).toMatchObject([{ conversationId: f.first.conversation.id, text: "Send this" }]);
    expect(f.ledger.getRouterCommand(accepted.id)?.dispatched).toBeNull();

    f.restoreReceiptWrites();
    f.h.recipients = [f.second.pm.id];
    const result = await dispatcher.retryCommand(accepted.id, firstRetry);
    expect(result).toMatchObject({
      status: "dispatched", dispatched: [{ pmId: f.first.pm.id, messageId: before[0]?.id, verbatim: true }],
    });
    expect(f.h.turns).toBe(track === "planned" ? 1 : 0);
    expect(f.targetCalls).toHaveLength(1);
    expect(f.messages()).toEqual(before);
  });

  it("uses the original delivery identity after restart and a lost target response", async () => {
    const f = setup();
    const dispatcher = f.openDispatcher();
    f.h.loseTargetResponse = true;
    f.db.run(`CREATE TRIGGER test_router_stop_before_outcome BEFORE UPDATE OF status ON router_commands
      WHEN OLD.status = 'planning' AND NEW.status != 'planning'
      BEGIN SELECT RAISE(ABORT, 'injected interruption before outcome'); END`);
    await expect(dispatcher.submitCommand({ clientId: "restart", text: "Send this" })).rejects.toThrow("injected interruption");
    const stuck = f.ledger.listRouterCommands().commands[0]!;
    expect(stuck.status).toBe("planning");
    const before = f.messages();
    expect(before).toMatchObject([{ conversationId: f.first.conversation.id, text: "Send this" }]);
    await dispatcher.close();

    f.h.loseTargetResponse = false;
    f.h.recipients = [f.second.pm.id];
    f.db.run("DROP TRIGGER test_router_stop_before_outcome");
    f.ledger.recoverAfterRestart();
    const result = await f.openDispatcher().retryCommand(stuck.id, firstRetry);
    expect(result).toMatchObject({ status: "dispatched", dispatched: [{ pmId: f.first.pm.id, messageId: before[0]?.id }] });
    expect(f.h.turns).toBe(1);
    expect(f.targetCalls).toEqual([f.targetCalls[0], f.targetCalls[0]]);
    expect(f.messages()).toEqual(before);
  });

  it("recovers concurrent deliveries with a single atomic retry claim", async () => {
    const f = setup();
    const dispatcher = f.openDispatcher();
    f.h.recipients = [f.first.pm.id, f.second.pm.id];
    f.failReceiptWrites();
    const accepted = await dispatcher.submitCommand({ clientId: "concurrent", text: "Send this" }, { background: true });
    await expect.poll(() => f.ledger.getRouterCommand(accepted.id)?.status).toBe("failed");
    const before = f.messages();
    expect(before).toMatchObject([
      { conversationId: f.first.conversation.id },
      { conversationId: f.second.conversation.id },
    ]);

    f.restoreReceiptWrites();
    const [claimed, rejected] = await Promise.allSettled([
      dispatcher.retryCommand(accepted.id, firstRetry),
      dispatcher.retryCommand(accepted.id, { retryId: "competing-retry", fromRetryId: null }),
    ]);
    expect(claimed).toMatchObject({ status: "fulfilled", value: {
      status: "dispatched", plan: { retryId: firstRetry.retryId },
      dispatched: expect.arrayContaining(before.map(({ id }, i) => expect.objectContaining({
        pmId: [f.first.pm.id, f.second.pm.id][i], messageId: id,
      }))),
    } });
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
    expect(f.h.turns).toBe(1);
    expect(f.targetCalls).toHaveLength(2);
    expect(f.messages()).toEqual(before);
  });
});
