import { describe, it } from "vitest";

describe("WorkPanelHeader", () => {
  it.todo("shows Active N, Completed N, and Info as tabs and moves between them with arrow keys");
  it.todo("never shows the word Pieces anywhere in the panel");
});

describe("workPanelOf", () => {
  it.todo("gives the Worker for a worker route and Info with its page for a profile route");
  it.todo("gives the remembered tab on an open conversation route and null when closed");
  it.todo("gives null on the Router and settings routes");
});

describe("workPanelExitsOf", () => {
  it.todo("sends Worker back to the conversation with the panel open on the remembered tab");
  it.todo("sends an Info page back to the Info summary");
});

describe("ActiveTab", () => {
  it.todo("renders one section per active graph with its title and done/total");
  it.todo("switches a graph to the vertical list when its canvas does not fit and back when it does");
  it.todo("lists standalone Workers under Workers as 26px rows");
  it.todo("opens the Worker of a step, or the ask card of a step waiting on the user");
  it.todo("shows the empty state when nothing is running");
});

describe("CompletedTab", () => {
  it.todo("groups rows by day with a count per day");
  it.todo("shows the PR label as a link and the finish time");
  it.todo("expands a graph row into its steps as the vertical list");
  it.todo("greys out a cancelled row with the slashed ring");
  it.todo("loads the next page at the end and stops after COMPLETED_WORK_MAX_PAGES");
  it.todo("shows loading, empty, error with Retry, and an inline retry row for a failed next page");
});

describe("InfoTab", () => {
  it.todo("shows the frameless avatar, name, project, and the two row groups");
  it.todo("opens the look picker from the avatar and shows the pencil badge on hover");
  it.todo("opens each row's existing editor with a back arrow");
  it.todo("shows New session and a red Archive, and the archive status group for an archived PM");
});

describe("WorkerDetailHeader", () => {
  it.todo("shows back, status icon, title, the ⋯ menu, and Close with no meta line");
  it.todo("lists model and effort, duration, branch, Stop, and End inside the ⋯ menu");
  it.todo("hides Stop when nothing runs and End when the Worker already ended");
});

describe("WorkerReportText", () => {
  it.todo("renders the summary, a bold question, and file chips with no field labels");
});
