import { SettingsGroup } from "../../components/SettingsList.tsx";
import type { NotifySettings } from "../../notify.ts";
import { NOTIFY_BLOCKED, isNotifyBlocked } from "../../settings-model.ts";
import { SwitchRow } from "./SettingsNavRow.tsx";

export function NotificationsPage({ notify }: { notify: NotifySettings }) {
  const blocked = NOTIFY_BLOCKED[notify.permission];
  return (
    <div className="grid grid-cols-1 gap-2">
      <SettingsGroup label="Notifications">
        <SwitchRow label="Notifications" checked={notify.enabled} disabled={isNotifyBlocked(notify)} onCheckedChange={(on) => void notify.setEnabled(on)} />
      </SettingsGroup>
      {blocked && <p className="text-xs leading-snug text-muted-foreground">{blocked}</p>}
    </div>
  );
}
