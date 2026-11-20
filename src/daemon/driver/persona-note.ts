import type { AgentSessionRow, DriverOptions, SessionId } from "../../shared/index.ts";

/** codex 0.162 ignores new developerInstructions on thread/resume (smoke S30); rerun S30 after codex upgrades. */
export const CODEX_RESUME_REBAKES = false;

export interface PersonaSeenHolder {
  personaSeen: number | null;
}

export interface PersonaNoteTaken {
  note: string;
  restore: () => void;
}

export function personaSeenAtStart(holder: PersonaSeenHolder, row: AgentSessionRow | null, launched: number | null, rebaked: boolean): number | null {
  if (launched === null) return null;
  if (rebaked) return launched;
  return holder.personaSeen ?? row?.personaRevision ?? 0;
}

export function personaSeenFromRow(row: AgentSessionRow | null): number | null {
  if (row === null) return null;
  return row.personaRevision ?? (row.role === "pm" && row.hasCompletedTurn ? 0 : null);
}

export function takePersonaNote(
  personaNote: DriverOptions["personaNote"],
  sessionId: SessionId,
  holder: PersonaSeenHolder,
  persist: (revision: number) => void,
  onError: (error: unknown) => void,
): PersonaNoteTaken | null {
  const since = holder.personaSeen;
  if (!personaNote || since === null) return null;
  let result: ReturnType<NonNullable<DriverOptions["personaNote"]>>;
  try {
    result = personaNote(sessionId, since);
  } catch (error) {
    onError(error);
    return null;
  }
  if (result === null) return null;
  const revision = result.revision;
  holder.personaSeen = revision;
  persist(revision);
  if (result.note === null) return null;
  return {
    note: result.note,
    restore: () => {
      if (holder.personaSeen !== null && holder.personaSeen <= since) return;
      holder.personaSeen = since;
      persist(since);
    },
  };
}
