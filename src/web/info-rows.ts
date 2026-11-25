import type { PersonaView, Pm, ProjectFolder, ScheduleRecord } from "../shared/index.ts";
import { MODE_LABELS } from "./format.ts";

// Invariant: the Info tab is a list of rows that each open one existing editor; values here are display text only.

/** Drill-down pages of the Info tab; route.ts parses `#/pm/<id>/<page>` against this list. */
export const INFO_PAGES = ["model", "mode", "folders", "schedules", "capabilities", "persona", "memory", "worktree", "history"] as const;
export type InfoPage = (typeof INFO_PAGES)[number];

export function isInfoPage(value: string): value is InfoPage {
  return (INFO_PAGES as readonly string[]).includes(value);
}

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

const INFO_PAGE_TITLES: Readonly<Record<InfoPage, string>> = {
  model: "Model",
  mode: "Mode",
  folders: "Folders",
  schedules: "Schedules",
  capabilities: "Capabilities",
  persona: "Persona",
  memory: "Memory files",
  worktree: "Worktree setup",
  history: "History",
};

export function folderBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function foldersSummary(folders: readonly Pick<ProjectFolder, "path" | "isMain">[]): string {
  if (folders.length === 0) return "None";
  if (folders.length === 1) return folderBaseName(folders[0]!.path);
  return String(folders.length);
}

/**
 * Postcondition: returns two groups. The first holds Model (model and effort, such as `Opus 5.5 Max`), Mode, and
 * Folders (the main folder's name, or the count when there are several). The second holds Schedules (count),
 * Capabilities (`enabled/total`, omitted for an archived PM), Persona (`Set` or `Empty`), Memory files (count),
 * Worktree setup (`Configured` or `None`, only with a project), and History (change count). A value still loading is null.
 */
export function infoRowsOf(input: InfoRowsInput): readonly (readonly InfoRow[])[] {
  const first: InfoRow[] = [
    { page: "model", label: "Model", value: input.modelText },
    { page: "mode", label: "Mode", value: MODE_LABELS[input.persona.mode] },
    { page: "folders", label: "Folders", value: foldersSummary(input.folders) },
  ];
  const second: InfoRow[] = [{ page: "schedules", label: "Schedules", value: String(input.schedules.length) }];
  if (input.pm.archivedAt == null) {
    second.push({
      page: "capabilities",
      label: "Capabilities",
      value: input.capabilities === null ? null : `${input.capabilities.enabled}/${input.capabilities.total}`,
    });
  }
  second.push(
    { page: "persona", label: "Persona", value: input.persona.text.trim() === "" ? "Empty" : "Set" },
    { page: "memory", label: "Memory files", value: input.memoryFiles === null ? null : String(input.memoryFiles) },
  );
  if (input.hasProject) {
    second.push({
      page: "worktree",
      label: "Worktree setup",
      value: input.setupCommand && input.setupCommand.trim() !== "" ? "Configured" : "None",
    });
  }
  second.push({ page: "history", label: "History", value: String(input.persona.changes.length) });
  return [first, second];
}

/** Postcondition: the header title of an Info page, such as `Memory files`. */
export function infoPageTitle(page: InfoPage): string {
  return INFO_PAGE_TITLES[page];
}
