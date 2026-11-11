import { routeHash, type Route, type SettingsRoute } from "../route.ts";

/** 返回上级：历史上一页正好是上级时 history.back()（iOS 右滑、安卓返回键同一条路），否则 replace 到上级，直达深链接不死循环。 */
export function mobileBack(parent: Route | null, replace: (route: Route | null) => void) {
  if (window.history.state?.hub && window.history.state.previous === (parent === null ? "" : routeHash(parent))) window.history.back();
  else replace(parent);
}

/** 设置页的上级：二级子页回一级设置，一级设置回列表（docs/mobile-settings-design.md 第 2.2 节）。 */
export function settingsParent(route: SettingsRoute): Route | null {
  return route.section === undefined ? null : { view: "settings" };
}
