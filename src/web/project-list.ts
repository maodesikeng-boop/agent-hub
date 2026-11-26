import type { ConversationEntry } from "./selectors.ts";

// Invariant: every entry of one computer lands in exactly one section, and sections keep the incoming order except pinned.

export interface ProjectListSections {
  /** Unarchived PMs with a pinnedAt, oldest pin first, ties broken by PM id. */
  pinned: readonly ConversationEntry[];
  /** Every other unarchived entry, in the incoming order of most recent activity first. */
  active: readonly ConversationEntry[];
  /** Archived PMs, in the incoming order. */
  archived: readonly ConversationEntry[];
}

const sectionsCache = new WeakMap<readonly ConversationEntry[], ProjectListSections>();

/** Postcondition: true when the entry's PM has a numeric pinnedAt and is not archived. */
export function isPinned(entry: ConversationEntry): boolean {
  return entry.pm !== null && entry.pm.archivedAt == null && typeof entry.pm.pinnedAt === "number" && Number.isFinite(entry.pm.pinnedAt);
}

/**
 * Precondition: entries is the listConversations result for one computer.
 * Postcondition: splits entries into pinned, active, and archived sections and returns the same object for the same
 * entries array.
 */
export function projectListOf(entries: readonly ConversationEntry[]): ProjectListSections {
  const hit = sectionsCache.get(entries);
  if (hit !== undefined) return hit;

  const pinned: ConversationEntry[] = [];
  const active: ConversationEntry[] = [];
  const archived: ConversationEntry[] = [];

  for (const entry of entries) {
    if (entry.pm?.archivedAt != null) archived.push(entry);
    else if (isPinned(entry)) pinned.push(entry);
    else active.push(entry);
  }

  pinned.sort((a, b) => a.pm!.pinnedAt! - b.pm!.pinnedAt! || a.pm!.id - b.pm!.id);

  const sections: ProjectListSections = { pinned, active, archived };
  sectionsCache.set(entries, sections);
  return sections;
}

/**
 * Postcondition: keeps entries whose name or project name contains the trimmed query, ignoring case, in every section;
 * a blank query returns sections unchanged.
 */
export function filterProjectList(sections: ProjectListSections, query: string): ProjectListSections {
  const needle = query.trim().toLowerCase();
  if (needle === "") return sections;
  const matches = (entry: ConversationEntry): boolean =>
    entry.name.toLowerCase().includes(needle) || (entry.project?.name.toLowerCase().includes(needle) ?? false);
  return {
    pinned: sections.pinned.filter(matches),
    active: sections.active.filter(matches),
    archived: sections.archived.filter(matches),
  };
}
