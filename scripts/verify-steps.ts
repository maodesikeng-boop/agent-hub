// The two verify checks that go past "the workbench rendered": one message round trip through the real UI with the
// fake claude, and a restart on the same data directory. Both stay local and cost well under a second each.
import type { Page } from "playwright";
import { API_PATHS, type Message, type StateSnapshot } from "../src/shared/index.ts";

const POLL_MS = 50;

export interface RoundTrip {
  conversationId: number;
  userMessageId: number;
  replyMessageId: number;
  replyMs: number;
}

interface StepClock {
  deadline: number;
  timeoutMs: number;
}

async function fetchState(origin: string, cookie: string): Promise<StateSnapshot> {
  const res = await fetch(`${origin}${API_PATHS.state}`, { headers: { cookie, origin } });
  if (res.status !== 200) throw new Error(`GET ${API_PATHS.state}: HTTP ${res.status}`);
  return (await res.json()) as StateSnapshot;
}

function remaining(clock: StepClock, step: string): number {
  const left = clock.deadline - Date.now();
  if (left <= 0) throw new Error(`${step}: timed out after ${clock.timeoutMs / 1000} s`);
  return left;
}

async function pollState<T>(origin: string, cookie: string, clock: StepClock, step: string, pick: (state: StateSnapshot) => T | undefined): Promise<T> {
  for (;;) {
    const found = pick(await fetchState(origin, cookie));
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, remaining(clock, step))));
    remaining(clock, step);
  }
}

function firstPm(state: StateSnapshot): { conversationId: number; name: string } {
  const pm = state.pms.find((p) => !p.archivedAt);
  const conversation = pm && state.conversations.find((c) => c.conversation.kind === "pm" && c.conversation.pmId === pm.id);
  if (!pm || !conversation) throw new Error("open the project manager: the fresh data directory has no project manager conversation");
  return { conversationId: conversation.conversation.id, name: pm.name };
}

function replyAfter(state: StateSnapshot, conversationId: number, text: string): { userMessageId: number; replyMessageId: number } | undefined {
  const messages = state.conversations.find((c) => c.conversation.id === conversationId)?.messages ?? [];
  const user = messages.find((m) => m.sender === "user" && m.text === text);
  if (user?.status !== "replied") return undefined;
  const reply = messages.find((m) => m.id > user.id && m.sender === "agent" && m.kind === "text" && m.text.trim() !== "");
  return reply ? { userMessageId: user.id, replyMessageId: reply.id } : undefined;
}

async function withStep<T>(step: string, clock: StepClock, run: (timeout: number) => Promise<T>): Promise<T> {
  try {
    return await run(remaining(clock, step));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(`${step}:`) ? message : `${step}: ${message}`);
  }
}

/**
 * Precondition: `page` shows the workbench of a fresh data directory with the fake claude as the default vendor.
 * Postcondition: opens the first project manager in the sidebar, types `text` in the composer, sends it, and resolves once
 * the fake claude's reply is visible in the message list and the user message is stored as replied.
 * Rejects naming the step that timed out after `timeoutMs`. Console errors stay the caller's check.
 */
export async function sendAndAwaitReply(page: Page, input: { origin: string; cookie: string; text: string; timeoutMs: number }): Promise<RoundTrip> {
  const clock: StepClock = { deadline: Date.now() + input.timeoutMs, timeoutMs: input.timeoutMs };
  const pm = firstPm(await fetchState(input.origin, input.cookie));
  await withStep("open the project manager", clock, async (timeout) => {
    await page.getByRole("navigation", { name: "Workspace" }).locator('button:has([data-testid^="rail-device-dot-"])').first().click({ timeout });
    await page.getByRole("region", { name: "Project managers" }).getByRole("button", { name: pm.name, exact: true }).click({ timeout: remaining(clock, "open the project manager") });
  });
  const sentAt = await withStep("send the message", clock, async (timeout) => {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(input.text, { timeout });
    const started = performance.now();
    await page.getByRole("button", { name: "Send", exact: true }).click({ timeout: remaining(clock, "send the message") });
    return started;
  });
  const ids = await withStep("wait for the reply", clock, () => pollState(input.origin, input.cookie, clock, "wait for the reply", (s) => replyAfter(s, pm.conversationId, input.text)));
  await withStep("show the reply", clock, async (timeout) => {
    await page.locator(`[data-message-id="${ids.replyMessageId}"]`).waitFor({ state: "visible", timeout });
  });
  return { conversationId: pm.conversationId, ...ids, replyMs: performance.now() - sentAt };
}

export interface PersistedDigest {
  conversationIds: number[];
  messages: Array<Pick<Message, "id" | "conversationId" | "sender" | "text" | "status">>;
}

/** Postcondition: the conversations and the messages of `conversationIds` from a snapshot, in id order. */
export function digestOf(state: StateSnapshot, conversationIds: readonly number[]): PersistedDigest {
  const wanted = new Set(conversationIds);
  const kept = state.conversations.filter((c) => wanted.has(c.conversation.id));
  return {
    conversationIds: kept.map((c) => c.conversation.id).sort((a, b) => a - b),
    messages: kept
      .flatMap((c) => c.messages)
      .map(({ id, conversationId, sender, text, status }) => ({ id, conversationId, sender, text, status }))
      .sort((a, b) => a.id - b.id),
  };
}

/** Postcondition: one line per conversation or message present in `before` but missing or changed in `after`; empty when nothing was lost. */
export function lostAfterRestart(before: PersistedDigest, after: PersistedDigest): string[] {
  const conversations = new Set(after.conversationIds);
  const messages = new Map(after.messages.map((m) => [m.id, m]));
  const lost = before.conversationIds.filter((id) => !conversations.has(id)).map((id) => `conversation ${id} is missing`);
  for (const m of before.messages) {
    const now = messages.get(m.id);
    if (now === undefined) lost.push(`message ${m.id} in conversation ${m.conversationId} is missing`);
    else if (now.text !== m.text || now.status !== m.status || now.sender !== m.sender || now.conversationId !== m.conversationId) {
      lost.push(`message ${m.id} changed: ${JSON.stringify(m)} -> ${JSON.stringify(now)}`);
    }
  }
  return lost;
}
