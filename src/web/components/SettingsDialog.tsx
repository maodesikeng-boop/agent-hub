import type { ReactNode } from "react";
import type { NotifySettings } from "../notify.ts";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";

/** 设置面板里的一项：左边名字，右边控件。以后加设置就加一个 SettingsItem。 */
function SettingsItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[15px] font-medium">{label}</span>
      {children}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, notify }: { open: boolean; onOpenChange: (open: boolean) => void; notify: NotifySettings }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置" className="max-w-[400px]">
        <div className="grid gap-4">
          <SettingsItem label="通知">
            <Switch
              aria-label="通知"
              checked={notify.enabled}
              disabled={notify.permission === "denied" || notify.permission === "unsupported"}
              onCheckedChange={(on) => void notify.setEnabled(on)}
            />
          </SettingsItem>
        </div>
      </DialogContent>
    </Dialog>
  );
}
