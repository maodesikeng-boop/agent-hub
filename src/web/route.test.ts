// 联机 P3：网址带设备（docs/multi-device-design.md 第 4.1 节）。老网址（不带 #/d/）是入口本机。
import { describe, expect, it } from "vitest";
import { parseRoute, routeHash, type Route } from "./route.ts";

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
