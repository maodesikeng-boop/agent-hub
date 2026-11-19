// #/settings/computers：清爽行列表 + 底部抽屉（docs/mobile-settings-design.md 第 2.3 节子页 3，docs/account-mesh-design.md「网页」）。
// 行上不放小图标按钮（根治相邻 32px 改名 / 移除按钮热区重叠误删）：本机行点了改名，远程电脑行点了拉起管理抽屉（改名…、移除电脑…二次确认）；
// 账号（登录、批准新电脑、中心顺序）和桌面共用 AccountSettings。状态与接口全来自 settings-model.ts。
import { Loader2 } from "../../ui/icons.ts";
import { useState } from "react";
import { AccountSettings } from "../../components/AccountSettings.tsx";
import { PlatformIcon, StatusDot, StatusText } from "../../components/DeviceBadges.tsx";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { LINK_LABELS, platformLabel, type DeviceView } from "../../devices.ts";
import { useDeviceRemove, useDeviceRename, type DeviceSettings } from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { ConfirmBody, DRAWER_BUTTON, SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";
import { SettingsNavRow, TOUCH_INPUT } from "./SettingsNavRow.tsx";

/** 设备行的小字：状态点 + 系统、连法、在线状态（本机写 This computer），用间距分开，不用 · 拼接。 */
function DeviceDetail({ device }: { device: DeviceView }) {
  const { info } = device;
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <span className="flex items-center gap-2">
        <StatusDot status={device.status} />
        <span>{platformLabel(info.platform)}</span>
      </span>
      {!info.self && info.link !== null && info.link !== "local" && <span>{LINK_LABELS[info.link]}</span>}
      {info.self ? <span>This computer</span> : <StatusText status={device.status} lastOnlineAt={device.lastOnlineAt} online />}
    </span>
  );
}

function DeviceNavRow({ device, onClick }: { device: DeviceView; onClick: () => void }) {
  return (
    <SettingsNavRow
      className="min-h-14"
      icon={<PlatformIcon platform={device.info.platform} />}
      label={device.info.name}
      detail={<DeviceDetail device={device} />}
      onClick={onClick}
    />
  );
}

/** 改名表单（本机改名抽屉、远程电脑管理抽屉共用）：全宽输入框，边输边校验，Save + Cancel 全宽。 */
function RenameForm({ device, onChanged, onDone, onCancel }: { device: DeviceView; onChanged: () => void; onDone: () => void; onCancel: () => void }) {
  const { name, setName, clean, problem, busy, error, save } = useDeviceRename(device, onChanged);
  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save().then((res) => {
          if (res !== false) onDone();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-1">
        <Input
          aria-label="Computer name"
          value={name}
          autoComplete="off"
          className={TOUCH_INPUT}
          aria-invalid={problem !== null}
          onChange={(e) => setName(e.target.value)}
        />
        {(problem ?? error) && <RowError error={problem ?? error ?? undefined} />}
      </div>
      <div className="grid grid-cols-1 gap-2">
        <Button type="submit" className={DRAWER_BUTTON} disabled={clean === null || busy}>
          {busy && <Loader2 aria-hidden="true" />}
          Save
        </Button>
        <Button type="button" variant="outline" className={DRAWER_BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** 远程电脑的管理抽屉：先给两个操作，改名、移除各自切到自己的视图（移除要二次确认，红色 Remove）。 */
function ManageView({ device, onChanged, close }: { device: DeviceView; onChanged: () => void; close: () => void }) {
  const [view, setView] = useState<"menu" | "rename" | "remove">("menu");
  const { busy, error, remove } = useDeviceRemove(device, onChanged);
  if (view === "rename") return <RenameForm device={device} onChanged={onChanged} onDone={close} onCancel={() => setView("menu")} />;
  if (view === "remove") {
    return (
      <ConfirmBody
        description={`${device.info.name} will be removed from your account`}
        confirmLabel="Remove"
        busy={busy}
        error={error}
        onConfirm={() =>
          void remove().then((ok) => {
            if (ok) close();
          })
        }
        onCancel={() => setView("menu")}
      />
    );
  }
  return (
    <>
      <p className="flex justify-center text-minor text-muted-foreground">
        <DeviceDetail device={device} />
      </p>
      <div className="grid grid-cols-1 gap-2">
        <Button variant="outline" className={DRAWER_BUTTON} onClick={() => setView("rename")}>
          Rename…
        </Button>
        <Button variant="outline" className={`${DRAWER_BUTTON} text-danger`} onClick={() => setView("remove")}>
          Remove computer…
        </Button>
      </div>
    </>
  );
}

export function ComputersPage({ devices: settings }: { devices: DeviceSettings }) {
  const { devices, onChanged } = settings;
  const rename = useDrawerTarget<DeviceView>();
  const manage = useDrawerTarget<DeviceView>();
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  return (
    <>
      <AccountSettings />
      <SettingsGroup title="This computer">
        {mine.map((device) => (
          <DeviceNavRow key={device.key} device={device} onClick={() => rename.show(device)} />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Your computers">
        {others.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">No other computers</p>
        ) : (
          others.map((device) => <DeviceNavRow key={device.key} device={device} onClick={() => manage.show(device)} />)
        )}
      </SettingsGroup>

      <SettingsDrawer open={rename.open} onOpenChange={rename.onOpenChange} title="Rename computer">
        {rename.target !== null && <RenameForm device={rename.target} onChanged={onChanged} onDone={rename.close} onCancel={rename.close} />}
      </SettingsDrawer>
      <SettingsDrawer open={manage.open} onOpenChange={manage.onOpenChange} title={manage.target?.info.name ?? ""}>
        {manage.target !== null && <ManageView device={manage.target} onChanged={onChanged} close={manage.close} />}
      </SettingsDrawer>
    </>
  );
}
