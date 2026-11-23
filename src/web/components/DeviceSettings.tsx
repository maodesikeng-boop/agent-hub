import { Loader2, Pencil, Trash2 } from "../ui/icons.ts";
import { useState } from "react";
import { LINK_LABELS, platformLabel, type DeviceView } from "../devices.ts";
import { useDeviceRemove, useDeviceRename, type DeviceSettings } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { AccountSettings } from "./AccountSettings.tsx";
import { PlatformIcon, StatusDot, StatusText } from "./DeviceBadges.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

export type { DeviceSettings };

function RenameRow({ device, onDone }: { device: DeviceView; onDone: (changed: boolean) => void }) {
  const { name, setName, clean, problem, busy, error, save } = useDeviceRename(device, () => onDone(true));
  return (
    <form
      className="px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save().then((res) => {
          if (res === "unchanged") onDone(false);
        });
      }}
    >
      <div className="flex min-h-9 items-center gap-2">
        <Input
          aria-label="Device name"
          value={name}
          autoFocus
          autoComplete="off"
          className="min-w-0 flex-1"
          aria-invalid={problem !== null}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onDone(false);
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={clean === null || busy}>
          {busy && <Loader2 aria-hidden="true" />}
          Save
        </Button>
      </div>
      {(problem ?? error) && <RowError error={problem ?? error ?? undefined} />}
    </form>
  );
}

function DeviceRow({ device, onChanged }: { device: DeviceView; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, remove } = useDeviceRemove(device, onChanged);
  const { info } = device;
  if (renaming) {
    return (
      <div data-testid="device-row">
        <RenameRow
          device={device}
          onDone={(changed) => {
            setRenaming(false);
            if (changed) onChanged();
          }}
        />
      </div>
    );
  }
  return (
    <div data-testid="device-row">
      <SettingsRow
        label={info.name}
        icon={<PlatformIcon platform={info.platform} />}
        error={error}
        detail={
          <span className="flex flex-wrap items-center gap-x-3">
            <span className="flex items-center gap-2">
              <StatusDot status={device.status} />
              <span>{platformLabel(info.platform)}</span>
            </span>
            {!info.self && info.link !== null && info.link !== "local" && <span>{LINK_LABELS[info.link]}</span>}
            {!info.self && <StatusText status={device.status} lastOnlineAt={device.lastOnlineAt} online />}
          </span>
        }
      >
        {() =>
          confirming ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void remove().then((ok) => {
                    if (!ok) setConfirming(false);
                  })
                }
              >
                {busy && <Loader2 aria-hidden="true" />}
                Remove
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={`Rename ${info.name}`} onClick={() => setRenaming(true)}>
                <Pencil aria-hidden="true" />
              </Button>
              {!info.self && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove ${info.name}`} onClick={() => setConfirming(true)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </span>
          )
        }
      </SettingsRow>
    </div>
  );
}

export function ComputersSection({ devices, onChanged }: DeviceSettings) {
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  return (
    <>
      <AccountSettings />
      <SettingsGroup title="This computer">
        {mine.map((device) => (
          <DeviceRow key={device.key} device={device} onChanged={onChanged} />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Your computers">
        {others.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">No other computers</p>
        ) : (
          others.map((device) => <DeviceRow key={device.key} device={device} onChanged={onChanged} />)
        )}
      </SettingsGroup>
    </>
  );
}
