import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsDialogSection } from "./components/SettingsDialog.tsx";
import type { DeviceKey } from "./devices.ts";
import { mobileBack, settingsParent } from "./mobile/back.ts";
import type { Route, SettingsRoute, SettingsSection } from "./route.ts";

export interface DesktopSettingsTarget {
  open: boolean;
  section?: SettingsDialogSection;
  providerDevice?: DeviceKey;
}

export function desktopSectionOf(section: SettingsSection, managed: boolean): SettingsDialogSection {
  if (section === "scale" || section === "notifications" || section === "updates") return "general";
  if (section === "providers" || section === "vendor-sync") return "providers";
  if (section === "capabilities") return "capabilities";
  if (section === "resources") return "resources";
  if (section === "computers") return managed ? "computers" : "general";
  return "security";
}

const ROUTE_SECTION_OF: Record<SettingsDialogSection, SettingsSection> = {
  general: "scale",
  providers: "providers",
  capabilities: "capabilities",
  resources: "resources",
  computers: "computers",
  security: "browsers",
};

export function dialogTargetOf(route: SettingsRoute, managed: boolean): DesktopSettingsTarget {
  return route.section === undefined ? { open: true } : { open: true, section: desktopSectionOf(route.section, managed) };
}

function pageRouteOf({ section }: DesktopSettingsTarget): SettingsRoute {
  return section === undefined ? { view: "settings" } : { view: "settings", section: ROUTE_SECTION_OF[section] };
}

interface SettingsNavOptions {
  autoSelect: boolean;
  managed: boolean;
  currentKey: DeviceKey;
  route: Route | null;
  navigate: (next: Route, sibling?: boolean) => void;
  replace: (next: Route | null) => void;
  setCreating: (creating: boolean) => void;
}

export function useSettingsNav({ autoSelect, managed, currentKey, route, navigate, replace, setCreating }: SettingsNavOptions) {
  const [desktop, setDesktop] = useState<DesktopSettingsTarget>({ open: false });
  const [mobileProviderDevice, setMobileProviderDevice] = useState<DeviceKey | undefined>(undefined);
  const onSettingsOpenChange = useCallback((open: boolean) => setDesktop({ open }), []);
  const onSettingsSectionChange = useCallback(
    (section: SettingsDialogSection) => setDesktop((current) => (current.open ? { ...current, section } : current)),
    [],
  );
  // The one-column shell has no settings dialog: an open dialog becomes the settings page for its section.
  useEffect(() => {
    if (autoSelect || !desktop.open) return;
    setDesktop({ open: false });
    if (desktop.providerDevice !== undefined) setMobileProviderDevice(desktop.providerDevice);
    navigate(pageRouteOf(desktop));
  }, [autoSelect, desktop, navigate]);
  // In the render that swaps shells, the new shell already shows the settings the old one had open, so they mount in one commit.
  const settingsRoute = route?.view === "settings" ? route : null;
  const dialog = autoSelect && !desktop.open && settingsRoute !== null ? dialogTargetOf(settingsRoute, managed) : desktop;
  const page = settingsRoute ?? (!autoSelect && desktop.open ? pageRouteOf(desktop) : null);
  const openSettings = useCallback(() => {
    setMobileProviderDevice(currentKey);
    navigate({ view: "settings" });
  }, [currentKey, navigate]);
  const openSettingsSection = useCallback(
    (section: SettingsSection) => (autoSelect ? setDesktop({ open: true, section: desktopSectionOf(section, managed) }) : navigate({ view: "settings", section })),
    [autoSelect, managed, navigate],
  );
  const openManageProviders = useCallback(
    (targetDevice: DeviceKey = currentKey) => {
      setCreating(false);
      if (autoSelect) {
        setDesktop({ open: true, section: "providers", providerDevice: targetDevice });
      } else {
        setMobileProviderDevice(targetDevice);
        navigate({ view: "settings", section: "providers" });
      }
    },
    [autoSelect, currentKey, navigate, setCreating],
  );
  const routeRef = useRef(route);
  routeRef.current = route;
  const settingsBack = useCallback(() => {
    const currentRoute = routeRef.current;
    if (currentRoute?.view === "settings") mobileBack(settingsParent(currentRoute), replace);
  }, [replace]);
  const defaultProviderDevice = desktop.providerDevice ?? mobileProviderDevice ?? currentKey;
  return {
    desktop,
    dialog,
    page,
    setDesktop,
    onSettingsOpenChange,
    onSettingsSectionChange,
    openSettings,
    openSettingsSection,
    openManageProviders,
    settingsBack,
    defaultProviderDevice,
  };
}
