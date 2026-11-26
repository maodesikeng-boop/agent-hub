import { expect, it } from "vitest";
import type { DriverEvent } from "../../shared/driver.ts";
import type { TurnSummary } from "../../shared/turn.ts";
import { workerOpsFixture } from "./test-helpers.ts";

it("projects the same turn through changes, snapshots, lookup, and message pages", async () => {
  const f = workerOpsFixture();
  const { ledger, pm } = f;
  const { id } = pm.conversation;
  const summaries: TurnSummary[] = [];
  const unsubscribe = ledger.onChange((change) => {
    if (change.type === "turn.updated") summaries.push(change.data.turn);
  });
  const emit = (event: DriverEvent) => ledger.applyDriverEvent(pm.sessionId, event);
  try {
    const { messageId } = ledger.postUserMessage({ conversationId: id, clientId: "one-turn", text: "Start" });
    emit({ type: "message.delivered", at: f.now(), messageIds: [messageId] });
    emit({ type: "message.processing", at: f.now(), messageIds: [messageId] });
    f.advance(27_000);
    emit({ type: "agent.text", at: f.now(), text: "An answer", uuid: "one-output" });
    await ledger.settleDriverEvents();
    const running = ledger.snapshot();
    const turn = running.conversations.find((entry) => entry.conversation.id === id)?.turns?.[0];
    expect(turn?.firstOutputId).toBeTypeOf("number");
    expect(running.sessions.find((session) => session.sessionId === pm.sessionId)?.activeTurnId).toBe(turn?.id);
    expect(summaries).toMatchObject([
      { id: turn?.id, status: "running", firstOutputId: null },
      { id: turn?.id, status: "running", firstOutputId: turn?.firstOutputId },
    ]);

    f.advance(18_000);
    emit({ type: "turn.ended", at: f.now(), messageIds: [messageId], ok: true, interrupted: false, durationMs: 27_000 });
    await ledger.settleDriverEvents();
    const ended = summaries.at(-1);
    expect(ended).toMatchObject({ id: turn?.id, status: "ended", durationMs: 45_000 });
    expect(ledger.snapshot().sessions.find((session) => session.sessionId === pm.sessionId)?.activeTurnId).toBeNull();
    expect(ledger.snapshot().conversations.find((entry) => entry.conversation.id === id)?.turns).toEqual([ended]);
    expect(ledger.lookupConversations({ ids: [id], workerIds: [] }).conversations[0]?.turns).toEqual([ended]);
    expect(ledger.messagesBefore(id, Number.MAX_SAFE_INTEGER).turns).toEqual([ended]);
  } finally {
    unsubscribe();
    await f.close();
  }
});
