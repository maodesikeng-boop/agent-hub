import type { NotifySettings } from "../notify.ts";
import { Dialog, DialogContent } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 全局设置：和资料页一样的分组行，以后加设置就加一行 SettingsRow。 */
export function SettingsDialog({ open, onOpenChange, notify }: { open: boolean; onOpenChange: (open: boolean) => void; notify: NotifySettings }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="设置" className="max-w-[440px]">
        <SettingsGroup>
          <SettingsRow label="通知">
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
