import { describe, expect, it } from "vitest";
import { panelExitsOf, sidePanelOf } from "./side-panel.ts";

const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

describe("sidePanelOf", () => {
  it("shows the Worker for a worker route, whatever the Pieces state", () => {
    expect(sidePanelOf({ route: { view: "worker", id: 30 }, piecesOpen: false, piecesHasContent: false })).toEqual({
      kind: "worker",
      workerId: 30,
    });
    expect(sidePanelOf({ route: { view: "worker", id: 30 }, piecesOpen: true, piecesHasContent: true })).toEqual({
      kind: "worker",
      workerId: 30,
    });
  });

  it("shows the PM settings summary for a profile route and the page for a profile page route", () => {
    expect(sidePanelOf({ route: { view: "profile", pmId: 4 }, piecesOpen: false, piecesHasContent: false })).toEqual({
      kind: "profile",
      pmId: 4,
      page: null,
    });
    expect(sidePanelOf({ route: { view: "profile", pmId: 4, page: "memory" }, piecesOpen: false, piecesHasContent: false })).toEqual({
      kind: "profile",
      pmId: 4,
      page: "memory",
    });
  });

  it("shows Pieces for a conversation route only when Pieces is open and has content", () => {
    expect(sidePanelOf({ route: { view: "conversation", id: 2 }, piecesOpen: true, piecesHasContent: true })).toEqual({
      kind: "pieces",
    });
    expect(sidePanelOf({ route: { view: "conversation", id: 2 }, piecesOpen: false, piecesHasContent: true })).toBeNull();
    expect(sidePanelOf({ route: { view: "conversation", id: 2 }, piecesOpen: true, piecesHasContent: false })).toBeNull();
  });

  it("shows nothing for the Router, settings, or an empty route", () => {
    expect(sidePanelOf({ route: { view: "router" }, piecesOpen: true, piecesHasContent: true })).toBeNull();
    expect(sidePanelOf({ route: { view: "settings" }, piecesOpen: true, piecesHasContent: true })).toBeNull();
    expect(sidePanelOf({ route: null, piecesOpen: true, piecesHasContent: true })).toBeNull();
  });

  it("keeps the device of a remote route on the content it returns", () => {
    expect(
      sidePanelOf({ route: { view: "worker", id: 30, device: TOKYO }, piecesOpen: false, piecesHasContent: false }),
    ).toEqual({ kind: "worker", workerId: 30 });
    expect(
      sidePanelOf({ route: { view: "profile", pmId: 7, page: "persona", device: TOKYO }, piecesOpen: false, piecesHasContent: false }),
    ).toEqual({ kind: "profile", pmId: 7, page: "persona" });
    expect(
      panelExitsOf(
        { kind: "profile", pmId: 7, page: "persona" },
        { view: "conversation", id: 12, device: TOKYO },
      ),
    ).toEqual({
      close: { view: "conversation", id: 12, device: TOKYO },
      back: { view: "profile", pmId: 7, device: TOKYO },
      backOpensPieces: false,
    });
  });
});

describe("panelExitsOf", () => {
  const conv = { view: "conversation", id: 12 } as const;

  it("closes every content kind to the conversation route", () => {
    expect(panelExitsOf({ kind: "pieces" }, conv).close).toEqual(conv);
    expect(panelExitsOf({ kind: "worker", workerId: 30 }, conv).close).toEqual(conv);
    expect(panelExitsOf({ kind: "profile", pmId: 5, page: null }, conv).close).toEqual(conv);
    expect(panelExitsOf({ kind: "profile", pmId: 5, page: "history" }, conv).close).toEqual(conv);
  });

  it("sends a Worker's back arrow to the conversation and opens Pieces", () => {
    expect(panelExitsOf({ kind: "worker", workerId: 30 }, conv)).toEqual({
      close: conv,
      back: conv,
      backOpensPieces: true,
    });
  });

  it("sends a profile page's back arrow to the settings summary", () => {
    expect(panelExitsOf({ kind: "profile", pmId: 5, page: "worktree" }, conv)).toEqual({
      close: conv,
      back: { view: "profile", pmId: 5 },
      backOpensPieces: false,
    });
  });

  it("gives Pieces and the settings summary no back arrow", () => {
    expect(panelExitsOf({ kind: "pieces" }, conv)).toEqual({
      close: conv,
      back: null,
      backOpensPieces: false,
    });
    expect(panelExitsOf({ kind: "profile", pmId: 5, page: null }, conv)).toEqual({
      close: conv,
      back: null,
      backOpensPieces: false,
    });
  });
});
