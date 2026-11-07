// 设备的状态点、状态词、系统图标（左栏组头、设置里的设备列表共用，docs/multi-device-design.md 第 4.3 节）。
import { Laptop, Monitor, Server } from "lucide-react";
import type { DeviceStatus } from "../devices.ts";
import { formatAgo } from "../format.ts";
import { cn } from "../lib/utils.ts";

/** 状态点：在线成功色，重连中黄，别的灰（ui-standard 第 4 条的状态色）。 */
export function StatusDot({ status }: { status: DeviceStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", status === "online" ? "bg-success" : status === "reconnecting" ? "bg-caution" : "bg-muted-foreground/40")}
    />
  );
}

/** 状态词和时间：在线、连接中不写；重连中；离线（断开过的再写多久以前）。 */
export function StatusText({ status, lastOnlineAt, online = false }: { status: DeviceStatus; lastOnlineAt: number | null; online?: boolean }) {
  if (status === "online") return online ? <span>在线</span> : null;
  if (status === "connecting") return null;
  if (status === "reconnecting") return <span>重连中</span>;
  return (
    <span className="flex items-center gap-2">
      <span>离线</span>
      {status === "offline" && lastOnlineAt !== null && <span className="tabular-nums">{formatAgo(lastOnlineAt)}</span>}
    </span>
  );
}

/** 系统图标：Mac 笔记本、Linux 服务器，别的显示器。 */
export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const Icon = platform === "darwin" ? Laptop : platform === "linux" ? Server : Monitor;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}
