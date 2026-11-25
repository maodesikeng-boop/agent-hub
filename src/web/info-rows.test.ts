import { describe, it } from "vitest";

describe("infoRowsOf", () => {
  it.todo("returns Model, Mode, and Folders in the first group");
  it.todo("returns Schedules, Capabilities, Persona, Memory files, Worktree setup, and History in the second group");
  it.todo("omits Worktree setup when the PM has no project");
  it.todo("shows the main folder's name for one folder and the count for several");
  it.todo("omits Capabilities for an archived PM");
  it.todo("shows Set or Empty for the persona");
  it.todo("leaves a value null while it is loading");
});

describe("INFO_PAGES", () => {
  it.todo("parses every Info page from #/pm/<id>/<page> and rejects unknown pages");
});
