// Invariant: a quick-chat session holds at most TOPBAR_ROUTER_POPOVER_TURNS_MAX distinct non-empty clientIds in oldest-first order.
import { ROUTER_COMMAND_MAX_CHARS } from "../shared/index.ts";
import { TOPBAR_ROUTER_POPOVER_TURNS_MAX } from "./limits.ts";
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

const NO_TURNS: readonly RouterTurnEntry[] = [];

/**
 * Precondition: clientId is a non-empty string.
 * Postcondition: returns a session with open set to true and clientId appended once, dropping the oldest clientIds when the count exceeds TOPBAR_ROUTER_POPOVER_TURNS_MAX.
 * Throws RangeError when clientId is blank.
 */
export function recordQuickTurn(session: TopBarRouterSession, clientId: string): TopBarRouterSession {
  if (clientId.trim() === "") throw new RangeError("A quick Router turn needs a clientId");
  if (session.clientIds.includes(clientId)) return session.open ? session : { open: true, clientIds: session.clientIds };
  const ids = [...session.clientIds, clientId];
  return { open: true, clientIds: ids.length > TOPBAR_ROUTER_POPOVER_TURNS_MAX ? ids.slice(-TOPBAR_ROUTER_POPOVER_TURNS_MAX) : ids };
}

const quickTurnsCache = new WeakMap<
  readonly string[],
  { live: readonly RouterTurnEntry[]; pending: readonly RouterTurnEntry[]; value: readonly RouterTurnEntry[] }
>();

/**
 * Precondition: sessionClientIds are ordered oldest-first; liveTurns and pendingTurns are normalized Router turn arrays.
 * Postcondition: returns turns matching sessionClientIds in session order, preferring liveTurns over pendingTurns on matching clientId, omitting unknown ids, and returning the same array reference when inputs are unchanged.
 */
export function selectQuickRouterTurns(
  sessionClientIds: readonly string[],
  liveTurns: readonly RouterTurnEntry[],
  pendingTurns: readonly RouterTurnEntry[],
): readonly RouterTurnEntry[] {
  if (sessionClientIds.length === 0) return NO_TURNS;
  const hit = quickTurnsCache.get(sessionClientIds);
  if (hit !== undefined && hit.live === liveTurns && hit.pending === pendingTurns) return hit.value;
  const wanted = new Set(sessionClientIds);
  const byClientId = new Map<string, RouterTurnEntry>();
  for (const turn of pendingTurns) if (wanted.has(turn.clientId)) byClientId.set(turn.clientId, turn);
  for (const turn of liveTurns) if (wanted.has(turn.clientId)) byClientId.set(turn.clientId, turn);
  const turns = sessionClientIds.flatMap((id) => byClientId.get(id) ?? []);
  const same = hit !== undefined && hit.value.length === turns.length && turns.every((t, i) => t === hit.value[i]);
  const value = same ? hit.value : turns.length === 0 ? NO_TURNS : turns;
  quickTurnsCache.set(sessionClientIds, { live: liveTurns, pending: pendingTurns, value });
  return value;
}

/**
 * Precondition: drafts are raw strings from the top-bar input, popover reply input, and full Router composer.
 * Postcondition: returns the full Router composer's next draft on Expand: the non-blank existing draft, top-bar draft, and popover draft joined by newlines in that order, so nothing typed is dropped; returns null when both quick drafts are blank.
 */
export function handoffQuickDraft(topBarDraft: string, popoverDraft: string, existingRouterDraft: string): string | null {
  if (topBarDraft.trim() === "" && popoverDraft.trim() === "") return null;
  return [existingRouterDraft, topBarDraft, popoverDraft].filter((d) => d.trim() !== "").join("\n");
}

/**
 * Precondition: text is raw user input from the top-bar field or popover reply row.
 * Postcondition: trims text and returns ok when non-empty and within ROUTER_COMMAND_MAX_CHARS Unicode code points, or reason "empty" or "too_long" otherwise.
 */
export function canSubmitQuickMessage(text: string): QuickMessageValidation {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if ([...trimmed].length > ROUTER_COMMAND_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, trimmed };
}

const TABBABLE_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';

/**
 * Precondition: root is a rendered element or null.
 * Postcondition: returns root's keyboard-focusable descendants in DOM order, skipping disabled controls, negative tabindex, and hidden or inert subtrees.
 */
export function tabbablesIn(root: Element | null): HTMLElement[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(
    (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.closest("[hidden], [inert]") === null,
  );
}

/**
 * Precondition: target is the event target of a pointer-down outside the reply popover content; anchor is the top-bar input wrapper element or null.
 * Postcondition: returns false when target lies inside anchor or inside an open dialog overlay or dialog content (such as FilePreview), and true otherwise.
 */
export function shouldDismissOnTopBarOutsidePress(target: Element | null, anchor: HTMLElement | null): boolean {
  if (target === null) return true;
  if (anchor !== null && anchor.contains(target)) return false;
  return target.closest('[data-slot="dialog-content"], [data-slot="dialog-overlay"]') === null;
}
