import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, StateSnapshot } from "../src/shared/index.ts";
import { digestOf, lostAfterRestart, sendAndAwaitReply, type PersistedDigest } from "./verify-steps.ts";

function makeMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  return { conversationId: 1, sessionId: 1, workerId: null, sender: "agent", kind: "text", text: `message ${over.id}`, meta: null, collapsed: false, dedupeKey: `d${over.id}`, status: null, failureReason: null, createdAt: over.id, updatedAt: over.id, ...over };
}

const user = (id: number, text: string, status: Message["status"]) => makeMessage({ id, sender: "user", text, status, sessionId: null });

/** Only the fields the verify steps read; the rest of the snapshot is irrelevant to them. */
function snapshotWith(conversations: Array<{ id: number; messages: Message[] }>): StateSnapshot {
  return {
    pms: [{ id: 1, name: "Bench PM", mode: "manage_only", vendor: "claude", defaultModel: null, effort: null, personaFile: null, createdAt: 1 }],
    conversations: conversations.map(({ id, messages }) => ({ conversation: { id, kind: id === 1 ? "pm" : "assistant", pmId: id === 1 ? 1 : null, projectId: null, title: "c", createdAt: 1 }, messages, hasMore: false })),
  } as unknown as StateSnapshot;
}

describe("digestOf", () => {
  it("keeps only the named conversations and their messages, in id order", () => {
    const state = snapshotWith([
      { id: 2, messages: [makeMessage({ id: 9, conversationId: 2 })] },
      { id: 1, messages: [makeMessage({ id: 5, conversationId: 1 }), user(3, "hi", "replied")] },
    ]);
    const digest = digestOf(state, [1]);
    expect(digest.conversationIds).toEqual([1]);
    expect(digest.messages.map((m) => m.id)).toEqual([3, 5]);
    expect(digest.messages[0]).toEqual({ id: 3, conversationId: 1, sender: "user", text: "hi", status: "replied" });
  });
});

describe("lostAfterRestart", () => {
  const before: PersistedDigest = {
    conversationIds: [1, 2],
    messages: [
      { id: 3, conversationId: 1, sender: "user", text: "hi", status: "replied" },
      { id: 4, conversationId: 1, sender: "agent", text: "ok", status: null },
    ],
  };

  it("returns nothing when every conversation and message survived unchanged", () => {
    expect(lostAfterRestart(before, structuredClone(before))).toEqual([]);
  });

  it("names a conversation that disappeared", () => {
    expect(lostAfterRestart(before, { ...before, conversationIds: [1] })).toEqual(["conversation 2 is missing"]);
  });

  it("names a message that disappeared or whose text or status changed", () => {
    const after: PersistedDigest = { conversationIds: [1, 2], messages: [{ ...before.messages[0]!, status: "failed" }] };
    const lost = lostAfterRestart(before, after);
    expect(lost).toHaveLength(2);
    expect(lost[0]).toMatch(/^message 3 changed: .*"replied".*"failed"/);
    expect(lost[1]).toBe("message 4 in conversation 1 is missing");
    expect(lostAfterRestart(before, { ...before, messages: [before.messages[0]!, { ...before.messages[1]!, text: "changed" }] })).toHaveLength(1);
  });

  it("ignores messages that only exist after the restart", () => {
    const after = { ...before, messages: [...before.messages, { id: 7, conversationId: 1, sender: "system" as const, text: "restarted", status: null }] };
    expect(lostAfterRestart(before, after)).toEqual([]);
  });
});

interface FakeUi {
  page: Page;
  actions: string[];
}

function fakePage(onSend: () => void, replyVisible: () => boolean): FakeUi {
  const actions: string[] = [];
  const clickable = (name: string, onClick = () => {}) => ({
    click: async () => {
      actions.push(`click ${name}`);
      onClick();
    },
  });
  const page = {
    getByRole: (role: string, options: { name: string }) => {
      if (role === "navigation" && options.name === "Workspace") return { locator: () => ({ first: () => clickable("computer") }) };
      if (role === "region" && options.name === "Project managers") return { getByRole: (_role: string, button: { name: string }) => clickable(`pm ${button.name}`) };
      if (role === "textbox") return { fill: async (text: string) => void actions.push(`fill ${text}`) };
      return clickable(options.name, onSend);
    },
    locator: (selector: string) => ({
      waitFor: async ({ timeout }: { timeout: number }) => {
        actions.push(`wait ${selector}`);
        if (!replyVisible()) throw new Error(`Timeout ${timeout}ms exceeded`);
      },
    }),
  };
  return { page: page as unknown as Page, actions };
}

describe("sendAndAwaitReply", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubState(messages: () => Message[]): void {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(snapshotWith([{ id: 1, messages: messages() }])), { status: 200 }));
  }

  it("resolves with the reply id once the fake claude's reply renders and the user message is replied", async () => {
    let sent = false;
    let polls = 0;
    stubState(() => {
      if (!sent) return [];
      polls++;
      return polls < 3 ? [user(10, "verify", "processing")] : [user(10, "verify", "replied"), makeMessage({ id: 11, text: "ok" })];
    });
    const ui = fakePage(() => (sent = true), () => true);
    const trip = await sendAndAwaitReply(ui.page, { origin: "http://127.0.0.1:1", cookie: "c=1", text: "verify", timeoutMs: 5_000 });
    expect(trip).toMatchObject({ conversationId: 1, userMessageId: 10, replyMessageId: 11 });
    expect(ui.actions).toEqual(["click computer", "click pm Bench PM", "fill verify", "click Send", 'wait [data-message-id="11"]']);
  });

  it("rejects naming the step that timed out", async () => {
    stubState(() => [user(10, "verify", "processing")]);
    const ui = fakePage(() => {}, () => true);
    await expect(sendAndAwaitReply(ui.page, { origin: "http://127.0.0.1:1", cookie: "c=1", text: "verify", timeoutMs: 300 })).rejects.toThrow(/^wait for the reply: timed out/);

    stubState(() => [user(10, "verify", "replied"), makeMessage({ id: 11, text: "ok" })]);
    const hidden = fakePage(() => {}, () => false);
    await expect(sendAndAwaitReply(hidden.page, { origin: "http://127.0.0.1:1", cookie: "c=1", text: "verify", timeoutMs: 2_000 })).rejects.toThrow(/^show the reply: /);
  });
});
