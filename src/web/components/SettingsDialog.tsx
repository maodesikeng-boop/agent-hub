import type { NotifySettings } from "../notify.ts";
import { Dialog, DialogBody, DialogContent } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { DevicesSection, type DeviceSettings } from "./DeviceSettings.tsx";
import { SettingsGroup, SettingsRow, SettingsVariantProvider } from "./SettingsList.tsx";

export type { DeviceSettings };

/** 开关打不开的原因，能打开的没有。 */
const NOTIFY_BLOCKED: Partial<Record<NotifySettings["permission"], string>> = {
  denied: "浏览器拦下了，到网站设置里允许通知",
  unsupported: "这个浏览器不支持通知",
  install: "先在 Safari 里“添加到主屏幕”，从主屏图标打开再开",
};

/** 全局设置（照 Linear / Claude desktop 的平铺分组列表，不套灰底肥皂块）：以后加设置就加一行 SettingsRow。 */
export function SettingsDialog({
  open,
  onOpenChange,
  notify,
  devices = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notify: NotifySettings;
  /** 守护进程支持联机时才有“设备”一组。 */
  devices?: DeviceSettings | null;
}) {
  const notifyGroup = (
    <SettingsGroup label="通知">
      {/* 打不开的时候开关是灰的，下面一句说清为什么、怎么办（同表单校验：不让用户点了才知道） */}
      <SettingsRow label="通知" detail={NOTIFY_BLOCKED[notify.permission]}>
        {(id) => (
          <Switch
            id={id}
            aria-label="通知"
            checked={notify.enabled}
            disabled={NOTIFY_BLOCKED[notify.permission] !== undefined}
            onCheckedChange={(on) => void notify.setEnabled(on)}
          />
        )}
      </SettingsRow>
    </SettingsGroup>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置">
        <SettingsVariantProvider value="plain">
          <DialogBody>
            {notifyGroup}
            {devices && <DevicesSection {...devices} />}
            <BrowserSessionsSettings />
          </DialogBody>
        </SettingsVariantProvider>
      </DialogContent>
    </Dialog>
  );
}
