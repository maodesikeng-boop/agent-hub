import type * as React from "react";
import type { DeviceKey } from "../devices.ts";
import { cn } from "../lib/utils.ts";
import { RAIL_QUOTA_CELLS, type QuotaMeter, type RailComputer } from "../rail-model.ts";
import { useResourcesAttention } from "../resources-model.ts";
import type { QuotaVendor } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Download, Hourglass, Settings, User } from "../ui/icons.ts";
import { useUpdateReminder } from "../update-model.ts";
import { PlatformIcon } from "./DeviceBadges.tsx";
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
  onOpenUpdates: () => void;
  /** Opens Settings on Computers when an account is linked, otherwise on Security & Access. */
  onOpenAccount: () => void;
}

function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * Postcondition: renders the 4.5rem honey rail with the Router cell, computer cells, the Update cell while an update waits,
 * the usage meter that opens the usage popover, the Settings gear with the resources dot, and the account cell; in the
 * native macOS app the top clears the traffic lights and drags the window.
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
  onOpenUpdates,
  onOpenAccount,
}: AppRailProps): React.ReactElement {
  const reminder = useUpdateReminder();
  const resources = useResourcesAttention();
  const updateLabel = reminder === null ? "" : `Update to v${reminder.latestVersion}`;
  const meterLabel = meter === null ? "" : `${meter.vendorName} ${meter.windowShort} usage ${meter.percent}%`;

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
          className="group flex flex-col items-center gap-1 outline-none cursor-pointer"
        >
          <span
            className={cn(
              "relative grid size-12 place-items-center transition-colors group-focus-visible:outline-2 group-focus-visible:outline-border-focus",
              router.active ? "border-2 border-rail-outline bg-list text-list-ink" : "group-hover:bg-rail-hover",
            )}
          >
            <RouterAvatar size={36} working={router.working} />
            {router.pendingCount > 0 && (
              <span
                data-testid="rail-router-badge"
                aria-hidden="true"
                className="absolute -top-1.5 -right-2 grid min-w-5 h-5 place-items-center border-2 border-rail bg-rail-ink px-1 text-xs leading-none font-semibold text-primary-foreground tabular-nums"
              >
                {badgeText(router.pendingCount)}
              </span>
            )}
          </span>
          <span className="max-w-16 truncate text-xs font-medium text-rail-ink">Router</span>
        </button>
      </div>

      {computers.length > 0 && (
        <>
          <div aria-hidden="true" className="my-2.5 h-0.5 w-8 shrink-0 bg-rail-shade" />
          <div className="flex min-h-0 w-full flex-col items-center gap-2.5 overflow-y-auto px-1">
            {computers.map((c) => {
              const selected = selectedComputer === c.key;
              const offline = c.status === "offline" || c.status === "unreachable";
              const dotTone = c.status === "online" ? "bg-success" : c.status === "reconnecting" ? "bg-caution" : "bg-muted-foreground";
              const ariaParts = [c.name];
              if (offline) ariaParts.push("offline");
              else if (c.status === "reconnecting") ariaParts.push("reconnecting");
              if (c.badge > 0) ariaParts.push(`${c.badge} waiting`);
              return (
                <button
                  key={c.key}
                  type="button"
                  title={c.name}
                  aria-label={ariaParts.join(", ")}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectComputer(c.key)}
                  className="group flex flex-col items-center gap-1 outline-none cursor-pointer"
                >
                  <span
                    className={cn(
                      "relative grid size-12 place-items-center transition-colors group-focus-visible:outline-2 group-focus-visible:outline-border-focus",
                      selected
                        ? "border-2 border-rail-outline bg-list text-list-ink"
                        : offline
                          ? "text-rail-ink-soft group-hover:bg-rail-hover"
                          : "text-rail-ink group-hover:bg-rail-hover",
                    )}
                  >
                    <PlatformIcon platform={c.platform} size="inherit" className="size-pixel" />
                    <span
                      data-testid={`rail-device-dot-${c.key || "local"}`}
                      data-status={c.status}
                      aria-hidden="true"
                      className={cn("absolute -right-1 -bottom-1 size-3 border-2 border-rail", dotTone)}
                    />
                    {c.badge > 0 && (
                      <span
                        data-testid={`rail-device-badge-${c.key || "local"}`}
                        aria-hidden="true"
                        className="absolute -top-1.5 -right-2 grid min-w-5 h-5 place-items-center border-2 border-rail bg-rail-ink px-1 text-xs leading-none font-semibold text-primary-foreground tabular-nums"
                      >
                        {badgeText(c.badge)}
                      </span>
                    )}
                  </span>
                  <span className={cn("max-w-16 truncate text-xs font-medium", offline ? "text-rail-ink-soft" : "text-rail-ink")}>
                    {c.name}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div data-window-drag className="min-h-4 w-full flex-1" />

      <div className="flex shrink-0 flex-col items-center gap-2.5 pt-2 pb-3">
        {reminder !== null && (
          <Button variant="slot" size="icon-lg" aria-label={updateLabel} title={updateLabel} onClick={onOpenUpdates}>
            <Download aria-hidden="true" />
          </Button>
        )}

        {(meter !== null || quotaFetchable) && (
          <QuotaPopover
            quota={quota}
            fetchable={quotaFetchable}
            side="right"
            align="end"
            trigger={
              meter !== null ? (
                <button
                  type="button"
                  aria-label={meterLabel}
                  title={meterLabel}
                  className="touch-target flex cursor-pointer flex-col items-center gap-1 px-1 py-0.5 transition-colors outline-none hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-border-focus"
                >
                  <span aria-hidden="true" className="flex gap-0.5">
                    {Array.from({ length: RAIL_QUOTA_CELLS }, (_, i) => (
                      <span key={i} className={cn("h-3 w-1.5", i < meter.cells ? "bg-rail-ink" : "bg-rail-shade")} />
                    ))}
                  </span>
                  <span className={cn("text-xs leading-none font-semibold tabular-nums", meter.full ? "text-rail-danger" : meter.warning ? "text-rail-warn" : "text-rail-ink")}>
                    {meter.percent}%
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Usage"
                  title="Usage"
                  className="touch-target grid size-10 cursor-pointer place-items-center text-rail-ink transition-colors outline-none hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-border-focus"
                >
                  <Hourglass className="size-pixel" aria-hidden="true" />
                </button>
              )
            }
          />
        )}

        <button
          type="button"
          aria-label={resources.attention ? `Settings (${resources.heldCount} held)` : "Settings"}
          title="Settings"
          onClick={onOpenSettings}
          className="touch-target relative grid size-10 cursor-pointer place-items-center text-rail-ink transition-colors outline-none hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <Settings className="size-pixel" aria-hidden="true" />
          {resources.attention && (
            <span
              data-testid="settings-resources-attention"
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 size-2 bg-caution ring-2 ring-rail"
            />
          )}
        </button>

        <button
          type="button"
          aria-label="Account"
          title="Account"
          onClick={onOpenAccount}
          className="touch-target grid size-10 cursor-pointer place-items-center border-2 border-rail-outline bg-list text-list-ink transition-colors outline-none hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-border-focus"
        >
          <User className="size-pixel" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
