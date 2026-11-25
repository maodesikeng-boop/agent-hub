import { describe, expect, it } from "vitest";
import { INFO_PAGES, infoPageTitle, infoRowsOf, type InfoRowsInput } from "./info-rows.ts";
import { parseRoute, routeHash } from "./route.ts";
import { makePersonaChange } from "./test-utils.ts";

function baseInput(overrides: Partial<InfoRowsInput> = {}): InfoRowsInput {
  return {
    pm: { archivedAt: null },
    persona: { text: "Keep changes small.", mode: "manage_only", changes: [makePersonaChange({ id: 1 }), makePersonaChange({ id: 2 })] },
    modelText: "Opus 5.5 Max",
    folders: [{ path: "/Users/me/code/payments-api", isMain: true }],
    schedules: [{ id: 1 }, { id: 2 }],
    capabilities: { enabled: 12, total: 14 },
    memoryFiles: 3,
    hasProject: true,
    setupCommand: "pnpm install",
    ...overrides,
  };
}

describe("infoRowsOf", () => {
  it("returns Model, Mode, and Folders in the first group", () => {
    const [first] = infoRowsOf(baseInput());
    expect(first).toEqual([
      { page: "model", label: "Model", value: "Opus 5.5 Max" },
      { page: "mode", label: "Mode", value: "Orchestrate" },
      { page: "folders", label: "Folders", value: "payments-api" },
    ]);
  });

  it("returns Schedules, Capabilities, Persona, Memory files, Worktree setup, and History in the second group", () => {
    const [, second] = infoRowsOf(baseInput());
    expect(second).toEqual([
      { page: "schedules", label: "Schedules", value: "2" },
      { page: "capabilities", label: "Capabilities", value: "12/14" },
      { page: "persona", label: "Persona", value: "Set" },
      { page: "memory", label: "Memory files", value: "3" },
      { page: "worktree", label: "Worktree setup", value: "Configured" },
      { page: "history", label: "History", value: "2" },
    ]);
  });

  it("omits Worktree setup when the PM has no project", () => {
    const [, second] = infoRowsOf(baseInput({ hasProject: false, setupCommand: null }));
    expect(second!.map((r) => r.page)).toEqual(["schedules", "capabilities", "persona", "memory", "history"]);
    const [, withNone] = infoRowsOf(baseInput({ hasProject: true, setupCommand: null }));
    expect(withNone!.find((r) => r.page === "worktree")?.value).toBe("None");
  });

  it("shows the main folder's name for one folder and the count for several", () => {
    const [one] = infoRowsOf(baseInput({ folders: [{ path: "C:\\work\\bellwood\\", isMain: true }] }));
    expect(one!.find((r) => r.page === "folders")?.value).toBe("bellwood");

    const [many] = infoRowsOf(
      baseInput({
        folders: [
          { path: "/Users/me/code/bellwood", isMain: true },
          { path: "/Users/me/code/docs", isMain: false },
          { path: "/Users/me/code/scripts", isMain: false },
        ],
      }),
    );
    expect(many!.find((r) => r.page === "folders")?.value).toBe("3");

    const [none] = infoRowsOf(baseInput({ folders: [] }));
    expect(none!.find((r) => r.page === "folders")?.value).toBe("None");
  });

  it("omits Capabilities for an archived PM", () => {
    const [, second] = infoRowsOf(baseInput({ pm: { archivedAt: 1_700_000_000_000 } }));
    expect(second!.map((r) => r.page)).toEqual(["schedules", "persona", "memory", "worktree", "history"]);
  });

  it("shows Set or Empty for the persona", () => {
    const [, setRows] = infoRowsOf(baseInput({ persona: { text: "Rule 1", mode: "hands_on", changes: [] } }));
    expect(setRows!.find((r) => r.page === "persona")?.value).toBe("Set");

    const [, emptyRows] = infoRowsOf(baseInput({ persona: { text: "   \n ", mode: "hands_on", changes: [] } }));
    expect(emptyRows!.find((r) => r.page === "persona")?.value).toBe("Empty");
  });

  it("leaves a value null while it is loading", () => {
    const [, second] = infoRowsOf(baseInput({ capabilities: null, memoryFiles: null }));
    expect(second!.find((r) => r.page === "capabilities")?.value).toBeNull();
    expect(second!.find((r) => r.page === "memory")?.value).toBeNull();
  });
});

describe("INFO_PAGES", () => {
  it("parses every Info page from #/pm/<id>/<page> and rejects unknown pages", () => {
    for (const page of INFO_PAGES) {
      expect(infoPageTitle(page).length).toBeGreaterThan(0);
      const route = { view: "profile" as const, pmId: 4, page };
      expect(routeHash(route)).toBe(`#/pm/4/${page}`);
      expect(parseRoute(`#/pm/4/${page}`)).toEqual(route);
    }
    for (const bad of ["#/pm/4/unknown", "#/pm/4/model/extra", "#/pm/4/__proto__", "#/c/4/model", "#/w/4/schedules"]) {
      expect(parseRoute(bad)).toBeNull();
    }
  });
});
