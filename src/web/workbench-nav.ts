import { useCallback, useEffect, useState } from "react";
import { LOCAL_DEVICE, type DeviceKey } from "./devices.ts";
import { parseRoute, routeHash, type Route, type SettingsSection } from "./route.ts";
import { isDeviceId } from "../shared/index.ts";

export type PageRoute = Exclude<Route, { view: "settings" }>;

export interface SettingsOverlay {
  section?: SettingsSection;
  providerDevice?: DeviceKey;
}

export interface WorkbenchNav {
  page: PageRoute | null;
  settings: SettingsOverlay | null;
}

interface SettingsHistory {
  behind?: string;
  providerDevice?: DeviceKey;
  settingsDepth?: 1 | 2;
}

function settingsHistory(value: unknown): SettingsHistory {
  if (value === null || typeof value !== "object") return {};
  const { behind, providerDevice, settingsDepth } = value as Record<string, unknown>;
  return {
    ...(typeof behind === "string" ? { behind } : {}),
    ...(providerDevice === LOCAL_DEVICE || (typeof providerDevice === "string" && isDeviceId(providerDevice)) ? { providerDevice } : {}),
    ...(settingsDepth === 1 || settingsDepth === 2 ? { settingsDepth } : {}),
  };
}

export function parseNav(hash: string, historyState: unknown): WorkbenchNav {
  const route = parseRoute(hash);
  if (route?.view !== "settings") return { page: route, settings: null };
  const { behind, providerDevice } = settingsHistory(historyState);
  const page = parseRoute(behind ?? "");
  return {
    page: page?.view === "settings" ? null : page,
    settings: {
      ...(route.section === undefined ? {} : { section: route.section }),
      ...(providerDevice === undefined ? {} : { providerDevice }),
    },
  };
}

export function navHash({ page, settings }: WorkbenchNav): string {
  if (settings !== null) return routeHash({ view: "settings", ...(settings.section === undefined ? {} : { section: settings.section }) });
  return page === null ? "" : routeHash(page);
}

const DIALOG_SECTIONS = {
  general: "scale",
  providers: "providers",
  capabilities: "capabilities",
  resources: "resources",
  computers: "computers",
  security: "browsers",
} as const satisfies Record<string, SettingsSection>;

export type SettingsDialogSection = keyof typeof DIALOG_SECTIONS;

export function dialogTabOf(section: SettingsSection | undefined, managed: boolean): SettingsDialogSection | undefined {
  switch (section) {
    case "scale": case "notifications": case "updates": return "general";
    case "providers": case "vendor-sync": return "providers";
    case "sign-in": case "browsers": return "security";
    case "computers": return managed ? "computers" : "general";
    default: return section;
  }
}

export function sectionForDialogTab(tab: SettingsDialogSection, current: SettingsSection | undefined, managed: boolean): SettingsSection {
  return current !== undefined && dialogTabOf(current, managed) === tab ? current : DIALOG_SECTIONS[tab];
}

export interface WorkbenchNavApi {
  nav: WorkbenchNav;
  openPage: (page: PageRoute, sibling?: boolean) => void;
  replacePage: (page: PageRoute | null) => void;
  repairPage: (page: PageRoute | null) => void;
  openSettings: (overlay?: SettingsOverlay) => void;
  showSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
  settingsBack: () => void;
}

function writeHistory(hash: string, state: unknown, replace: boolean) {
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (replace) window.history.replaceState(state, "", url);
  else window.history.pushState(state, "", url);
}

function readNav() {
  return parseNav(window.location.hash, window.history.state);
}

export function useWorkbenchNav(): WorkbenchNavApi {
  const [nav, setNav] = useState(readNav);
  const sync = useCallback(() => {
    const next = readNav();
    setNav((prev) => navHash(prev) === navHash(next) &&
      navHash({ page: prev.page, settings: null }) === navHash({ page: next.page, settings: null }) &&
      prev.settings?.providerDevice === next.settings?.providerDevice ? prev : next);
  }, []);
  useEffect(() => {
    if (nav.settings !== null && navHash(nav) !== window.location.hash) {
      writeHistory(navHash(nav), window.history.state, true);
    }
  }, [nav]);
  useEffect(() => {
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [sync]);

  const openPage = useCallback((page: PageRoute, sibling = false) => {
    const hash = routeHash(page);
    if (hash === window.location.hash) return;
    writeHistory(hash, sibling ? window.history.state : { hub: true, previous: window.location.hash }, sibling);
    sync();
  }, [sync]);

  const replacePage = useCallback((page: PageRoute | null) => {
    writeHistory(page === null ? "" : routeHash(page), null, true);
    sync();
  }, [sync]);

  const repairPage = useCallback((page: PageRoute | null) => {
    const now = readNav();
    const behind = page === null ? "" : routeHash(page);
    if (now.settings === null) writeHistory(behind, null, true);
    else writeHistory(window.location.hash, { behind, providerDevice: now.settings.providerDevice }, true);
    sync();
  }, [sync]);

  const setSettings = useCallback((overlay: SettingsOverlay) => {
    const now = readNav();
    const entry = settingsHistory(window.history.state);
    const behind = now.page === null ? "" : routeHash(now.page);
    const fromHome = now.settings !== null && now.settings.section === undefined && overlay.section !== undefined;
    const settingsDepth = now.settings === null ? 1 : fromHome && entry.settingsDepth === 1 ? 2 : entry.settingsDepth;
    const replace = now.settings !== null && !fromHome;
    writeHistory(navHash({ page: now.page, settings: overlay }), { behind, providerDevice: overlay.providerDevice, settingsDepth }, replace);
    sync();
  }, [sync]);

  const openSettings = useCallback((overlay: SettingsOverlay = {}) => setSettings(overlay), [setSettings]);
  const showSettingsSection = useCallback((section: SettingsSection) => {
    const { settings } = readNav();
    if (settings !== null && settings.section !== section) setSettings({ ...settings, section });
  }, [setSettings]);

  const closeSettings = useCallback(() => {
    const { page, settings } = readNav();
    if (settings === null) return;
    const { settingsDepth } = settingsHistory(window.history.state);
    if (settingsDepth === 1) window.history.back();
    else if (settingsDepth === 2) window.history.go(-2);
    else {
      writeHistory(page === null ? "" : routeHash(page), null, true);
      sync();
    }
  }, [sync]);

  const settingsBack = useCallback(() => {
    const { settings } = readNav();
    if (settings?.section === undefined) closeSettings();
    else if (settingsHistory(window.history.state).settingsDepth === 2) window.history.back();
    else setSettings(settings.providerDevice === undefined ? {} : { providerDevice: settings.providerDevice });
  }, [closeSettings, setSettings]);

  return { nav, openPage, replacePage, repairPage, openSettings, showSettingsSection, closeSettings, settingsBack };
}
