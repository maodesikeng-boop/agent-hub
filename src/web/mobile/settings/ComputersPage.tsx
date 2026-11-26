import { Loader2 } from "../../ui/icons.ts";
import { useState, type ReactNode } from "react";
import { AccountSettings } from "../../components/AccountSettings.tsx";
import { PlatformIcon, StatusDot, StatusText } from "../../components/DeviceBadges.tsx";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { useComputerRename, type ComputerRenameApi } from "../../settings-drafts.ts";
import { LINK_LABELS, platformLabel, type DeviceView } from "../../devices.ts";
import { useDeviceRemove, useDeviceRename, type DeviceSettings } from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { ConfirmBody, DRAWER_BUTTON, SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";
import { SettingsNavRow, TOUCH_INPUT } from "./SettingsNavRow.tsx";

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

function RenameForm({ device, onChanged, onDone, onCancel, draft }: { draft: { name: string; setName: (name: string) => void }; device: DeviceView; onChanged: () => void; onDone: () => void; onCancel: () => void }) {
  const { name, setName, clean, problem, busy, error, save } = useDeviceRename(device, onChanged, draft);
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

function ManageView({ device, onChanged, close, onRename }: { device: DeviceView; onChanged: () => void; close: () => void; onRename: () => void }) {
  const [view, setView] = useState<"menu" | "remove">("menu");
  const { busy, error, remove } = useDeviceRemove(device, onChanged);
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
        <Button variant="outline" className={DRAWER_BUTTON} onClick={onRename}>
          Rename…
        </Button>
        <Button variant="outline" className={`${DRAWER_BUTTON} text-danger`} onClick={() => setView("remove")}>
          Remove computer…
        </Button>
      </div>
    </>
  );
}

export function ComputersPage({ devices: settings, account, rename: sharedRename }: { devices: DeviceSettings; account?: ReactNode; rename?: ComputerRenameApi }) {
  const { devices, onChanged } = settings;
  const localRename = useComputerRename();
  const rename = sharedRename ?? localRename;
  const target = rename.rename === null ? undefined : devices.find((device) => device.key === rename.rename?.deviceKey);
  const manage = useDrawerTarget<DeviceView>();
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  return (
    <>
      {account ?? <AccountSettings />}
      <SettingsGroup title="This computer">
        {mine.map((device) => (
          <DeviceNavRow key={device.key} device={device} onClick={() => rename.start(device.key, device.info.name)} />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Your computers">
        {others.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">No other computers</p>
        ) : (
          others.map((device) => <DeviceNavRow key={device.key} device={device} onClick={() => manage.show(device)} />)
        )}
      </SettingsGroup>

      <SettingsDrawer
        open={target !== undefined || manage.open}
        onOpenChange={(open) => {
          if (!open) {
            rename.finish();
            manage.close();
          }
        }}
        title={target?.info.self ? "Rename computer" : target?.info.name ?? manage.target?.info.name ?? ""}
      >
        {target !== undefined && rename.rename !== null ? (
          <RenameForm
            device={target}
            onChanged={onChanged}
            draft={{ name: rename.rename.name, setName: rename.setName }}
            onDone={() => { rename.finish(); manage.close(); }}
            onCancel={rename.finish}
          />
        ) : manage.target !== null && (
          <ManageView device={manage.target} onChanged={onChanged} close={manage.close} onRename={() => {
            if (manage.target !== null) rename.start(manage.target.key, manage.target.info.name);
          }} />
        )}
      </SettingsDrawer>
    </>
  );
}
