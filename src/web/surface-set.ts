import type { SettingsSurface } from "./shell-surfaces.tsx";
import type { WorkbenchNav } from "./workbench-nav.ts";

// Invariant: the layout is not an input here, so crossing the one-column width cannot add, drop, or rekey a surface.

/** The surfaces the host renders. A key change remounts that surface; null or false means it is not rendered. */
export interface SurfaceSet {
  router: boolean;
  /** conversationKey() of the PM conversation the page resolves to. */
  conversation: string | null;
  /** `device:pmId` of the PM whose work panel and Info pages belong to the page. */
  panel: string | null;
  /** conversationKey() of the routed Worker. */
  worker: string | null;
  /** Settings bodies shared by the dialog and the one-column pages, for the open section. */
  settings: readonly SettingsSurface[];
}

export interface SurfaceSetInput {
  nav: WorkbenchNav;
  /** The PM conversation the page resolves to, already keyed; null when the page has none. */
  conversationKey: string | null;
  panelKey: string | null;
  workerKey: string | null;
  /** Whether the Providers sign-in or account sheet is open. */
  providerSheetOpen: boolean;
  managed: boolean;
}

/**
 * Postcondition: router is true when nav.page is null or Router. conversation, panel, and worker are the given keys, unchanged.
 * settings is empty while settings is closed; otherwise it lists the shared bodies the open section shows: capabilities,
 * resources, account for Computers (or General when not managed), and provider-sheet while that sheet is open on Providers.
 * Returns the same object for inputs with equal fields.
 */
export function surfaceSetOf(_input: SurfaceSetInput): SurfaceSet {
  throw new Error("Not implemented");
}
