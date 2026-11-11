import { Monitor, Settings, Shield, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { NotifySettings } from "../notify.ts";
import { NOTIFY_BLOCKED, isNotifyBlocked, useUiScaleSetting, type DeviceSettings } from "../settings-model.ts";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Switch } from "../ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { ComputersSection, PublicEntrySection } from "./DeviceSettings.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { VendorSyncSettings } from "./VendorSyncSettings.tsx";

export type { DeviceSettings };

/** 界面大小：点了马上整页跟着变（字号、头像、间距），记在这台浏览器上。 */
function UiScaleRow() {
  const { scale, options, setScale } = useUiScaleSetting();
  return (
    <SettingsRow label="Interface scale">
      {(id) => <Segmented id={id} label="Interface scale" value={scale} options={options} onChange={setScale} />}
    </SettingsRow>
  );
}

type SectionId = "general" | "computers" | "security";

/** 左栏的分类（照 Grok Bot 设置页）：顺序就是左栏从上到下；“电脑”只在守护进程支持联机时有。 */
const SECTIONS: readonly { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "security", label: "Security & Access", icon: Shield },
];

/**
 * 全局设置（docs/ui-standard.md 第 10 条，照 Grok Bot / Claude desktop 的双栏设置页）：
 * 左栏分类（窄屏变成顶上一排），右栏是当前分类的标题和若干白底细框分组。以后加设置就往对应分类里加一行 SettingsRow。
 */
export function SettingsDialog({
  open,
  onOpenChange,
  notify,
  devices = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notify: NotifySettings;
  /** 守护进程支持联机时才有“电脑”分类和“公网入口”。 */
  devices?: DeviceSettings | null;
}) {
  const content: Record<SectionId, ReactNode> = {
    general: (
      <>
        <SettingsGroup title="Appearance">
          <UiScaleRow />
        </SettingsGroup>
        <SettingsGroup label="Notifications">
          {/* 打不开的时候开关是灰的，下面一句说清为什么、怎么办（同表单校验：不让用户点了才知道） */}
          <SettingsRow label="Notifications" detail={NOTIFY_BLOCKED[notify.permission]}>
            {(id) => (
              <Switch
                id={id}
                aria-label="Notifications"
                checked={notify.enabled}
                disabled={isNotifyBlocked(notify)}
                onCheckedChange={(on) => void notify.setEnabled(on)}
              />
            )}
          </SettingsRow>
        </SettingsGroup>
        <VendorSyncSettings />
      </>
    ),
    computers: devices && <ComputersSection {...devices} />,
    security: (
      <>
        <BrowserSessionsSettings />
        {devices && <PublicEntrySection {...(devices.publicEntry !== undefined ? { publicEntry: devices.publicEntry } : {})} onChanged={devices.onChanged} />}
      </>
    ),
  };
  const sections = SECTIONS.filter((s) => s.id !== "computers" || devices !== null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" titleClassName="sr-only" className="h-[min(35rem,calc(100%-3rem))] max-w-195 gap-0 p-0">
        <Tabs defaultValue={devices !== null ? "computers" : "general"} orientation="vertical" className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* 窄屏：一排横着的分类（只有字，放得下三个），右边让出关闭按钮的位置 */}
          <TabsList
            aria-label="Settings categories"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-sidebar py-3 pr-14 pl-3 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:px-3 sm:py-4"
          >
            {sections.map(({ id, label, icon: Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="flex h-9 shrink-0 cursor-pointer items-center gap-3 rounded-xl px-3 text-body whitespace-nowrap transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=active]:bg-sidebar-active"
              >
                <Icon className="size-4 shrink-0 stroke-[1.5] max-sm:hidden" aria-hidden="true" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {sections.map(({ id, label }) => (
            // 分类名固定在上面（右边让出关闭按钮），只有下面的分组滚；上下左右多留 4px 再收回，聚焦的圈不被裁掉。
            // 宽度：右栏 min-w-0（横排时 flex 子项默认不会比内容窄，内容有长域名就把整栏撑出弹窗），分组那一列 grid-cols-1（= minmax(0,1fr)，列宽不跟内容走）
            <TabsContent key={id} value={id} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
              <h2 className="shrink-0 px-6 pt-6 pr-14 pb-5 text-title font-semibold">{label}</h2>
              <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-6 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pt-1 pb-6">{content[id]}</div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
