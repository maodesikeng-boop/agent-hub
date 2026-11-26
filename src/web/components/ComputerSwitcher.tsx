import type * as React from "react";
import type { DeviceKey, DeviceStatus } from "../devices.ts";
import { cn } from "../lib/utils.ts";
import type { RailComputer } from "../rail-model.ts";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "../ui/drawer.tsx";
import { Check } from "../ui/icons.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { PlatformIcon, StatusDot } from "./DeviceBadges.tsx";

export interface ComputerSwitcherProps {
  /** popover on the desktop PM column header, drawer on the phone. */
  variant: "popover" | "drawer";
  open: boolean;
  computers: readonly RailComputer[];
  selected: DeviceKey;
  /** The header button that opens the list. */
  trigger: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: DeviceKey) => void;
  /** Opens Settings on Computers. */
  onManage: () => void;
}

const CONNECTION_TEXT: Readonly<Record<DeviceStatus, string>> = {
  online: "Online",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline",
  unreachable: "Offline",
};

function SwitcherList({
  variant,
  computers,
  selected,
  onSelect,
  onManage,
  onClose,
}: {
  variant: "popover" | "drawer";
  computers: readonly RailComputer[];
  selected: DeviceKey;
  onSelect: (key: DeviceKey) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  return (
    <div className="grid gap-1">
      <div className="grid gap-1" role="list" aria-label="Linked computers">
        {computers.map((c) => {
          const current = c.key === selected;
          const offline = c.status === "offline" || c.status === "unreachable";
          return (
            <button
              key={c.key}
              type="button"
              aria-current={current ? "true" : undefined}
              onClick={() => {
                onSelect(c.key);
                onClose();
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 rounded-xs px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-border-focus",
                variant === "drawer" && "min-h-12",
                current ? "tile-open text-foreground" : "hover:bg-hover",
                offline && !current && "text-muted-foreground",
              )}
            >
              <PlatformIcon platform={c.platform} size="inherit" className="size-pixel shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span title={c.name} className="truncate text-body font-medium text-foreground">
                    {c.name}
                  </span>
                  <StatusDot status={c.status} />
                </div>
                <div className="text-xs text-muted-foreground">{CONNECTION_TEXT[c.status]}</div>
              </div>
              {c.badge > 0 && (
                <span className="shrink-0 bg-brand-ink px-1.5 py-0.5 text-xs font-semibold text-primary-foreground tabular-nums">
                  {c.badge}
                </span>
              )}
              {current && <Check className="size-pixel-sm shrink-0 text-brand-ink" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="mt-1 border-t border-border pt-1">
        <button
          type="button"
          onClick={() => {
            onClose();
            onManage();
          }}
          className={cn(
            "flex w-full cursor-pointer items-center rounded-xs px-3 py-2 text-left text-minor font-medium text-foreground transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus",
            variant === "drawer" && "min-h-11",
          )}
        >
          Manage computers...
        </button>
      </div>
    </div>
  );
}

/**
 * Postcondition: lists every computer with its status dot, connection text, and ask badge, marks the selected one,
 * closes after a pick, and ends with Manage computers...; offline computers stay selectable for reading.
 */
export function ComputerSwitcher({
  variant,
  open,
  computers,
  selected,
  trigger,
  onOpenChange,
  onSelect,
  onManage,
}: ComputerSwitcherProps): React.ReactElement {
  const close = () => onOpenChange(false);

  if (variant === "drawer") {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent aria-label="Computers">
          <DrawerTitle className="px-4 py-2 text-title font-semibold">Computers</DrawerTitle>
          <div className="overflow-y-auto px-3 pb-4">
            <SwitcherList
              variant="drawer"
              computers={computers}
              selected={selected}
              onSelect={onSelect}
              onManage={onManage}
              onClose={close}
            />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" aria-label="Computers" className="w-72 p-1.5">
        <SwitcherList
          variant="popover"
          computers={computers}
          selected={selected}
          onSelect={onSelect}
          onManage={onManage}
          onClose={close}
        />
      </PopoverContent>
    </Popover>
  );
}
