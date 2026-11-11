import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoute, type SettingsRoute } from "../route.ts";
import { mobileBack, settingsParent } from "./back.ts";

it("历史上一页不是父级时 replace 父级，不盲目后退", () => {
  history.replaceState({ hub: true, previous: "#/w/31" }, "", "/#/w/30");
  const back = vi.spyOn(history, "back");
  const replace = vi.fn();
  mobileBack({ view: "conversation", id: 1 }, replace);
  expect(back).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith({ view: "conversation", id: 1 });
  back.mockRestore();
});

it("历史上一页正好是父级时后退，不新增条目", () => {
  history.replaceState({ hub: true, previous: "" }, "", "/#/c/1");
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  const replace = vi.fn();
  mobileBack(null, replace);
  expect(back).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
  back.mockRestore();
});

describe("设置页返回（docs/mobile-settings-design.md 第 2.2 节）", () => {
  it("子页的上级是一级设置，一级设置的上级是列表", () => {
    expect(settingsParent({ view: "settings", section: "browsers" })).toEqual({ view: "settings" });
    expect(settingsParent({ view: "settings" })).toBeNull();
  });

  it("逐级进入后逐级返回都走 history.back", () => {
    history.replaceState({ hub: true, previous: "#/settings" }, "", "/#/settings/browsers");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const replace = vi.fn();
    mobileBack(settingsParent({ view: "settings", section: "browsers" }), replace);
    history.replaceState({ hub: true, previous: "" }, "", "/#/settings");
    mobileBack(settingsParent({ view: "settings" }), replace);
    expect(back).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it("新标签直达子页：连点两次返回依次 replace 到一级设置和列表，历史不增殖、不调 history.back", () => {
    history.replaceState(null, "", "/#/settings/browsers");
    const length = history.length;
    const back = vi.spyOn(history, "back");
    const { result } = renderHook(useRoute);
    act(() => mobileBack(settingsParent(result.current.route as SettingsRoute), result.current.replace));
    expect(location.hash).toBe("#/settings");
    expect(result.current.route).toEqual({ view: "settings" });
    act(() => mobileBack(settingsParent(result.current.route as SettingsRoute), result.current.replace));
    expect(location.hash).toBe("");
    expect(result.current.route).toBeNull();
    expect(back).not.toHaveBeenCalled();
    expect(history.length).toBe(length);
    back.mockRestore();
  });
});
