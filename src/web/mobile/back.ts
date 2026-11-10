import { routeHash, type Route } from "../route.ts";

export function mobileBack(parent: Route | null, replace: (route: Route | null) => void) {
  if (window.history.state?.hub && window.history.state.previous === (parent === null ? "" : routeHash(parent))) window.history.back();
  else replace(parent);
}
