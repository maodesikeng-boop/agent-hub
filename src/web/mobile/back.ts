import { routeHash, type Route, type SettingsRoute } from "../route.ts";

// history.back() when the previous entry is the parent keeps iOS swipe-back and Android back in sync; otherwise replace to avoid deep-link loops.
export function mobileBack(parent: Route | null, replace: (route: Route | null) => void) {
  if (window.history.state?.hub && window.history.state.previous === (parent === null ? "" : routeHash(parent))) window.history.back();
  else replace(parent);
}

export function settingsParent(route: SettingsRoute): Route | null {
  return route.section === undefined ? null : { view: "settings" };
}
