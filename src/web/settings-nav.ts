import { useCallback, useRef, useState } from "react";
import type { SettingsDialogSection } from "./components/SettingsDialog.tsx";
import type { DeviceKey } from "./devices.ts";
import { mobileBack, settingsParent } from "./mobile/back.ts";
import type { Route, SettingsSection } from "./route.ts";

export interface DesktopSettingsTarget {
  open: boolean;
  section?: SettingsDialogSection;
  providerDevice?: DeviceKey;
}

export function desktopSectionOf(section: SettingsSection, managed: boolean): SettingsDialogSection {
  if (section === "scale" || section === "notifications") return "general";
  if (section === "providers" || section === "vendor-sync") return "providers";
  if (section === "computers") return managed ? "computers" : "general";
  return "security";
}

interface SettingsNavOptions {
  autoSelect: boolean;
  currentKey: DeviceKey;
  route: Route | null;
  navigate: (next: Route, sibling?: boolean) => void;
  replace: (next: Route | null) => void;
  setCreating: (creating: boolean) => void;
}

export function useSettingsNav({ autoSelect, currentKey, route, navigate, replace, setCreating }: SettingsNavOptions) {
  const [desktop, setDesktop] = useState<DesktopSettingsTarget>({ open: false });
  const [mobileProviderDevice, setMobileProviderDevice] = useState<DeviceKey | undefined>(undefined);
  const onSettingsOpenChange = useCallback((open: boolean) => setDesktop({ open }), []);
  const openSettings = useCallback(() => {
    setMobileProviderDevice(currentKey);
    navigate({ view: "settings" });
  }, [currentKey, navigate]);
  const openSettingsSection = useCallback((section: SettingsSection) => navigate({ view: "settings", section }), [navigate]);
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
  return { desktop, setDesktop, onSettingsOpenChange, openSettings, openSettingsSection, openManageProviders, settingsBack, defaultProviderDevice };
}
