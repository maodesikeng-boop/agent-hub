import { describe, it } from "vitest";
import { dialogTabOf, navHash, parseNav, sectionForDialogTab, useWorkbenchNav } from "./workbench-nav.ts";

describe(`${parseNav.name} and ${navHash.name}`, () => {
  it.todo("parses a page hash as that page with settings closed");
  it.todo("parses #/settings/<section> with history state behind as settings over that page");
  it.todo("parses #/settings/<section> without history state as settings over the default page");
  it.todo("ignores a behind hash that names settings or no page");
  it.todo("round-trips page, settings, and the page behind through the hash and history state");
});

describe(`${dialogTabOf.name} and ${sectionForDialogTab.name}`, () => {
  it.todo("maps scale, notifications, and updates to General, sign-in and browsers to Security & Access");
  it.todo("maps Computers to General when the account is not managed");
  it.todo("keeps the current section when a tab that already shows it is picked");
  it.todo("takes the tab's first section when another tab is picked");
});

describe(useWorkbenchNav.name, () => {
  it.todo("returns the same nav object until the URL or history state changes");
  it.todo("opens settings over the current page and closes back to it");
  it.todo("closes settings with history.back() when the previous entry is the page behind");
  it.todo("restores settings and the page behind after a reload");
  it.todo("goes from a settings section to the settings home, then closes, on settingsBack");
  it.todo("never writes the URL when only the layout changes");
});
