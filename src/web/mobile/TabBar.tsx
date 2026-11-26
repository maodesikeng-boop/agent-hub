import type * as React from "react";
import { RouterAvatar } from "../components/RouterAvatar.tsx";
import { cn } from "../lib/utils.ts";
import type { Route } from "../route.ts";
import { MessageSquare, Settings } from "../ui/icons.ts";

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
 * returns null for pushed pages (conversations, Workers, PM settings, and settings sections), where the tab bar hides.
 */
export function mobileTabOf(route: Route | null): MobileTab | null {
  if (route === null) return "projects";
  if (route.view === "router") return "router";
  if (route.view === "settings" && route.section === undefined) return "settings";
  return null;
}

/**
 * Postcondition: renders the tab bar on the frame wood with Router, Projects, and Settings cells, marks the active one
 * current with the rail's selected fill, and pads the bottom by the safe area; the shell hides it while the keyboard is open.
 */
export function TabBar({ active, routerBadge, settingsAttention, onSelect }: TabBarProps): React.ReactElement {
  return (
    <nav
      aria-label="Mobile navigation"
      className="wood on-frame grid h-[calc(4rem+var(--safe-bottom))] shrink-0 grid-cols-3 border-t border-[var(--groove-dark)] pb-[var(--safe-bottom)] text-rail-ink shadow-[inset_0_1px_0_var(--groove-light)] select-none"
    >
      <button
        type="button"
        aria-label={routerBadge > 0 ? `Router (${routerBadge} waiting)` : "Router"}
        aria-current={active === "router" ? "page" : undefined}
        onClick={() => onSelect("router")}
        className={cn(
          "touch-target relative flex min-h-11 min-w-11 cursor-pointer flex-col items-center justify-center gap-0.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus",
          active === "router" ? "bg-rail-selected-strong font-semibold text-rail-ink" : "font-medium text-rail-ink-soft hover:bg-rail-hover",
        )}
      >
        <span className="relative">
          <RouterAvatar size={22} />
          {routerBadge > 0 && (
            <span
              data-testid="tabbar-router-badge"
              aria-hidden="true"
              className="absolute -top-1 -right-2.5 grid min-w-4 h-4 place-items-center rounded-xs bg-rail-ink px-1 text-xs leading-none font-semibold text-rail tabular-nums"
            >
              {routerBadge > 99 ? "99+" : routerBadge}
            </span>
          )}
        </span>
        <span>Router</span>
      </button>

      <button
        type="button"
        aria-label="Projects"
        aria-current={active === "projects" ? "page" : undefined}
        onClick={() => onSelect("projects")}
        className={cn(
          "touch-target relative flex min-h-11 min-w-11 cursor-pointer flex-col items-center justify-center gap-0.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus",
          active === "projects" ? "bg-rail-selected-strong font-semibold text-rail-ink" : "font-medium text-rail-ink-soft hover:bg-rail-hover",
        )}
      >
        <MessageSquare className="size-pixel-md" aria-hidden="true" />
        <span>Projects</span>
      </button>

      <button
        type="button"
        aria-label={settingsAttention ? "Settings (attention needed)" : "Settings"}
        aria-current={active === "settings" ? "page" : undefined}
        onClick={() => onSelect("settings")}
        className={cn(
          "touch-target relative flex min-h-11 min-w-11 cursor-pointer flex-col items-center justify-center gap-0.5 text-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus",
          active === "settings" ? "bg-rail-selected-strong font-semibold text-rail-ink" : "font-medium text-rail-ink-soft hover:bg-rail-hover",
        )}
      >
        <span className="relative">
          <Settings className="size-pixel-md" aria-hidden="true" />
          {settingsAttention && (
            <span
              data-testid="tabbar-settings-attention"
              aria-hidden="true"
              className="absolute -top-0.5 -right-1 size-2 rounded-full bg-danger ring-2 ring-rail"
            />
          )}
        </span>
        <span>Settings</span>
      </button>
    </nav>
  );
}
