import { routeHash, type Route } from "../route.ts";

// history.back() when the previous entry is the parent keeps iOS swipe-back and Android back in sync; otherwise replace to avoid deep-link loops.
export function mobileBack<T extends Route | null>(parent: T, replace: (route: T) => void) {
  if (window.history.state?.hub && window.history.state.previous === (parent === null ? "" : routeHash(parent))) window.history.back();
  else replace(parent);
}
