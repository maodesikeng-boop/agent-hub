import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useComputerRename, useProviderSheet } from "./settings-drafts.ts";

it("keeps one provider sheet in memory, with stable identity until the target or mode changes", () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    const { result, rerender } = renderHook(useProviderSheet);
    act(() => result.current.open({ deviceKey: "", vendor: "claude", mode: "account" }));
    const sheet = result.current.sheet;
    rerender();
    expect(result.current.sheet).toBe(sheet);
    act(() => result.current.setMode("signin"));
    expect(result.current.sheet).toEqual({ ...sheet, mode: "signin" });
    act(() => result.current.close());
    expect(result.current.sheet).toBeNull();
    expect(storage).not.toHaveBeenCalled();
  } finally {
    storage.mockRestore();
  }
});

it("replaces an earlier rename when another device starts editing, and clears it on finish", () => {
  const { result } = renderHook(useComputerRename);
  act(() => result.current.start("", "Mac"));
  act(() => result.current.setName("Office Mac"));
  expect(result.current.rename).toEqual({ deviceKey: "", name: "Office Mac" });
  act(() => result.current.start("remote", "Tokyo"));
  expect(result.current.rename).toEqual({ deviceKey: "remote", name: "Tokyo" });
  act(() => result.current.finish());
  act(() => result.current.setName("Ignored"));
  expect(result.current.rename).toBeNull();
});
