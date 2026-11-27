import { createElement } from "react";
import {
  DeviceAndroid,
  DeviceAndroidSolid,
  DeviceIphone,
  DeviceIphoneSolid,
  DeviceLinux,
  DeviceLinuxSolid,
  DeviceMacos,
  DeviceMacosSolid,
  DeviceWindows,
  DeviceWindowsSolid,
  Monitor,
  Smartphone,
  Tablet,
  type Icon,
} from "../ui/icons.ts";
import type { DeviceStatus } from "../devices.ts";
import { cn } from "../lib/utils.ts";
import { TimeAgo } from "./TimeAgo.tsx";

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
      {status === "offline" && lastOnlineAt !== null && <span className="tabular-nums"><TimeAgo at={lastOnlineAt} /></span>}
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

const SOLID_ICONS = new Map<Icon, Icon>([
  [DeviceMacos, DeviceMacosSolid],
  [DeviceWindows, DeviceWindowsSolid],
  [DeviceLinux, DeviceLinuxSolid],
  [DeviceIphone, DeviceIphoneSolid],
  [DeviceAndroid, DeviceAndroidSolid],
]);

/** solid: the filled form a selected computer shows on the rail; generic devices fill their outline. */
export function PlatformIcon({ platform, className, size = "sm", solid = false }: { platform: string; className?: string; size?: "sm" | "inherit"; solid?: boolean }) {
  const line = PLATFORM_ICONS[platform.toLowerCase()] ?? Monitor;
  const filled = SOLID_ICONS.get(line);
  return createElement(solid && filled ? filled : line, {
    className: cn(size === "sm" && "size-pixel-sm shrink-0", className),
    "aria-hidden": true,
    ...(solid && !filled ? { fill: "currentColor" } : {}),
  });
}
