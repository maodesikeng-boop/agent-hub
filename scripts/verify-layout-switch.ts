// Runs the layout switch acceptance scenarios in Chromium and WebKit with a mouse pointer, resizing the viewport in steps across
// the one-column width twice per scenario. The same run against an older build gives the before half of each screenshot pair.

export type LayoutSwitchEngine = "chromium" | "webkit";

export type LayoutSwitchScenario =
  | "router-target"
  | "persona-behind-settings"
  | "router-tray"
  | "list-search"
  | "pm-settings-pages"
  | "settings-choices"
  | "composer-drafts"
  | "auto-reload"
  | "navigation"
  | "provider-sign-in"
  | "computer-rename";

export interface LayoutSwitchOptions {
  origin: string;
  loginUrl: string;
  outDir: string;
  /** Prefix for screenshots and request logs, so a run on the old build and one on the change pair up by file name. */
  label: string;
  engines: readonly LayoutSwitchEngine[];
  scenarios: readonly LayoutSwitchScenario[];
}

export interface LayoutSwitchResult {
  engine: LayoutSwitchEngine;
  scenario: LayoutSwitchScenario;
  passed: boolean;
  /** What failed, in the scenario's own words; null when passed. */
  failure: string | null;
  screenshots: readonly string[];
  /** Captured request bodies for scenarios that send, such as POST /api/router/commands. */
  requests: readonly unknown[];
  /** React commit time of the first 900 to 675px switch, in ms. */
  switchCommitMs: number | null;
}

/**
 * Precondition: a signed-in daemon at origin seeded with the ui-polish standard scenario; Playwright browsers installed.
 * Postcondition: runs every scenario in every engine, writes `<label>-<engine>-<scenario>-<step>.png` and
 * `<label>-requests.json` into outDir, and returns one result per engine and scenario without throwing on a failed scenario.
 */
export async function verifyLayoutSwitch(_options: LayoutSwitchOptions): Promise<LayoutSwitchResult[]> {
  throw new Error("Not implemented");
}
