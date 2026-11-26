import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogTabOf, navHash, parseNav, sectionForDialogTab, useWorkbenchNav } from "./workbench-nav.ts";

afterEach(() => vi.restoreAllMocks());

it("parses a page or settings above its underlying page", () => {
  expect(parseNav("#/c/4", null)).toEqual({ page: { view: "conversation", id: 4 }, settings: null });
  const historyState = { behind: "#/pm/4/persona", providerDevice: "" };
  const nav = parseNav("#/settings/capabilities", historyState);
  expect(nav).toEqual({ page: { view: "profile", pmId: 4, page: "persona" }, settings: { section: "capabilities", providerDevice: "" } });
  expect(parseNav(navHash(nav), historyState)).toEqual(nav);
  expect(parseNav("#/settings/resources", null)).toEqual({ page: null, settings: { section: "resources" } });
  expect(parseNav("#/settings", { behind: "#/settings/scale" })).toEqual({ page: null, settings: {} });
  expect(parseNav("#/no-such-route", null)).toEqual({ page: null, settings: null });
});

it("maps phone sections to their dialog tabs without discarding the current section", () => {
  for (const section of ["scale", "notifications", "updates"] as const) expect(dialogTabOf(section, true)).toBe("general");
  for (const section of ["sign-in", "browsers"] as const) expect(dialogTabOf(section, true)).toBe("security");
  expect(dialogTabOf("computers", false)).toBe("general");
  expect(dialogTabOf("computers", true)).toBe("computers");
  expect(sectionForDialogTab("general", "notifications", false)).toBe("notifications");
  expect(sectionForDialogTab("general", "providers", false)).toBe("scale");
});

it("uses browser history to restore an underlying page, including after a remount", async () => {
  history.replaceState(null, "", "/#/pm/4/persona");
  const first = renderHook(useWorkbenchNav);
  act(() => first.result.current.openSettings({ section: "capabilities" }));
  expect(location.hash).toBe("#/settings/capabilities");
  expect(first.result.current.nav.page).toEqual({ view: "profile", pmId: 4, page: "persona" });
  first.unmount();
  const { result, rerender } = renderHook(useWorkbenchNav);
  expect(result.current.nav.settings?.section).toBe("capabilities");
  const before = result.current.nav;
  rerender();
  expect(result.current.nav).toBe(before);
  const length = history.length;
  act(() => result.current.closeSettings());
  await waitFor(() => expect(result.current.nav.settings).toBeNull());
  expect(location.hash).toBe("#/pm/4/persona");
  expect(history.length).toBe(length);
});

it("steps from a phone section to home, then closes Settings onto the page behind it", async () => {
  history.replaceState(null, "", "/#/router");
  const { result } = renderHook(useWorkbenchNav);
  act(() => result.current.openSettings());
  act(() => result.current.showSettingsSection("providers"));
  act(() => result.current.showSettingsSection("resources"));
  expect(location.hash).toBe("#/settings/resources");
  act(() => result.current.settingsBack());
  await waitFor(() => expect(location.hash).toBe("#/settings"));
  act(() => result.current.settingsBack());
  await waitFor(() => expect(location.hash).toBe("#/router"));
});

it("can close desktop Settings directly after picking a section from the mobile home", async () => {
  history.replaceState(null, "", "/#/c/5");
  const { result } = renderHook(useWorkbenchNav);
  act(() => result.current.openSettings());
  act(() => result.current.showSettingsSection("scale"));
  act(() => result.current.closeSettings());
  await waitFor(() => expect(location.hash).toBe("#/c/5"));
});

it("returns from a direct settings link without adding a history entry", () => {
  history.replaceState(null, "", "/#/settings/browsers");
  const length = history.length;
  const { result } = renderHook(useWorkbenchNav);
  act(() => result.current.settingsBack());
  expect(location.hash).toBe("#/settings");
  act(() => result.current.settingsBack());
  expect(location.hash).toBe("");
  expect(history.length).toBe(length);
});
