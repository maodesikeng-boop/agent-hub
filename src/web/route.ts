// 网址（docs/ui-standard.md 第 16、21 条）：每个对话、资料页与水果刀 Router 工作台都有自己的网址，刷新后回到原来那个，能前进后退。
// 用 # 后面的部分（守护进程只认 / 这一个页面，不用改服务端）：#/router、#/c/<对话编号>、#/w/<Worker 对话编号>、#/pm/<项目经理编号>。
// 联机（docs/multi-device-design.md 第 4.1 节，P3 实现）：别的设备前面加 #/d/<设备编号>，如 #/d/<设备>/c/<对话>；
// #/router 是全局总助视图，永远不带设备前缀。
// 手机设置（docs/mobile-settings-design.md 第 2.2 节）：#/settings 一级主页、#/settings/<section> 二级子页，是入口本机与这台浏览器的设置，也不带设备前缀。
import { useCallback, useEffect, useState } from "react";
import { isDeviceId, type ConversationId, type DeviceId, type PmId } from "../shared/index.ts";

export type ScopedRoute = (
  /** 项目经理的对话。 */
  | { view: "conversation"; id: ConversationId }
  /** Worker 的对话。 */
  | { view: "worker"; id: ConversationId }
  /** 项目经理的资料页。 */
  | { view: "profile"; pmId: PmId }
) & { device?: DeviceId };

/** 手机设置的二级子页，顺序就是一级主页从上到下（docs/mobile-settings-design.md 第 2.1 节）。 */
export const SETTINGS_SECTIONS = ["scale", "notifications", "vendor-sync", "computers", "sign-in", "browsers", "public-access"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** 手机设置页：不写 section 是一级主页。 */
export type SettingsRoute = { view: "settings"; section?: SettingsSection; device?: undefined };

const isSettingsSection = (value: string): value is SettingsSection => (SETTINGS_SECTIONS as readonly string[]).includes(value);

/** 当前网址对应的页面：#/router 为全局总助工作台、#/settings* 为手机设置页（device 永为 undefined），其余不写 device 时为入口本机。 */
export type Route = { view: "router"; device?: undefined } | SettingsRoute | ScopedRoute;

const PREFIX: Record<ScopedRoute["view"], string> = { conversation: "c", worker: "w", profile: "pm" };

export function routeHash(route: Route): string {
  if (route.view === "router") return "#/router";
  if (route.view === "settings") return route.section === undefined ? "#/settings" : `#/settings/${route.section}`;
  const device = route.device === undefined ? "" : `/d/${route.device}`;
  return `#${device}/${PREFIX[route.view]}/${route.view === "profile" ? route.pmId : route.id}`;
}

/** 认不出来（空的、编号不是正整数、设备编号不合法、别的路径）是 null；设置下不认识的子页归一为一级设置。 */
export function parseRoute(hash: string): Route | null {
  if (hash === "#/router") return { view: "router" };
  const settings = /^#\/settings(?:\/([^/]*))?$/.exec(hash);
  if (settings) {
    const section = settings[1];
    return section !== undefined && isSettingsSection(section) ? { view: "settings", section } : { view: "settings" };
  }
  const match = /^#(?:\/d\/([^/]+))?\/(c|w|pm)\/([1-9]\d*)$/.exec(hash);
  if (!match) return null;
  const device = match[1];
  if (device !== undefined && !isDeviceId(device)) return null;
  const n = Number(match[3]);
  if (!Number.isSafeInteger(n)) return null;
  const on = device === undefined ? {} : { device };
  if (match[2] === "c") return { view: "conversation", id: n, ...on };
  if (match[2] === "w") return { view: "worker", id: n, ...on };
  return { view: "profile", pmId: n, ...on };
}

const sameRoute = (a: Route | null, b: Route | null) => (a === null || b === null ? a === b : routeHash(a) === routeHash(b));

/**
 * 当前网址对应的页面。navigate 记一条历史（能后退）；replace 不记（刚打开时补上默认的页面、编号找不到时改回来）。
 * 用户改网址、前进后退时跟着变。
 */
export function useRoute() {
  const [route, setRoute] = useState<Route | null>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const sync = () => setRoute((prev) => {
      const next = parseRoute(window.location.hash);
      return sameRoute(prev, next) ? prev : next;
    });
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = useCallback((next: Route | null, replace: boolean, sibling = false) => {
    setRoute((prev) => (sameRoute(prev, next) ? prev : next));
    if (window.location.hash === (next === null ? "" : routeHash(next))) return;
    const url = `${window.location.pathname}${window.location.search}${next === null ? "" : routeHash(next)}`;
    if (replace) window.history.replaceState(sibling ? window.history.state : null, "", url);
    else window.history.pushState({ hub: true, previous: window.location.hash }, "", url);
  }, []);
  const navigate = useCallback((next: Route, sibling = false) => go(next, sibling, sibling), [go]);
  const replace = useCallback((next: Route | null) => go(next, true), [go]);
  return { route, navigate, replace };
}
