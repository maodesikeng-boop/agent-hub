import type { SettingsDialogSection } from "./components/SettingsDialog.tsx";
import type { DeviceKey } from "./devices.ts";
import type { Route, SettingsSection } from "./route.ts";

// Invariant: navigation never reads the layout. Crossing the one-column width reads WorkbenchNav and never writes it.

export type PageRoute = Exclude<Route, { view: "settings" }>;

export interface SettingsOverlay {
  /** Undefined: the settings home in one column, the default tab in the dialog. */
  section?: SettingsSection;
  /** The computer Providers and Resources open on; undefined means the current computer. */
  providerDevice?: DeviceKey;
}

export interface WorkbenchNav {
  /** The page shown, or the page behind open settings. Null: the layout's default page, resolved at render and never written. */
  page: PageRoute | null;
  settings: SettingsOverlay | null;
}

/**
 * Postcondition: a page hash gives that page with settings closed. `#/settings[/<section>]` gives settings open on that section
 * over the page whose hash is `historyState.behind`, or over null when the state is missing or names no page. Anything else
 * gives `{ page: null, settings: null }`.
 */
export function parseNav(_hash: string, _historyState: unknown): WorkbenchNav {
  throw new Error("Not implemented");
}

/** Postcondition: the hash for nav; open settings win over the page. parseNav(navHash(nav), state) round-trips when state.behind is the page's hash. */
export function navHash(_nav: WorkbenchNav): string {
  throw new Error("Not implemented");
}

/**
 * Postcondition: the dialog tab that shows section; Computers falls back to General when the account is not managed.
 * Undefined section gives undefined, and the dialog picks its default tab.
 */
export function dialogTabOf(_section: SettingsSection | undefined, _managed: boolean): SettingsDialogSection | undefined {
  throw new Error("Not implemented");
}

/** Postcondition: current when dialogTabOf(current, managed) is tab; otherwise the first section the tab shows. */
export function sectionForDialogTab(_tab: SettingsDialogSection, _current: SettingsSection | undefined, _managed: boolean): SettingsSection {
  throw new Error("Not implemented");
}

export interface WorkbenchNavApi {
  /** The same object while the URL and the history state are unchanged. */
  nav: WorkbenchNav;
  /** Pushes page with settings closed; sibling replaces the entry instead. */
  openPage: (page: PageRoute, sibling?: boolean) => void;
  replacePage: (page: PageRoute | null) => void;
  /** Pushes a settings entry whose history state records the current page's hash as `behind`. */
  openSettings: (overlay?: SettingsOverlay) => void;
  /** Moves open settings to section: push from the settings home, replace between sections. No-op while settings is closed. */
  showSettingsSection: (section: SettingsSection) => void;
  /** Returns to the page behind settings: history.back() when the previous entry is that page, otherwise a replace. */
  closeSettings: () => void;
  /** One-column Back inside settings: a section goes to the settings home, the home closes settings. */
  settingsBack: () => void;
}

/**
 * Precondition: called once, above the layout switch.
 * Postcondition: nav follows popstate and hashchange; every action updates the URL and nav in one render.
 */
export function useWorkbenchNav(): WorkbenchNavApi {
  throw new Error("Not implemented");
}
