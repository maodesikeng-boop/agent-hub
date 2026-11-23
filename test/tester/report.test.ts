import { describe, it } from "vitest";

describe("summarize", () => {
  it.todo("is alert when any alert is a product alert");
  it.todo("is bench when only bench alerts exist");
  it.todo("is clean with no alerts");
  it.todo("counts results by verdict");
});

describe("renderSummary", () => {
  it.todo("starts with the status and counts");
  it.todo("lists each alert and one row per flow");
  it.todo("lists the manual checklist for rc runs");
  it.todo("never prints tokens or secrets and truncates message text to 200 characters");
});
