// #/settings/notifications：整行开关；打不开（浏览器拒了、不支持、iOS 没加到主屏幕）时开关灰掉，框下面一句话说清怎么解除。
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
      {blocked && <p className="px-4 text-minor leading-snug text-muted-foreground">{blocked}</p>}
    </div>
  );
}
