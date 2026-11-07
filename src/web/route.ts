// 网址（docs/ui-standard.md 第 16 条）：每个对话、资料页都有自己的网址，刷新后回到原来那个，能前进后退。
// 用 # 后面的部分（守护进程只认 / 这一个页面，不用改服务端）：#/c/<对话编号>、#/w/<Worker 对话编号>、#/pm/<项目经理编号>。
// 联机（docs/multi-device-design.md 第 4.1 节，P3 实现）：别的设备前面加 #/d/<设备编号>，如 #/d/<设备>/c/<对话>；
// 设备编号是 shared/api.ts 的 DeviceId（isDeviceId 校验）。不带 #/d/ 的老网址当成入口本机，继续能用。
import { useCallback, useEffect, useState } from "react";
import type { ConversationId, PmId } from "../shared/index.ts";

export type Route =
  /** 项目经理的对话。 */
  | { view: "conversation"; id: ConversationId }
  /** Worker 的对话。 */
  | { view: "worker"; id: ConversationId }
  /** 项目经理的资料页。 */
  | { view: "profile"; pmId: PmId };

const PREFIX: Record<Route["view"], string> = { conversation: "c", worker: "w", profile: "pm" };

export function routeHash(route: Route): string {
  return `#/${PREFIX[route.view]}/${route.view === "profile" ? route.pmId : route.id}`;
}

/** 认不出来（空的、编号不是正整数、别的路径）是 null。 */
export function parseRoute(hash: string): Route | null {
  const match = /^#\/(c|w|pm)\/([1-9]\d*)$/.exec(hash);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isSafeInteger(n)) return null;
  if (match[1] === "c") return { view: "conversation", id: n };
  if (match[1] === "w") return { view: "worker", id: n };
  return { view: "profile", pmId: n };
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
    setRoute((prev) => (sameRoute(prev, next) ? prev : next));
    if (window.location.hash === routeHash(next)) return;
    const url = `${window.location.pathname}${window.location.search}${routeHash(next)}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);
  const navigate = useCallback((next: Route) => go(next, false), [go]);
  const replace = useCallback((next: Route) => go(next, true), [go]);
  return { route, navigate, replace };
}
