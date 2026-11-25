import type { PersonaView, Pm, ProjectFolder, ScheduleRecord } from "../shared/index.ts";

// Invariant: the Info tab is a list of rows that each open one existing editor; values here are display text only.

/** Drill-down pages of the Info tab; route.ts parses `#/pm/<id>/<page>` against this list. */
export const INFO_PAGES = ["model", "mode", "folders", "schedules", "capabilities", "persona", "memory", "worktree", "history"] as const;
export type InfoPage = (typeof INFO_PAGES)[number];

export interface InfoRow {
  page: InfoPage;
  label: string;
  /** Right-aligned muted value, or null when the row shows only the chevron. */
  value: string | null;
}

export interface InfoRowsInput {
  pm: Pick<Pm, "archivedAt">;
  persona: Pick<PersonaView, "text" | "mode" | "changes">;
  modelText: string;
  folders: readonly Pick<ProjectFolder, "path" | "isMain">[];
  schedules: readonly Pick<ScheduleRecord, "id">[];
  /** Enabled and total capabilities, or null while loading. */
  capabilities: { enabled: number; total: number } | null;
  /** Memory file count, or null while loading. */
  memoryFiles: number | null;
  hasProject: boolean;
  setupCommand: string | null;
}

/**
 * Postcondition: returns two groups. The first holds Model (model and effort, such as `Opus 5.5 Max`), Mode, and
 * Folders (the main folder's name, or the count when there are several). The second holds Schedules (count),
 * Capabilities (`enabled/total`, omitted for an archived PM), Persona (`Set` or `Empty`), Memory files (count), then
 * Worktree setup and History while those rows are kept. A value still loading is null.
 */
export function infoRowsOf(_input: InfoRowsInput): readonly (readonly InfoRow[])[] {
  throw new Error("Not implemented");
}

/** Postcondition: the header title of an Info page, such as `Memory files`. */
export function infoPageTitle(_page: InfoPage): string {
  throw new Error("Not implemented");
}
