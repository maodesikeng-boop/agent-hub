import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "../shared/domain.ts";
import { defaultLookOf } from "../shared/slimes.ts";
import type { TurnSummary } from "../shared/turn.ts";
import { TurnView } from "./components/Messages.tsx";
import { groupMessages, liveTurnKeyOf, workedForMsOf, type TurnItem } from "./selectors.ts";
import { applyTurnUpdate, initialState, type HubState } from "./state.ts";
import { makeConversation, makeMessage, makeSystemMessage, makeToolMessage, makeUserMessage } from "./test-utils.ts";

const T0 = 1_000_000;
const at = (seconds: number) => ({ createdAt: T0 + seconds * 1_000, updatedAt: T0 + seconds * 1_000 });

const messages: Message[] = [
  makeUserMessage({ id: 1, text: "Start", ...at(0) }),
  makeMessage({ id: 2, kind: "checklist", text: "", collapsed: true, meta: { checklist: [{ id: "a", title: "Check work", activeTitle: null, status: "in_progress" }] }, ...at(27) }),
  makeSystemMessage({ id: 3, sessionId: 1, text: "Task Graph cancelled", event: { event: "pm.wakeup", source: "task_graph", ref: "1" }, ...at(30) }),
  makeToolMessage({ id: 4, text: "Bash: run tests", ...at(35) }),
  makeUserMessage({ id: 5, text: "Follow up", ...at(50) }),
  makeMessage({ id: 6, text: "Answer", ...at(58) }),
];

function summary(over: Partial<TurnSummary> & Pick<TurnSummary, "id">): TurnSummary {
  return {
    sessionId: 1, conversationId: 1, cause: "input", status: "ended", outcome: "ok", stopSource: null, parentTurnId: null,
    startedAt: T0, endedAt: T0 + 45_000, durationMs: 45_000, firstOutputId: 2, lastOutputId: 4,
    inputs: [{ messageId: 1, role: "opening", afterMessageId: null }, { messageId: 3, role: "mid_turn", afterMessageId: 2 }],
    background: null,
    ...over,
  };
}

const first = summary({ id: 10 });
const second = summary({
  id: 11, startedAt: T0 + 50_000, endedAt: T0 + 62_000, durationMs: 12_000, firstOutputId: 6, lastOutputId: 6,
  inputs: [{ messageId: 5, role: "opening", afterMessageId: 4 }],
});
const turnCards = (items: ReturnType<typeof groupMessages>["items"]) => items.filter((item): item is TurnItem => item.kind === "turn");

describe("turn cards read the daemon's turn", () => {
  it("shows one card per daemon turn with the daemon duration, and a mid-turn notice does not split it", () => {
    const cards = turnCards(groupMessages(messages, [first, second]).items);
    expect(cards.map((c) => [c.turnId, c.durationMs])).toEqual([[10, 45_000], [11, 12_000]]);
    expect(cards[0]!.checklists.map((m) => m.id)).toEqual([2]);
    expect(cards[0]!.work.map((m) => m.id)).toEqual([4]);
    expect(cards.map(workedForMsOf)).toEqual([45_000, 12_000]);
  });

  it("keeps a running turn live and has no Worked for value until it ends", () => {
    const running = summary({ id: 11, status: "running", outcome: null, endedAt: null, durationMs: null, startedAt: T0 + 50_000, firstOutputId: 6, lastOutputId: 6, inputs: [{ messageId: 5, role: "opening", afterMessageId: 4 }] });
    const grouped = groupMessages(messages, [first, running]);
    const cards = turnCards(grouped.items);
    expect(workedForMsOf(cards[1]!)).toBeNull();
    expect(liveTurnKeyOf(grouped, 11)).toBe(cards[1]!.key);
    expect(liveTurnKeyOf(grouped, 10)).toBeNull();
    expect(liveTurnKeyOf(grouped, null)).toBeNull();
  });

  it("keeps the message-time estimate for history written before the turn ledger", () => {
    const cards = turnCards(groupMessages(messages).items);
    expect(cards.every((c) => c.turnId === null)).toBe(true);
    expect(workedForMsOf(cards[0]!)).toBe(cards[0]!.endedAt - cards[0]!.startedAt);
  });

  it("returns the same grouping for the same inputs and a new one when the summaries change", () => {
    const turns = [first, second];
    const grouped = groupMessages(messages, turns);
    expect(groupMessages(messages, turns)).toBe(grouped);
    expect(groupMessages(messages, [first, { ...second, durationMs: 13_000 }])).not.toBe(grouped);
  });

  it("renders Worked for 45s from the daemon duration, not the span of the last output", () => {
    const card = turnCards(groupMessages(messages, [first, second]).items)[0]!;
    render(<TurnView turn={card} identity={{ name: "PM", look: defaultLookOf(1) }} status={null} stepStartedAt={null}
      actions={{ retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() }} />);
    expect(screen.getByRole("button", { name: /Worked for 45s/ })).toBeTruthy();
  });
});

describe("turn.updated", () => {
  const loaded = (): HubState => ({
    ...initialState,
    conversations: {
      1: { conversation: makeConversation({ id: 1 }), messages, hasMore: false, turns: [first] },
      2: { conversation: makeConversation({ id: 2 }), messages: [], hasMore: false },
    },
  });

  it("replaces the summary by id and leaves other conversations untouched", () => {
    const state = loaded();
    const ended = { ...first, durationMs: 46_000 };
    const next = applyTurnUpdate(state, ended);
    expect(next.conversations[1]!.turns).toEqual([ended]);
    expect(next.conversations[2]).toBe(state.conversations[2]);
    const added = applyTurnUpdate(next, second);
    expect(added.conversations[1]!.turns!.map((t) => t.id)).toEqual([10, 11]);
  });

  it("returns the same state for an identical summary or a conversation that is not loaded", () => {
    const state = loaded();
    expect(applyTurnUpdate(state, { ...first })).toBe(state);
    expect(applyTurnUpdate(state, { ...first, conversationId: 99 })).toBe(state);
  });
});

it("never lets a stale running summary replace the ended one", () => {
  const state: HubState = {
    ...initialState,
    conversations: { 1: { conversation: makeConversation({ id: 1 }), messages, hasMore: false, turns: [first] } },
  };
  const stale = { ...first, status: "running" as const, outcome: null, endedAt: null, durationMs: null };
  expect(applyTurnUpdate(state, stale)).toBe(state);
});
