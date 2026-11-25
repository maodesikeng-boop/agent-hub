import { describe, it } from "vitest";
import { useComputerRename, useProviderSheet } from "./settings-drafts.ts";

describe(useProviderSheet.name, () => {
  it.todo("shares the open sheet between the settings dialog and the one-column Providers page");
  it.todo("keeps the sheet open, with no cancel request, when its presentation unmounts");
  it.todo("cancels a sign-in flow this client owns when the user closes the sheet");
  it.todo("never writes the sheet or anything typed in it to storage");
});

describe(useComputerRename.name, () => {
  it.todo("keeps the typed name when the inline editor gives way to the drawer and back");
  it.todo("replaces a rename in progress when another computer's rename starts");
  it.todo("clears the draft on finish");
});
