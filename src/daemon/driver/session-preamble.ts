import type { DriverOptions, SessionId, SessionPreambleOptions } from "../../shared/index.ts";

export interface PreambleHolder {
  preambleTaken: boolean;
}

export interface PreambleTaken {
  note: string | null;
  restore: () => void;
}

export function takeSessionPreamble(
  sessionPreamble: DriverOptions["sessionPreamble"],
  sessionId: SessionId,
  holder: PreambleHolder,
  onError: (error: unknown) => void,
  options?: SessionPreambleOptions,
): PreambleTaken | null {
  if (!sessionPreamble || holder.preambleTaken) return null;
  let note: string | null;
  try {
    note = options === undefined ? sessionPreamble(sessionId) : sessionPreamble(sessionId, options);
  } catch (error) {
    onError(error);
    return null;
  }
  // Claim the Turn 1 opening window even when budget forced note === null so Turn 2 never injects a preamble mid-session.
  holder.preambleTaken = true;
  return {
    note,
    restore: () => {
      holder.preambleTaken = false;
    },
  };
}
