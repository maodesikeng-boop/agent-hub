import type { Message } from "../shared/index.ts";

// Invariant: text the user or a PM typed keeps its written position and always starts a new turn, as before.

export type SystemInputPlacement =
  /** Not taken in yet: shown after everything else and never closes the running turn. */
  | "waiting"
  /** Taken in by a running turn: shown inside that turn at the point it was read. */
  | "in_turn"
  /** Started a new turn: shown right before that turn and closes the previous one. */
  | "starts_turn"
  /** No stamp and no longer waiting: keeps its written position, and starts a turn only when its status is `replied`. */
  | "as_written";

/**
 * Postcondition: returns null for messages that are not system-queued inputs (user and PM text, agent output,
 * plain notices). For system-queued inputs, a `meta.taken` stamp decides `in_turn` or `starts_turn`; without a
 * stamp, `queued` or `delivered` status means `waiting`, and any other status means `as_written`.
 */
export function systemInputPlacement(_message: Message): SystemInputPlacement | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: returns `messages` reordered so each stamped system input sits right after the message its
 * `afterId` names (or after the last earlier message when that one is not loaded), and every `waiting` input sits
 * at the end in id order. All other messages keep their relative order. Returns the same array reference when
 * nothing moves, and the same result reference for the same input array.
 */
export function placeSystemInputs(_messages: readonly Message[]): readonly Message[] {
  throw new Error("Not implemented");
}
