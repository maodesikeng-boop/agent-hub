import { describe, expect, it } from "vitest";
import { type Pm } from "../shared/index.ts";
import { defaultLookOf } from "../shared/slimes.ts";
import { filterProjectList, isPinned, projectListOf } from "./project-list.ts";
import type { ConversationEntry } from "./selectors.ts";
import { makePm, makeProject } from "./test-utils.ts";

function makeEntry(id: number, overrides: { name?: string; projectName?: string; archived?: boolean; pinnedAt?: number | null } = {}): ConversationEntry {
  const archived = overrides.archived ?? false;
  const pm: Pm = makePm({
    id,
    name: overrides.name ?? `PM ${id}`,
    archivedAt: archived ? 1_000 : null,
    ...(overrides.pinnedAt !== undefined ? { pinnedAt: overrides.pinnedAt } : {}),
  });
  return {
    id,
    name: pm.name,
    look: defaultLookOf(id),
    lastMessage: null,
    lastAt: id * 100,
    pm,
    project: makeProject({
      id,
      pmId: id,
      conversationId: id,
      name: overrides.projectName ?? `project-${id}`,
      status: archived ? "archived" : "active",
    }),
    folders: [],
  };
}

describe("isPinned", () => {
  it("is true only for an unarchived PM with a numeric pinnedAt", () => {
    expect(isPinned(makeEntry(1, { pinnedAt: 500 }))).toBe(true);
    expect(isPinned(makeEntry(2, { pinnedAt: null }))).toBe(false);
    expect(isPinned(makeEntry(3, { pinnedAt: 500, archived: true }))).toBe(false);
    const noPm: ConversationEntry = { ...makeEntry(4), pm: null };
    expect(isPinned(noPm)).toBe(false);
  });

  it("treats a missing pinnedAt from an older daemon as not pinned", () => {
    expect(isPinned(makeEntry(1))).toBe(false);
  });
});

describe("projectListOf", () => {
  it("orders pinned PMs by pinnedAt, oldest first, with ties broken by PM id", () => {
    const entries = [
      makeEntry(8, { pinnedAt: 300 }),
      makeEntry(5, { pinnedAt: 200 }),
      makeEntry(3, { pinnedAt: 200 }),
      makeEntry(1, { pinnedAt: 100 }),
    ];
    expect(projectListOf(entries).pinned.map((e) => e.id)).toEqual([1, 3, 5, 8]);
  });

  it("keeps active entries in the incoming most-recent-first order", () => {
    const entries = [makeEntry(9), makeEntry(2), makeEntry(7)];
    expect(projectListOf(entries).active.map((e) => e.id)).toEqual([9, 2, 7]);
  });

  it("moves an archived pinned PM to archived instead of pinned", () => {
    const entries = [makeEntry(1, { pinnedAt: 100 }), makeEntry(2, { pinnedAt: 50, archived: true })];
    const sections = projectListOf(entries);
    expect(sections.pinned.map((e) => e.id)).toEqual([1]);
    expect(sections.archived.map((e) => e.id)).toEqual([2]);
  });

  it("places every entry in exactly one section", () => {
    const entries = [makeEntry(1, { pinnedAt: 10 }), makeEntry(2), makeEntry(3, { archived: true }), makeEntry(4, { pinnedAt: 20, archived: true })];
    const sections = projectListOf(entries);
    const all = [...sections.pinned, ...sections.active, ...sections.archived];
    expect(all.map((e) => e.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(new Set(all.map((e) => e.id)).size).toBe(4);
  });

  it("returns the same sections object for the same entries array", () => {
    const entries = [makeEntry(1, { pinnedAt: 10 }), makeEntry(2)];
    expect(projectListOf(entries)).toBe(projectListOf(entries));
  });
});

describe("filterProjectList", () => {
  it("matches PM names and project names without regard to case", () => {
    const sections = projectListOf([
      makeEntry(1, { name: "Router Helper", projectName: "alpha-api", pinnedAt: 10 }),
      makeEntry(2, { name: "Docs Keeper", projectName: "Beta-Web" }),
      makeEntry(3, { name: "Old Runner", projectName: "gamma-web", archived: true }),
    ]);
    const byProject = filterProjectList(sections, "  WEB ");
    expect(byProject.pinned).toEqual([]);
    expect(byProject.active.map((e) => e.id)).toEqual([2]);
    expect(byProject.archived.map((e) => e.id)).toEqual([3]);

    const byName = filterProjectList(sections, "router");
    expect(byName.pinned.map((e) => e.id)).toEqual([1]);
    expect(byName.active).toEqual([]);
  });

  it("returns the input sections for a blank query", () => {
    const sections = projectListOf([makeEntry(1)]);
    expect(filterProjectList(sections, "")).toBe(sections);
    expect(filterProjectList(sections, "   \t ")).toBe(sections);
  });
});
