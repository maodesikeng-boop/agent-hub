import type * as React from "react";
import type { DeviceKey } from "../devices.ts";
import { cn } from "../lib/utils.ts";
import type { QuotaMeter, RailComputer } from "../rail-model.ts";
import { useResourcesAttention } from "../resources-model.ts";
import type { QuotaVendor } from "../selectors.ts";
import { Download, Hourglass, Settings, User } from "../ui/icons.ts";
import { useUpdateReminder } from "../update-model.ts";
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
  /** Settings is open as a page; its tile keeps the selected fill like a tile whose popover is open. */
  settingsOpen?: boolean;
  onOpenUpdates: () => void;
  /** Opens Settings on Computers when an account is linked, otherwise on Security & Access. */
  onOpenAccount: () => void;
}

// One tile recipe for every rail item: a warm fill on hover, and a stronger fill while it is the current page or open. A
// selected computer also turns its icon solid; the Router bell, the gear, and the hourglass have no solid form, so their
// selected fill is stronger to stay apart from hover.
const TILE =
  "relative grid shrink-0 place-items-center rounded-tile [--dot-ring:var(--rail)] transition-[background-color] duration-150 motion-reduce:transition-none group-focus-visible:outline-2 group-focus-visible:outline-border-focus";
const TILE_REST =
  "group-hover:bg-rail-hover group-hover:[--dot-ring:var(--rail-hover-solid)] group-data-[state=open]:bg-rail-selected-strong group-data-[state=open]:[--dot-ring:var(--rail-selected-strong-solid)]";
const TILE_ON = "bg-rail-selected [--dot-ring:var(--rail-selected-solid)]";
const TILE_ON_STRONG = "bg-rail-selected-strong [--dot-ring:var(--rail-selected-strong-solid)]";
const ITEM = "group flex cursor-pointer flex-col items-center gap-1 outline-none";
const LABEL = "max-w-16 truncate text-xs leading-4 font-medium";
const BADGE =
  "badge-pop absolute -top-1.5 -right-2 grid h-5 min-w-5 place-items-center rounded-xs bg-rail-ink px-1 text-xs leading-none font-semibold text-rail tabular-nums shadow-[0_0_0_2px_var(--dot-ring)]";
const DOT = "absolute size-2.5 rounded-full shadow-[0_0_0_2px_var(--dot-ring)] transition-shadow duration-150 motion-reduce:transition-none";

function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function CountBadge({ count, testId }: { count: number; testId: string }) {
  return (
    <span key={count} data-testid={testId} aria-hidden="true" className={BADGE}>
      {badgeText(count)}
    </span>
  );
}

const STATUS_DOT: Record<RailComputer["status"], string> = {
  online: "bg-success",
  connecting: "bg-rail-ink-soft",
  reconnecting: "bg-rail-warn",
  offline: "bg-rail-ink-soft",
  unreachable: "bg-rail-ink-soft",
};

function ComputerCell({ computer, selected, onSelect }: { computer: RailComputer; selected: boolean; onSelect: () => void }) {
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
      <span className={cn(TILE, "size-12", selected ? TILE_ON : TILE_REST, offline ? "text-rail-ink-soft" : "text-rail-ink")}>
        {/* The dot belongs to the icon, so it stays beside it whether or not the tile is selected. */}
        <span className="relative grid">
          <PlatformIcon platform={computer.platform} size="inherit" solid={selected} className="size-pixel" />
          <span data-testid={`rail-device-dot-${testKey}`} data-status={computer.status} aria-hidden="true" className={cn(DOT, "-right-1 -bottom-0.5", STATUS_DOT[computer.status])} />
        </span>
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
 * Postcondition: renders the 4.5rem rail on the frame wood with the Router cell and its waiting count, computer cells with
 * no count, the Update cell while an update waits, the sand hourglass that opens the usage popover, the Settings gear with
 * the resources dot, and the account cell; every item shares one tile recipe, and grooves part the Router, the computers,
 * and the footer.
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
      className="on-frame flex h-full w-18 shrink-0 flex-col items-center pb-[var(--safe-bottom)] text-rail-ink select-none"
    >
      <div data-window-drag className="flex w-full shrink-0 flex-col items-center pt-[var(--frame-inset)]">
        <button
          type="button"
          aria-label={router.pendingCount > 0 ? `Router (${router.pendingCount} waiting)` : "Router"}
          aria-current={router.active ? "page" : undefined}
          onClick={router.onSelect}
          className={ITEM}
        >
          <span className={cn(TILE, "size-12", router.active ? TILE_ON_STRONG : TILE_REST)}>
            <RouterAvatar size={36} working={router.working} />
            {router.pendingCount > 0 && <CountBadge count={router.pendingCount} testId="rail-router-badge" />}
          </span>
          <span className={cn(LABEL, "text-rail-ink")}>Router</span>
        </button>
      </div>

      {computers.length > 0 && (
        <>
          <div aria-hidden="true" className="groove my-3 w-8 shrink-0" />
          <div className="flex min-h-0 w-full flex-col items-center gap-3 overflow-y-auto px-1 pt-1.5">
            {computers.map((c) => (
              <ComputerCell key={c.key} computer={c} selected={selectedComputer === c.key} onSelect={() => onSelectComputer(c.key)} />
            ))}
          </div>
        </>
      )}

      <div data-window-drag className="min-h-4 w-full flex-1" />

      <div aria-hidden="true" className="groove mb-2 w-8 shrink-0" />
      <div className="flex shrink-0 flex-col items-center gap-1.5 pb-[var(--frame-inset)]">
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
