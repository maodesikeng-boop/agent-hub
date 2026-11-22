import { describe, it } from "vitest";

describe("sidePanelOf", () => {
  it.todo("shows the Worker for a worker route, whatever the Pieces state");
  it.todo("shows the PM settings summary for a profile route and the page for a profile page route");
  it.todo("shows Pieces for a conversation route only when Pieces is open and has content");
  it.todo("shows nothing for the Router, settings, or an empty route");
  it.todo("keeps the device of a remote route on the content it returns");
});

describe("panelExitsOf", () => {
  it.todo("closes every content kind to the conversation route");
  it.todo("sends a Worker's back arrow to the conversation and opens Pieces");
  it.todo("sends a profile page's back arrow to the settings summary");
  it.todo("gives Pieces and the settings summary no back arrow");
});
