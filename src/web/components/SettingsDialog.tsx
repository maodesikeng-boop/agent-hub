import type { NotifySettings } from "../notify.ts";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 开关打不开的原因，能打开的没有。 */
const NOTIFY_BLOCKED: Partial<Record<NotifySettings["permission"], string>> = {
  denied: "浏览器拦下了，到网站设置里允许通知",
  unsupported: "这个浏览器不支持通知",
};

/** 全局设置：和资料页一样的分组行，以后加设置就加一行 SettingsRow。 */
export function SettingsDialog({ open, onOpenChange, notify }: { open: boolean; onOpenChange: (open: boolean) => void; notify: NotifySettings }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置" className="max-w-[440px]">
        <SettingsGroup>
          {/* 打不开的时候开关是灰的，下面一句说清为什么、怎么办（同表单校验：不让用户点了才知道） */}
          <SettingsRow label="通知" detail={NOTIFY_BLOCKED[notify.permission]}>
            {(id) => (
              <Switch
                id={id}
                aria-label="通知"
                checked={notify.enabled}
                disabled={notify.permission === "denied" || notify.permission === "unsupported"}
                onCheckedChange={(on) => void notify.setEnabled(on)}
              />
            )}
          </SettingsRow>
        </SettingsGroup>
      </DialogContent>
    </Dialog>
  );
}
