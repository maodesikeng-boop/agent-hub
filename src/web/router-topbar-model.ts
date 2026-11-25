// Invariant: a quick-chat session holds at most TOPBAR_ROUTER_POPOVER_TURNS_MAX distinct non-empty clientIds in oldest-first order.
import type { RouterTurnEntry } from "./router-stream.ts";

export interface TopBarRouterSession {
  readonly open: boolean;
  readonly clientIds: readonly string[];
}

export const CLOSED_TOPBAR_SESSION: TopBarRouterSession = {
  open: false,
  clientIds: [],
};

export type QuickMessageValidation =
  | { readonly ok: true; readonly trimmed: string }
  | { readonly ok: false; readonly reason: "empty" | "too_long" };

/**
 * Precondition: clientId is a non-empty string.
 * Postcondition: returns a session with open set to true and clientId appended once, dropping the oldest clientIds when the count exceeds TOPBAR_ROUTER_POPOVER_TURNS_MAX.
 * Throws RangeError when clientId is blank.
 */
export function recordQuickTurn(_session: TopBarRouterSession, _clientId: string): TopBarRouterSession {
  throw new Error("Not implemented");
}

/**
 * Precondition: session is a valid TopBarRouterSession.
 * Postcondition: returns CLOSED_TOPBAR_SESSION, reusing CLOSED_TOPBAR_SESSION when session is already closed with no clientIds.
 */
export function closeQuickSession(_session: TopBarRouterSession): TopBarRouterSession {
  throw new Error("Not implemented");
}

/**
 * Precondition: sessionClientIds are ordered oldest-first; liveTurns and pendingTurns are normalized Router turn arrays.
 * Postcondition: returns turns matching sessionClientIds in session order, preferring liveTurns over pendingTurns on matching clientId, omitting unknown ids, and returning the same array reference when inputs are unchanged.
 */
export function selectQuickRouterTurns(
  _sessionClientIds: readonly string[],
  _liveTurns: readonly RouterTurnEntry[],
  _pendingTurns: readonly RouterTurnEntry[],
): readonly RouterTurnEntry[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: drafts are raw strings from the top-bar input, popover reply input, and full Router composer.
 * Postcondition: returns non-blank popoverDraft, else non-blank topBarDraft, to carry into the full Router composer on Expand; returns null when both are blank or when existingRouterDraft is already non-blank.
 */
export function handoffQuickDraft(_topBarDraft: string, _popoverDraft: string, _existingRouterDraft: string): string | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: text is raw user input from the top-bar field or popover reply row.
 * Postcondition: trims text and returns ok when non-empty and within ROUTER_COMMAND_MAX_CHARS Unicode code points, or reason "empty" or "too_long" otherwise.
 */
export function canSubmitQuickMessage(_text: string): QuickMessageValidation {
  throw new Error("Not implemented");
}

/**
 * Precondition: target is the event target of a pointer-down outside the reply popover content; anchor is the top-bar input wrapper element or null.
 * Postcondition: returns false when target lies inside anchor or inside an open dialog overlay or dialog content (such as FilePreview), and true otherwise.
 */
export function shouldDismissOnTopBarOutsidePress(_target: Element | null, _anchor: HTMLElement | null): boolean {
  throw new Error("Not implemented");
}
