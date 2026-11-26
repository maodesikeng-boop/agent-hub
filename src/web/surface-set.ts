import type { SettingsSurface } from "./shell-surfaces.tsx";
import type { WorkbenchNav } from "./workbench-nav.ts";
import { dialogTabOf } from "./workbench-nav.ts";

interface SurfaceSet {
  router: boolean;
  conversation: string | null;
  panel: string | null;
  worker: string | null;
  settings: readonly SettingsSurface[];
}

interface SurfaceSetInput {
  nav: WorkbenchNav;
  conversationKey: string | null;
  panelKey: string | null;
  workerKey: string | null;
  managed: boolean;
}

const SETTINGS_BODIES: Partial<Record<NonNullable<ReturnType<typeof dialogTabOf>>, readonly SettingsSurface[]>> = {
  capabilities: ["capabilities"],
  resources: ["resources"],
  providers: ["providers"],
  computers: ["account"],
};

export function surfaceSetOf({ nav, conversationKey, panelKey, workerKey, managed }: SurfaceSetInput): SurfaceSet {
  const tab = nav.settings === null ? undefined : (dialogTabOf(nav.settings.section, managed) ?? (managed ? "computers" : "general"));
  return {
    router: nav.page === null || nav.page.view === "router",
    conversation: conversationKey,
    panel: panelKey,
    worker: workerKey,
    settings: (tab === undefined ? undefined : SETTINGS_BODIES[tab]) ?? [],
  };
}
