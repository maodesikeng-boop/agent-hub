import { act, renderHook } from "@testing-library/react";
// 联机 P3：网址带设备（docs/multi-device-design.md 第 4.1 节）。老网址（不带 #/d/）是入口本机。
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, parseRoute, routeHash, useRoute, type Route } from "./route.ts";

const TOKYO = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

describe("带设备的网址", () => {
  it("#/d/<设备>/c|w|pm/<编号> 来回一致", () => {
    const routes: Route[] = [
      { view: "conversation", id: 12, device: TOKYO },
      { view: "worker", id: 30, device: TOKYO },
      { view: "profile", pmId: 3, device: TOKYO },
    ];
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
    expect(routeHash({ view: "conversation", id: 12, device: TOKYO })).toBe(`#/d/${TOKYO}/c/12`);
    expect(routeHash({ view: "profile", pmId: 3, device: TOKYO })).toBe(`#/d/${TOKYO}/pm/3`);
  });

  it("老网址不带设备，还是原来的样子", () => {
    expect(parseRoute("#/c/7")).toEqual({ view: "conversation", id: 7 });
    expect(parseRoute("#/c/7")).not.toHaveProperty("device");
    expect(routeHash({ view: "worker", id: 7 })).toBe("#/w/7");
  });

  it("全局水果刀工作台网址 #/router 来回一致，且不挂在单台设备路径下", () => {
    expect(routeHash({ view: "router" })).toBe("#/router");
    expect(parseRoute("#/router")).toEqual({ view: "router" });
    expect(parseRoute(`#/d/${TOKYO}/router`)).toBeNull();
    expect(parseRoute("#/router/extra")).toBeNull();
  });

  it("设备编号不合法、少了后半截的都认不出来", () => {
    for (const bad of [
      "#/d/../c/1",
      `#/d/${TOKYO.toUpperCase()}/c/1`,
      "#/d/tokyo/c/1",
      `#/d/${TOKYO}`,
      `#/d/${TOKYO}/`,
      `#/d/${TOKYO}/c/0`,
      `#/d//c/1`,
      `#/d/${TOKYO}/d/${TOKYO}/c/1`,
    ]) {
      expect(parseRoute(bad)).toBeNull();
    }
  });
});

it("push 标记 hub，replace 清除标记并支持列表", () => {
  const { result } = renderHook(useRoute);
  act(() => result.current.navigate({ view: "conversation", id: 1 }));
  expect(history.state).toEqual({ hub: true, previous: "" });
  act(() => result.current.replace(null));
  expect(history.state).toBeNull();
  expect(location.hash).toBe("");
});

describe("设置网址（docs/mobile-settings-design.md 第 2.2 节）", () => {
  it("#/settings 与 8 个子页 #/settings/<section> 来回一致，不挂设备前缀", () => {
    expect(routeHash({ view: "settings" })).toBe("#/settings");
    expect(parseRoute("#/settings")).toEqual({ view: "settings" });
    expect(parseRoute("#/settings")).not.toHaveProperty("section");
    for (const section of SETTINGS_SECTIONS) {
      const route: Route = { view: "settings", section };
      expect(routeHash(route)).toBe(`#/settings/${section}`);
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    expect(SETTINGS_SECTIONS).toEqual([
      "scale",
      "notifications",
      "providers",
      "vendor-sync",
      "computers",
      "sign-in",
      "browsers",
      "public-access",
    ]);
  });

  it("不认识的子页归一为一级设置；带设备前缀、多一层的都认不出来", () => {
    for (const hash of ["#/settings/bogus", "#/settings/", "#/settings/Scale", "#/settings/__proto__", "#/settings/toString"]) {
      expect(parseRoute(hash)).toEqual({ view: "settings" });
    }
    expect(parseRoute(`#/d/${TOKYO}/settings`)).toBeNull();
    expect(parseRoute("#/settings/scale/extra")).toBeNull();
    expect(parseRoute("#/settingsx")).toBeNull();
  });

  it("逐级 push：列表 → 一级设置 → 子页，previous 记上一页网址", () => {
    const { result } = renderHook(useRoute);
    act(() => result.current.navigate({ view: "settings" }));
    expect(location.hash).toBe("#/settings");
    expect(history.state).toEqual({ hub: true, previous: "" });
    act(() => result.current.navigate({ view: "settings", section: "computers" }));
    expect(location.hash).toBe("#/settings/computers");
    expect(history.state).toEqual({ hub: true, previous: "#/settings" });
    expect(result.current.route).toEqual({ view: "settings", section: "computers" });
  });
});
