import type { ConversationId, MessageId } from "../../shared/domain.ts";
import type { FeishuCardId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_STREAM_FLUSH_MS, FEISHU_STREAM_RENEW_MS } from "../../shared/limits.ts";
import { feishuMarkdownPrefix } from "./outbound.ts";

export type FeishuStreamState =
  | { phase: "idle" }
  | { phase: "quiet" }
  | { phase: "failed" }
  | {
      phase: "opening";
      sentText: string;
      text: string;
      status: string;
      pending: { kind: "finalize"; messageId: MessageId; text: string; turnActive: boolean } | { kind: "abandon" } | null;
      failure: FeishuTurnFailure | null;
    }
  | {
      phase: "live";
      cardId: FeishuCardId;
      messageId: FeishuMessageId;
      sequence: number;
      sentText: string;
      text: string;
      status: string;
      lastFlushAt: number;
      streamingSince: number;
    };

export type FeishuStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "working"; status: string }
  | { kind: "open_failed" }
  | { kind: "opened"; cardId: FeishuCardId; messageId: FeishuMessageId; sequence: number }
  | { kind: "segment_done"; messageId: MessageId; text: string; turnActive?: boolean }
  | { kind: "turn_end" }
  | { kind: "turn_failed"; failure: FeishuTurnFailure }
  | { kind: "tick" };

export interface FeishuTurnFailure {
  key: string;
  note: string;
}

export type FeishuStreamEffect =
  | { kind: "open"; text: string }
  | { kind: "push"; cardId: FeishuCardId; text: string; sequence: number }
  | { kind: "renew"; cardId: FeishuCardId; sequence: number }
  | { kind: "finalize"; cardId: FeishuCardId | null; sequence: number; messageId: MessageId; text: string }
  | { kind: "abandon"; cardId: FeishuCardId; sequence: number; text: string }
  | { kind: "discard"; cardId: FeishuCardId; messageId: FeishuMessageId; sequence: number }
  | { kind: "notice"; failure: FeishuTurnFailure }
  | { kind: "schedule_tick"; at: number };

export interface FeishuStreamTarget {
  conversationId: ConversationId;
  chatId: FeishuChatId;
}

export function stepFeishuStream(
  state: FeishuStreamState,
  event: FeishuStreamEvent,
  target: FeishuStreamTarget,
  now: number,
  budget: FeishuCardkitBudget,
): { state: FeishuStreamState; effects: FeishuStreamEffect[] } {
  const idle: FeishuStreamState = { phase: "idle" };
  const afterSegment = (turnActive: boolean | undefined): FeishuStreamState => (turnActive === true ? { phase: "quiet" } : idle);
  // Every message a failed turn carries fails at once, so the turn shows one failure until the next turn starts.
  const failed: FeishuStreamState = { phase: "failed" };
  switch (state.phase) {
    case "failed":
      if (event.kind === "turn_failed" || event.kind === "tick") return { state, effects: [] };
      return stepFeishuStream(idle, event, target, now, budget);
    case "idle":
    case "quiet":
      if (event.kind === "turn_failed") return { state: failed, effects: [{ kind: "notice", failure: event.failure }] };
      if (event.kind === "text" && event.text !== "") {
        const sentText = feishuMarkdownPrefix(event.text);
        return { state: { phase: "opening", sentText, text: event.text, status: "", pending: null, failure: null }, effects: [{ kind: "open", text: sentText }] };
      }
      if (event.kind === "working" && state.phase === "idle" && event.status !== "") {
        return { state: { phase: "opening", sentText: event.status, text: "", status: event.status, pending: null, failure: null }, effects: [{ kind: "open", text: event.status }] };
      }
      if (event.kind === "segment_done") {
        return { state: afterSegment(event.turnActive), effects: [{ kind: "finalize", cardId: null, sequence: 0, messageId: event.messageId, text: event.text }] };
      }
      if (event.kind === "turn_end") return { state: idle, effects: [] };
      return { state, effects: [] };
    case "opening":
      switch (event.kind) {
        case "text":
          return { state: { ...state, text: event.text }, effects: [] };
        case "working":
          return { state: { ...state, status: event.status }, effects: [] };
        case "segment_done":
          return {
            state: { ...state, pending: { kind: "finalize", messageId: event.messageId, text: event.text, turnActive: event.turnActive === true } },
            effects: [],
          };
        case "turn_end":
          return state.pending === null ? { state: { ...state, pending: { kind: "abandon" } }, effects: [] } : { state, effects: [] };
        case "turn_failed":
          return { state: { ...state, pending: state.pending ?? { kind: "abandon" }, failure: state.failure ?? event.failure }, effects: [] };
        case "tick":
          return { state, effects: [] };
        case "open_failed": {
          const notice = noticeOf(state.failure);
          return state.pending?.kind === "finalize"
            ? { state: settled(afterSegment(state.pending.turnActive), state.failure), effects: [{ kind: "finalize", cardId: null, sequence: 0, messageId: state.pending.messageId, text: state.pending.text }, ...notice] }
            : { state: settled(idle, state.failure), effects: notice };
        }
        case "opened": {
          const sequence = event.sequence + 1;
          if (state.pending?.kind === "finalize") {
            const { messageId, text, turnActive } = state.pending;
            const finalize: FeishuStreamEffect = { kind: "finalize", cardId: event.cardId, sequence, messageId, text };
            return { state: settled(afterSegment(turnActive), state.failure), effects: [finalize, ...noticeOf(state.failure)] };
          }
          if (state.pending?.kind === "abandon") {
            return { state: settled(idle, state.failure), effects: closing(event.cardId, event.messageId, sequence, state.text, state.failure) };
          }
          const live: Live = {
            phase: "live",
            cardId: event.cardId,
            messageId: event.messageId,
            sequence: event.sequence,
            sentText: state.sentText,
            text: state.text,
            status: state.status,
            lastFlushAt: now,
            streamingSince: now,
          };
          return keepTicking(flush(live, now, budget));
        }
      }
      return { state, effects: [] };
    case "live":
      switch (event.kind) {
        case "text":
          return keepTicking(flush({ ...state, text: event.text }, now, budget));
        case "working":
          return keepTicking(flush({ ...state, status: event.status }, now, budget));
        case "tick": {
          // Feishu closes streaming mode after 10 minutes, so reopen it before that.
          if (now - state.streamingSince < FEISHU_STREAM_RENEW_MS) return keepTicking(flush(state, now, budget));
          const renewed: Live = { ...state, sequence: state.sequence + 1, streamingSince: now };
          const after = keepTicking(flush(renewed, now, budget));
          return { state: after.state, effects: [{ kind: "renew", cardId: state.cardId, sequence: renewed.sequence }, ...after.effects] };
        }
        case "segment_done":
          return {
            state: afterSegment(event.turnActive),
            effects: [{ kind: "finalize", cardId: state.cardId, sequence: state.sequence + 1, messageId: event.messageId, text: event.text }],
          };
        case "turn_end":
          return { state: idle, effects: closing(state.cardId, state.messageId, state.sequence + 1, state.text, null) };
        case "turn_failed":
          return { state: failed, effects: closing(state.cardId, state.messageId, state.sequence + 1, state.text, event.failure) };
        case "open_failed":
        case "opened":
          return { state, effects: [] };
      }
  }
}

// A card that never got reply text is recalled, unless the turn failed: then the card carries the reason instead.
function closing(cardId: FeishuCardId, messageId: FeishuMessageId, sequence: number, text: string, failure: FeishuTurnFailure | null): FeishuStreamEffect[] {
  if (text !== "") return [{ kind: "abandon", cardId, sequence, text: feishuMarkdownPrefix(text) }, ...noticeOf(failure)];
  if (failure !== null) return [{ kind: "abandon", cardId, sequence, text: feishuMarkdownPrefix(failure.note) }];
  return [{ kind: "discard", cardId, messageId, sequence }];
}

const noticeOf = (failure: FeishuTurnFailure | null): FeishuStreamEffect[] => (failure === null ? [] : [{ kind: "notice", failure }]);

const settled = (next: FeishuStreamState, failure: FeishuTurnFailure | null): FeishuStreamState => (failure === null ? next : { phase: "failed" });

type Live = Extract<FeishuStreamState, { phase: "live" }>;

function keepTicking(result: { state: FeishuStreamState; effects: FeishuStreamEffect[] }): { state: FeishuStreamState; effects: FeishuStreamEffect[] } {
  if (result.state.phase !== "live" || result.effects.some((e) => e.kind === "schedule_tick")) return result;
  return { state: result.state, effects: [...result.effects, { kind: "schedule_tick", at: result.state.streamingSince + FEISHU_STREAM_RENEW_MS }] };
}

function flush(live: Live, now: number, budget: FeishuCardkitBudget): { state: FeishuStreamState; effects: FeishuStreamEffect[] } {
  const text = live.text === "" ? live.status : feishuMarkdownPrefix(live.text);
  if (text === live.sentText) return { state: live, effects: [] };
  const due = live.lastFlushAt + FEISHU_STREAM_FLUSH_MS;
  if (now < due) return { state: live, effects: [{ kind: "schedule_tick", at: due }] };
  if (!budget.tryTake(now)) return { state: live, effects: [{ kind: "schedule_tick", at: now + FEISHU_STREAM_FLUSH_MS }] };
  const sequence = live.sequence + 1;
  return { state: { ...live, sequence, sentText: text, lastFlushAt: now }, effects: [{ kind: "push", cardId: live.cardId, text, sequence }] };
}

export interface FeishuCardkitBudget {
  tryTake(now: number): boolean;
}

export function createFeishuCardkitBudget(perSecond: number | (() => number)): FeishuCardkitBudget {
  const taken: number[] = [];
  return {
    tryTake(now) {
      const limit = Math.max(1, Math.floor(typeof perSecond === "function" ? perSecond() : perSecond));
      while (taken.length > 0 && now - taken[0]! >= 1000) {
        taken.shift();
      }
      if (taken.length >= limit) return false;
      taken.push(now);
      return true;
    },
  };
}
