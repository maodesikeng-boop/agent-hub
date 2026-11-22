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

/** Postcondition: true when the entry's PM has a numeric pinnedAt and is not archived. */
export function isPinned(entry: ConversationEntry): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: entries is the listConversations result for one computer.
 * Postcondition: splits entries into pinned, active, and archived sections and returns the same object for the same
 * entries array.
 */
export function projectListOf(entries: readonly ConversationEntry[]): ProjectListSections {
  throw new Error("Not implemented");
}

/**
 * Postcondition: keeps entries whose name or project name contains the trimmed query, ignoring case, in every section;
 * a blank query returns sections unchanged.
 */
export function filterProjectList(sections: ProjectListSections, query: string): ProjectListSections {
  throw new Error("Not implemented");
}
