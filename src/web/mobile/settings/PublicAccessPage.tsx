// #/settings/public-access：整行开关（没填域名又没开时灰）+ 全宽域名输入框（url 键盘、关自动大写纠错）；开着时改了域名才出现 Save domain；
// 开着时下面一组是 Funnel 命令和全宽 Copy command。软键盘弹起时内容区底部垫 --bottom-inset，输入框和按钮不被盖住。
import { Loader2 } from "lucide-react";
import { SettingsGroup } from "../../components/SettingsList.tsx";
import { usePublicEntrySetting, type DeviceSettings } from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { DRAWER_BUTTON } from "./SettingsDrawer.tsx";
import { CodeLine, FieldBlock, NO_AUTOCORRECT, SwitchRow, TOUCH_INPUT } from "./SettingsNavRow.tsx";

export function PublicAccessPage({ devices }: { devices: DeviceSettings }) {
  const { entry, hostname, setHostname, hostnameDirty, busy, error, copied, setEnabled, saveHostname, copyCommand } = usePublicEntrySetting(
    devices.publicEntry,
    devices.onChanged,
  );
  const canTurnOn = entry.enabled || hostname.trim() !== "";
  return (
    <>
      <SettingsGroup label="Public access">
        <SwitchRow
          label="Public access"
          detail={entry.enabled && entry.hostname ? <span className="font-mono break-all">{`https://${entry.hostname}`}</span> : undefined}
          checked={entry.enabled}
          disabled={busy || !canTurnOn}
          onCheckedChange={(on) => void setEnabled(on)}
        />
        <FieldBlock label="Public domain" error={error}>
          {(id) => (
            <>
              <Input
                id={id}
                type="text"
                inputMode="url"
                {...NO_AUTOCORRECT}
                value={hostname}
                placeholder="e.g. tokyo.tailnet.ts.net"
                className={`${TOUCH_INPUT} font-mono`}
                onChange={(e) => setHostname(e.target.value)}
              />
              {entry.enabled && hostnameDirty && (
                <Button variant="outline" className={DRAWER_BUTTON} disabled={busy} onClick={() => void saveHostname()}>
                  {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Save domain
                </Button>
              )}
            </>
          )}
        </FieldBlock>
      </SettingsGroup>
      {entry.enabled && (
        <SettingsGroup title="Funnel command">
          <div className="grid grid-cols-1 gap-3 px-4 py-3">
            <CodeLine>{entry.funnelCommand}</CodeLine>
            <Button variant="outline" className={DRAWER_BUTTON} onClick={copyCommand}>
              {copied ? "Copied" : "Copy command"}
            </Button>
          </div>
        </SettingsGroup>
      )}
    </>
  );
}
