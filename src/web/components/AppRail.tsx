import type * as React from "react";
import type { DeviceKey } from "../devices.ts";
import { cn } from "../lib/utils.ts";
import type { QuotaMeter, RailComputer } from "../rail-model.ts";
import { useResourcesAttention } from "../resources-model.ts";
import type { QuotaVendor } from "../selectors.ts";
import { Download, Hourglass, Settings, User } from "../ui/icons.ts";
import { useUpdateReminder } from "../update-model.ts";
import { CountPill } from "./CountPill.tsx";
import { PlatformIcon } from "./DeviceBadges.tsx";
import { QuotaHourglass } from "./QuotaHourglass.tsx";
import { QuotaPopover } from "./QuotaPopover.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";

export interface AppRailRouter {
  active: boolean;
  pendingCount: number;
  working: boolean;
  onSelect: () => void;
}

export interface AppRailProps {
  router: AppRailRouter;
  /** One cell per computer (including single-computer setups). */
  computers: readonly RailComputer[];
  /** The computer whose PM column is showing, or null on the Router page. */
  selectedComputer: DeviceKey | null;
  meter: QuotaMeter | null;
  quota: readonly QuotaVendor[];
  quotaFetchable: boolean;
  onSelectComputer: (key: DeviceKey) => void;
  onOpenSettings: () => void;
  /** Settings is open as a page; its tile stays raised like a tile whose popover is open. */
  settingsOpen?: boolean;
  onOpenUpdates: () => void;
  /** Opens Settings on Computers when an account is linked, otherwise on Security & Access. */
  onOpenAccount: () => void;
}

// One tile recipe for every rail item: honey hover, and a raised cream tile while it is the current page or open.
const TILE =
  "relative grid shrink-0 place-items-center rounded-sm [--dot-ring:var(--rail)] transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none group-focus-visible:outline-2 group-focus-visible:outline-border-focus";
const TILE_REST = "group-hover:bg-rail-hover group-hover:[--dot-ring:var(--rail-hover)] group-data-[state=open]:tile-selected group-data-[state=open]:[--tile-fill:var(--list)] group-data-[state=open]:[--dot-ring:var(--list)]";
const TILE_ON = "tile-selected [--tile-fill:var(--list)] [--dot-ring:var(--list)] text-list-ink";
const ITEM = "group flex cursor-pointer flex-col items-center gap-1 outline-none";
const LABEL = "max-w-16 truncate text-xs leading-4 font-medium";
const BADGE = "absolute -top-1 -right-1.5 shadow-[0_0_0_2px_var(--rail)]";
const DOT = "absolute size-2.5 rounded-full shadow-[0_0_0_2px_var(--dot-ring)] transition-shadow duration-150 motion-reduce:transition-none";

const STATUS_DOT: Record<RailComputer["status"], string> = {
  online: "bg-success",
  connecting: "bg-muted-foreground",
  reconnecting: "bg-warn-foreground",
  offline: "bg-muted-foreground",
  unreachable: "bg-muted-foreground",
};

function ComputerCell({
  computer,
  selected,
  counted,
  onSelect,
}: {
  computer: RailComputer;
  selected: boolean;
  /** Omit on single-computer setups once Router already carries the count. */
  counted: boolean;
  onSelect: () => void;
}) {
  const offline = computer.status === "offline" || computer.status === "unreachable";
  const ariaParts = [computer.name];
  if (offline) ariaParts.push("offline");
  else if (computer.status === "reconnecting") ariaParts.push("reconnecting");
  if (computer.badge > 0) ariaParts.push(`${computer.badge} waiting`);
  const testKey = computer.key || "local";
  return (
    <button
      type="button"
      title={computer.name}
      aria-label={ariaParts.join(", ")}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={ITEM}
    >
      <span className={cn(TILE, "size-12", selected ? TILE_ON : TILE_REST, !selected && (offline ? "text-rail-ink-soft" : "text-rail-ink"))}>
        {/* The dot belongs to the icon, so it stays beside it whether or not the tile is raised. */}
        <span className="relative grid">
          <PlatformIcon platform={computer.platform} size="inherit" className="size-pixel" />
          <span data-testid={`rail-device-dot-${testKey}`} data-status={computer.status} aria-hidden="true" className={cn(DOT, "-right-1 -bottom-0.5", STATUS_DOT[computer.status])} />
        </span>
        {counted && computer.badge > 0 && <CountPill count={computer.badge} testId={`rail-device-badge-${testKey}`} className={BADGE} />}
      </span>
      <span className={cn(LABEL, offline ? "text-rail-ink-soft" : "text-rail-ink")}>{computer.name}</span>
    </button>
  );
}

function FooterButton({
  label,
  title,
  onClick,
  children,
  ...rest
}: { label: string; title: string; onClick?: () => void; children: React.ReactNode } & Omit<React.ComponentProps<"button">, "children">) {
  return (
    <button type="button" aria-label={label} title={title} onClick={onClick} className={cn(ITEM, "touch-target text-rail-ink")} {...rest}>
      <span className={cn(TILE, "size-10", TILE_REST)}>{children}</span>
    </button>
  );
}

function UsageTrigger({ meter, ...rest }: { meter: QuotaMeter | null } & React.ComponentProps<"button">) {
  if (meter === null) {
    return (
      <button type="button" aria-label="Usage" title="Usage" className={cn(ITEM, "hourglass-trigger touch-target text-rail-ink")} {...rest}>
        <span className={cn(TILE, "size-10", TILE_REST)}>
          <Hourglass className="size-pixel" aria-hidden="true" />
        </span>
      </button>
    );
  }
  const label = `${meter.vendorName} ${meter.windowShort} usage ${meter.percent}%`;
  const tone = meter.full ? "full" : meter.warning ? "warning" : "normal";
  return (
    <button type="button" aria-label={label} title={label} className={cn(ITEM, "hourglass-trigger touch-target")} {...rest}>
      <span className={cn(TILE, "size-10 text-rail-ink", TILE_REST)}>
        <QuotaHourglass data-testid="rail-usage-icon" percent={meter.percent} tone={tone} className="size-pixel" />
      </span>
    </button>
  );
}

/**
 * Postcondition: renders the 4.5rem honey rail with the Router cell, computer cells, the Update cell while an update waits,
 * the sand hourglass that opens the usage popover, the Settings gear with the resources dot, and the account cell; every
 * item shares one tile recipe. In the native macOS app the top clears the traffic lights and drags the window.
 */
export function AppRail({
  router,
  computers,
  selectedComputer,
  meter,
  quota,
  quotaFetchable,
  onSelectComputer,
  onOpenSettings,
  settingsOpen = false,
  onOpenUpdates,
  onOpenAccount,
}: AppRailProps): React.ReactElement {
  const reminder = useUpdateReminder();
  const resources = useResourcesAttention();
  const updateLabel = reminder === null ? "" : `Update to v${reminder.latestVersion}`;

  return (
    <nav
      aria-label="Workspace"
      className="flex h-full w-18 shrink-0 flex-col items-center bg-rail pt-[calc(var(--safe-top)+var(--macos-traffic-lights-height))] pb-[var(--safe-bottom)] text-rail-ink select-none"
    >
      <div data-window-drag className="flex w-full shrink-0 flex-col items-center pt-3.5">
        <button
          type="button"
          aria-label={router.pendingCount > 0 ? `Router (${router.pendingCount} waiting)` : "Router"}
          aria-current={router.active ? "page" : undefined}
          onClick={router.onSelect}
          className={cn(ITEM, "pet-trigger")}
        >
          <span className={cn(TILE, "size-12", router.active ? TILE_ON : TILE_REST)}>
            <RouterAvatar size={36} working={router.working} />
            {router.pendingCount > 0 && <CountPill count={router.pendingCount} testId="rail-router-badge" className={BADGE} />}
          </span>
          <span className={cn(LABEL, "text-rail-ink")}>Router</span>
        </button>
      </div>

      {computers.length > 0 && (
        <>
          <div aria-hidden="true" className="my-3 h-px w-8 shrink-0 bg-border" />
          <div className="flex min-h-0 w-full flex-col items-center gap-3 overflow-y-auto px-1 pt-1.5">
            {computers.map((c) => (
              <ComputerCell
                key={c.key}
                computer={c}
                selected={selectedComputer === c.key}
                counted={computers.length > 1 || router.pendingCount === 0}
                onSelect={() => onSelectComputer(c.key)}
              />
            ))}
          </div>
        </>
      )}

      <div data-window-drag className="min-h-4 w-full flex-1" />

      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-2 pb-3">
        {reminder !== null && (
          <FooterButton label={updateLabel} title={updateLabel} onClick={onOpenUpdates}>
            <Download className="size-pixel" aria-hidden="true" />
          </FooterButton>
        )}

        {(meter !== null || quotaFetchable) && (
          <QuotaPopover quota={quota} fetchable={quotaFetchable} side="right" align="end" trigger={<UsageTrigger meter={meter} />} />
        )}

        <FooterButton
          label={resources.attention ? `Settings (${resources.heldCount} to review)` : "Settings"}
          title="Settings"
          data-state={settingsOpen ? "open" : "closed"}
          onClick={onOpenSettings}
        >
          <span className="relative grid">
            <Settings className="size-pixel" aria-hidden="true" />
            {resources.attention && (
              <span data-testid="settings-resources-attention" aria-hidden="true" className={cn(DOT, "-top-0.5 -right-1 bg-danger")} />
            )}
          </span>
        </FooterButton>

        <FooterButton label="Account" title="Account" onClick={onOpenAccount}>
          <User className="size-pixel" aria-hidden="true" />
        </FooterButton>
      </div>
    </nav>
  );
}
