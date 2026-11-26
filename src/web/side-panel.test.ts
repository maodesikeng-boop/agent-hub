import { describe, expect, it } from "vitest";
import { workPanelExitsOf, workPanelOf } from "./side-panel.ts";

const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

describe("workPanelOf", () => {
  it("shows the Worker for a worker route regardless of panel open state", () => {
    expect(workPanelOf({ route: { view: "worker", id: 30 }, open: false, tab: "active" })).toEqual({
      kind: "worker",
      workerId: 30,
    });
    expect(workPanelOf({ route: { view: "worker", id: 30 }, open: true, tab: "completed" })).toEqual({
      kind: "worker",
      workerId: 30,
    });
  });

  it("shows Info summary for a profile route and the page for an Info drill-down route", () => {
    expect(workPanelOf({ route: { view: "profile", pmId: 4 }, open: false, tab: "active" })).toEqual({
      kind: "info",
      pmId: 4,
      page: null,
    });
    expect(workPanelOf({ route: { view: "profile", pmId: 4, page: "memory" }, open: false, tab: "active" })).toEqual({
      kind: "info",
      pmId: 4,
      page: "memory",
    });
  });

  it("shows the remembered Active or Completed tab on a conversation route only when open", () => {
    expect(workPanelOf({ route: { view: "conversation", id: 2 }, open: true, tab: "active" })).toEqual({
      kind: "tab",
      tab: "active",
    });
    expect(workPanelOf({ route: { view: "conversation", id: 2 }, open: true, tab: "completed" })).toEqual({
      kind: "tab",
      tab: "completed",
    });
    expect(workPanelOf({ route: { view: "conversation", id: 2 }, open: false, tab: "active" })).toBeNull();
  });

  it("returns null for Router, settings, or an empty route", () => {
    expect(workPanelOf({ route: { view: "router" }, open: true, tab: "active" })).toBeNull();
    expect(workPanelOf({ route: { view: "settings" }, open: true, tab: "active" })).toBeNull();
    expect(workPanelOf({ route: null, open: true, tab: "active" })).toBeNull();
  });
});

describe("workPanelExitsOf", () => {
  const conv = { view: "conversation", id: 12 } as const;
  const remoteConv = { view: "conversation", id: 12, device: TOKYO } as const;

  it("closes every content kind back to the conversation route", () => {
    expect(workPanelExitsOf({ kind: "tab", tab: "active" }, conv).close).toEqual(conv);
    expect(workPanelExitsOf({ kind: "worker", workerId: 30 }, conv).close).toEqual(conv);
    expect(workPanelExitsOf({ kind: "info", pmId: 5, page: null }, conv).close).toEqual(conv);
    expect(workPanelExitsOf({ kind: "info", pmId: 5, page: "history" }, conv).close).toEqual(conv);
  });

  it("sends a Worker back arrow to the conversation and an Info page back arrow to Info summary", () => {
    expect(workPanelExitsOf({ kind: "worker", workerId: 30 }, conv)).toEqual({
      close: conv,
      back: conv,
    });
    expect(workPanelExitsOf({ kind: "info", pmId: 5, page: "worktree" }, remoteConv)).toEqual({
      close: remoteConv,
      back: { view: "profile", pmId: 5, device: TOKYO },
    });
  });

  it("gives top-level tabs and Info summary no back arrow", () => {
    expect(workPanelExitsOf({ kind: "tab", tab: "active" }, conv)).toEqual({ close: conv, back: null });
    expect(workPanelExitsOf({ kind: "info", pmId: 5, page: null }, conv)).toEqual({ close: conv, back: null });
  });
});
