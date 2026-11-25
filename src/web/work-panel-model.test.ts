import { describe, it } from "vitest";

describe("activeWorkOf", () => {
  it.todo("drops ended Workers and Workers bound to an active graph step");
  it.todo("counts graphs plus standalone Workers");
  it.todo("returns the same object for the same graphs and workers arrays");
});

describe("completedDaysOf", () => {
  it.todo("groups items into Today, Yesterday, and short dates in the viewer's time zone, newest day first");
  it.todo("keeps the server's order inside a day");
  it.todo("drops an item already shown on an earlier page");
  it.todo("returns the same array for the same pages and the same day");
  it.todo("stays within COMPLETED_WORK_MAX_PAGES times COMPLETED_WORK_PAGE_SIZE items");
});

describe("completedKeyOf", () => {
  it.todo("never collides between a graph and a Worker with the same numeric id");
});

describe("prLabelOf", () => {
  it.todo("returns #<number> for a pull request URL ending in a number");
  it.todo("returns null for null or a URL without a trailing number");
});

describe("stepTargetOf", () => {
  it.todo("opens the step's live Worker, else its most recent Worker");
  it.todo("opens the ask card for a step waiting on the user with no Worker");
  it.todo("returns none for a pending step with no Worker");
});
