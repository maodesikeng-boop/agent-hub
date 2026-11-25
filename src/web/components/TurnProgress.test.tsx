import { describe, it } from "vitest";

describe("TurnProgress", () => {
  it.todo("running with steps renders the rows with rail and status icons, then one action line with the live time");
  it.todo("running without steps renders only the action line");
  it.todo("a pending action renders without a live time");
  it.todo("ended renders one collapsed Worked for line and no elapsed time elsewhere in the turn");
  it.todo("opening Worked for shows the checklist below the line and moves the reply down");
  it.todo("opening a step shows only that step's process");
  it.todo("an ended turn without steps opens the flat process log");
  it.todo("the in-progress row text is semibold and the icons match the task graph set");
  it.todo("rows and chevrons are keyboard focusable with visible focus");
});

describe("ActionElapsed", () => {
  it.todo("advances every ACTION_ELAPSED_TICK_MS and clears its timer on unmount");
});
