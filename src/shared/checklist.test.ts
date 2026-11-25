import { describe, it } from "vitest";

describe("normalizeChecklistStatus", () => {
  it.todo("maps pending, in_progress, inProgress, TODO_STATUS_IN_PROGRESS, completed, done, and cancelled words from every fixture");
  it.todo("returns null for an unknown word, a number, or a missing status");
});

describe("applyChecklistUpdate", () => {
  it.todo("replace lists the input items in order and derives t:<title> ids for items without a vendor id");
  it.todo("replace suffixes repeated titles so ids stay unique");
  it.todo("replace with zero items clears the list");
  it.todo("merge updates status, title, and activeTitle of the item with the same id in place");
  it.todo("merge appends an unknown id only when the patch has a title and a status");
  it.todo("remove drops listed ids and ignores unknown ones");
  it.todo("trims and clips titles to CHECKLIST_TITLE_MAX_CHARS and drops empty titles");
  it.todo("drops items past CHECKLIST_MAX_ITEMS");
  it.todo("never mutates the previous snapshot");
});

describe("sameChecklist", () => {
  it.todo("is true for equal items in the same order and false when any field or the order differs");
});

describe("activeChecklistItemId", () => {
  it.todo("returns the first in-progress item id, or null when none is in progress");
});

describe("checklistOf", () => {
  it.todo("returns the stored snapshot of a checklist message");
  it.todo("returns null for other message kinds and for meta that breaks the invariant");
});
