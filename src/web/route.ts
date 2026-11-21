import { useCallback, useEffect, useState } from "react";
import { isDeviceId, type ConversationId, type DeviceId, type PmId } from "../shared/index.ts";

export type ScopedRoute = (
  | { view: "conversation"; id: ConversationId }
  | { view: "worker"; id: ConversationId }
  | { view: "profile"; pmId: PmId; page?: "capabilities" }
) & { device?: DeviceId };

export const SETTINGS_SECTIONS = [
  "scale",
  "notifications",
  "updates",
  "providers",
  "vendor-sync",
  "capabilities",
  "resources",
  "computers",
  "sign-in",
  "browsers",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsRoute = { view: "settings"; section?: SettingsSection; device?: undefined };

const isSettingsSection = (value: string): value is SettingsSection => (SETTINGS_SECTIONS as readonly string[]).includes(value);

export type Route = { view: "router"; device?: undefined } | SettingsRoute | ScopedRoute;

const PREFIX: Record<ScopedRoute["view"], string> = { conversation: "c", worker: "w", profile: "pm" };

export function routeHash(route: Route): string {
  if (route.view === "router") return "#/router";
  if (route.view === "settings") return route.section === undefined ? "#/settings" : `#/settings/${route.section}`;
  const device = route.device === undefined ? "" : `/d/${route.device}`;
  const id = route.view === "profile" ? `${route.pmId}${route.page === undefined ? "" : `/${route.page}`}` : route.id;
  return `#${device}/${PREFIX[route.view]}/${id}`;
}

export function parseRoute(hash: string): Route | null {
  if (hash === "#/router") return { view: "router" };
  const settings = /^#\/settings(?:\/([^/]*))?$/.exec(hash);
  if (settings) {
    const section = settings[1];
    return section !== undefined && isSettingsSection(section) ? { view: "settings", section } : { view: "settings" };
  }
  const match = /^#(?:\/d\/([^/]+))?\/(c|w|pm)\/([1-9]\d*)(\/capabilities)?$/.exec(hash);
  if (!match) return null;
  const device = match[1];
  if (device !== undefined && !isDeviceId(device)) return null;
  const n = Number(match[3]);
  if (!Number.isSafeInteger(n)) return null;
  const on = device === undefined ? {} : { device };
  const page = match[4] === undefined ? {} : ({ page: "capabilities" } as const);
  if (match[2] === "pm") return { view: "profile", pmId: n, ...page, ...on };
  if (match[4] !== undefined) return null;
  return match[2] === "c" ? { view: "conversation", id: n, ...on } : { view: "worker", id: n, ...on };
}

const sameRoute = (a: Route | null, b: Route | null) => (a === null || b === null ? a === b : routeHash(a) === routeHash(b));

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
