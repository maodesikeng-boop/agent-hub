import type * as React from "react";
import type { Route } from "../route.ts";

export type MobileTab = "router" | "projects" | "settings";

export interface TabBarProps {
  active: MobileTab;
  /** Pending Router decisions across every computer. */
  routerBadge: number;
  /** Resources or an update need the user, shown as a dot on Settings. */
  settingsAttention: boolean;
  onSelect: (tab: MobileTab) => void;
}

/**
 * Postcondition: maps the empty route to projects, the Router route to router, and the Settings home to settings;
 * returns null for pushed pages (conversations, Pieces, PM settings, and settings sections), where the tab bar hides.
 */
export function mobileTabOf(_route: Route | null): MobileTab | null {
  throw new Error("Not implemented");
}

/**
 * Postcondition: renders the honey tab bar with Router, Projects, and Settings cells, marks the active one current, and
 * pads the bottom by the safe area; the shell hides it while the keyboard is open.
 */
export function TabBar(_props: TabBarProps): React.ReactElement {
  throw new Error("Not implemented");
}
