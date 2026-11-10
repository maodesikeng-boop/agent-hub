// 网址（docs/ui-standard.md 第 16 条）：每个对话、资料页都有自己的网址，刷新后回到原来那个，能前进后退。
// 用 # 后面的部分（守护进程只认 / 这一个页面，不用改服务端）：#/c/<对话编号>、#/w/<Worker 对话编号>、#/pm/<项目经理编号>。
// 联机（docs/multi-device-design.md 第 4.1 节，P3 实现）：别的设备前面加 #/d/<设备编号>，如 #/d/<设备>/c/<对话>；
// 设备编号是 shared/api.ts 的 DeviceId（isDeviceId 校验）。不带 #/d/ 的老网址当成入口本机，继续能用。
import { useCallback, useEffect, useState } from "react";
import { isDeviceId, type ConversationId, type DeviceId, type PmId } from "../shared/index.ts";
import { withViewTransition } from "./view-transition.ts";

/** 哪台设备上的页面：不写（undefined）是入口本机。 */
export type Route = (
  /** 项目经理的对话。 */
  | { view: "conversation"; id: ConversationId }
  /** Worker 的对话。 */
  | { view: "worker"; id: ConversationId }
  /** 项目经理的资料页。 */
  | { view: "profile"; pmId: PmId }
) & { device?: DeviceId };

const PREFIX: Record<Route["view"], string> = { conversation: "c", worker: "w", profile: "pm" };

export function routeHash(route: Route): string {
  const device = route.device === undefined ? "" : `/d/${route.device}`;
  return `#${device}/${PREFIX[route.view]}/${route.view === "profile" ? route.pmId : route.id}`;
}

/** 认不出来（空的、编号不是正整数、设备编号不合法、别的路径）是 null。 */
export function parseRoute(hash: string): Route | null {
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
 * 当前网址对应的页面。navigate 记一条历史（能后退）；replace 不记（刚打开时补上默认的对话、编号找不到时改回来）。
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
  const go = useCallback((next: Route, replace: boolean) => {
    const apply = () => setRoute((prev) => (sameRoute(prev, next) ? prev : next));
    // 用户点出来的切换对话（左栏点项目经理、点开 Piece、从 Piece 返回）：顶栏的头像和标题过渡一下；
    // 资料页没有这两样，刚打开时补默认对话（replace）也不播
    if (replace || next.view === "profile") apply();
    else withViewTransition(apply);
    if (window.location.hash === routeHash(next)) return;
    const url = `${window.location.pathname}${window.location.search}${routeHash(next)}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);
  const navigate = useCallback((next: Route) => go(next, false), [go]);
  const replace = useCallback((next: Route) => go(next, true), [go]);
  return { route, navigate, replace };
}
