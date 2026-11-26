import { isDeviceId, type ConversationId, type DeviceId, type PmId } from "../shared/index.ts";
import { INFO_PAGES, isInfoPage, type InfoPage } from "./info-rows.ts";

export { INFO_PAGES, type InfoPage };

export type ScopedRoute = (
  | { view: "conversation"; id: ConversationId }
  | { view: "worker"; id: ConversationId }
  | { view: "profile"; pmId: PmId; page?: InfoPage }
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
  const match = /^#(?:\/d\/([^/]+))?\/(c|w|pm)\/([1-9]\d*)(?:\/([^/]+))?$/.exec(hash);
  if (!match) return null;
  const device = match[1];
  if (device !== undefined && !isDeviceId(device)) return null;
  const n = Number(match[3]);
  if (!Number.isSafeInteger(n)) return null;
  const on = device === undefined ? {} : { device };
  const rawPage = match[4];
  if (match[2] === "pm") {
    if (rawPage === undefined) return { view: "profile", pmId: n, ...on };
    if (!isInfoPage(rawPage)) return null;
    return { view: "profile", pmId: n, page: rawPage, ...on };
  }
  if (rawPage !== undefined) return null;
  return match[2] === "c" ? { view: "conversation", id: n, ...on } : { view: "worker", id: n, ...on };
}
