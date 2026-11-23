import { createElement } from "react";
import {
  DeviceAndroid,
  DeviceIphone,
  DeviceLinux,
  DeviceMacos,
  DeviceWindows,
  Monitor,
  Smartphone,
  Tablet,
  type Icon,
} from "../ui/icons.ts";
import type { DeviceStatus } from "../devices.ts";
import { formatAgo } from "../format.ts";
import { cn } from "../lib/utils.ts";

export function StatusDot({ status }: { status: DeviceStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", status === "online" ? "bg-success" : status === "reconnecting" ? "bg-caution" : "bg-muted-foreground/40")}
    />
  );
}

export function StatusText({ status, lastOnlineAt, online = false }: { status: DeviceStatus; lastOnlineAt: number | null; online?: boolean }) {
  if (status === "online") return online ? <span>Online</span> : null;
  if (status === "connecting") return null;
  if (status === "reconnecting") return <span>Reconnecting</span>;
  return (
    <span className="flex items-center gap-2">
      <span>Offline</span>
      {status === "offline" && lastOnlineAt !== null && <span className="tabular-nums">{formatAgo(lastOnlineAt)}</span>}
    </span>
  );
}

const PLATFORM_ICONS: Readonly<Record<string, Icon>> = {
  darwin: DeviceMacos,
  macos: DeviceMacos,
  win32: DeviceWindows,
  windows: DeviceWindows,
  linux: DeviceLinux,
  iphone: DeviceIphone,
  ios: DeviceIphone,
  android: DeviceAndroid,
  tablet: Tablet,
  ipad: Tablet,
  phone: Smartphone,
};

export function PlatformIcon({ platform, className, size = "sm" }: { platform: string; className?: string; size?: "sm" | "inherit" }) {
  return createElement(PLATFORM_ICONS[platform.toLowerCase()] ?? Monitor, {
    className: cn(size === "sm" && "size-pixel-sm shrink-0", className),
    "aria-hidden": true,
  });
}
