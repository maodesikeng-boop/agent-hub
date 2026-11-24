import type * as React from "react";
import { CountPill } from "../components/CountPill.tsx";
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
 * returns null for pushed pages (conversations, Pieces, PM settings, and settings sections), where the tab bar hides.
 */
export function mobileTabOf(route: Route | null): MobileTab | null {
  if (route === null) return "projects";
  if (route.view === "router") return "router";
  if (route.view === "settings" && route.section === undefined) return "settings";
  return null;
}

function Tab({
  current,
  label,
  ariaLabel,
  onSelect,
  children,
}: {
  current: boolean;
  label: string;
  ariaLabel: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-current={current ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "touch-target group relative flex min-h-11 min-w-11 cursor-pointer flex-col items-center justify-center gap-1 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus",
        current ? "font-semibold text-rail-ink" : "font-medium text-rail-ink-soft",
      )}
    >
      <span
        className={cn(
          "relative grid h-8 w-14 place-items-center rounded-full transition-colors duration-150 motion-reduce:transition-none",
          current ? "bg-list" : "group-hover:bg-rail-hover",
        )}
      >
        {children}
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * Postcondition: renders the honey tab bar with Router, Projects, and Settings cells, marks the active one current with
 * a cream pill behind its icon, and pads the bottom by the safe area; the shell hides it while the keyboard is open.
 */
export function TabBar({ active, routerBadge, settingsAttention, onSelect }: TabBarProps): React.ReactElement {
  return (
    <nav
      aria-label="Mobile navigation"
      className="grid h-[calc(4rem+var(--safe-bottom))] shrink-0 grid-cols-3 border-t border-border bg-rail pb-[var(--safe-bottom)] text-rail-ink select-none"
    >
      <Tab
        current={active === "router"}
        label="Router"
        ariaLabel={routerBadge > 0 ? `Router (${routerBadge} waiting)` : "Router"}
        onSelect={() => onSelect("router")}
      >
        <RouterAvatar size={22} />
        {routerBadge > 0 && (
          <CountPill
            count={routerBadge}
            testId="tabbar-router-badge"
            className="absolute -top-1 right-1 shadow-[0_0_0_2px_var(--rail)]"
          />
        )}
      </Tab>

      <Tab current={active === "projects"} label="Projects" ariaLabel="Projects" onSelect={() => onSelect("projects")}>
        <MessageSquare className="size-pixel-md" aria-hidden="true" />
      </Tab>

      <Tab
        current={active === "settings"}
        label="Settings"
        ariaLabel={settingsAttention ? "Settings (attention needed)" : "Settings"}
        onSelect={() => onSelect("settings")}
      >
        <Settings className="size-pixel-md" aria-hidden="true" />
        {settingsAttention && (
          <span
            data-testid="tabbar-settings-attention"
            aria-hidden="true"
            className={cn("absolute top-1 right-4 size-2 rounded-full bg-danger ring-2", active === "settings" ? "ring-list" : "ring-rail")}
          />
        )}
      </Tab>
    </nav>
  );
}
