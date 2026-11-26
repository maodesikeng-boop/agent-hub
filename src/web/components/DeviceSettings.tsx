import { Loader2 } from "../ui/icons.ts";
import { useState, type ReactNode } from "react";
import { LINK_LABELS, platformLabel, type DeviceView } from "../devices.ts";
import { useDeviceRemove, useDeviceRename, type DeviceSettings } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import type { ComputerRenameApi } from "../settings-drafts.ts";
import { PlatformIcon, StatusDot, StatusText } from "./DeviceBadges.tsx";
import { InfoAction, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

export type { DeviceSettings };

function RenameRow({ device, draft, onDone }: { device: DeviceView; draft: { name: string; setName: (name: string) => void }; onDone: (changed: boolean) => void }) {
  const { name, setName, clean, problem, busy, error, save } = useDeviceRename(device, () => onDone(true), draft);
  return (
    <form
      className="py-1"
      onSubmit={(e) => {
        e.preventDefault();
        void save().then((res) => {
          if (res === "unchanged") onDone(false);
        });
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="Device name"
          value={name}
          autoFocus
          autoComplete="off"
          className="h-7.5 min-w-0 flex-1 text-minor"
          aria-invalid={problem !== null}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onDone(false);
            }
          }}
        />
        <Button type="button" variant="ghost" size="sm" className="h-7.5" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-7.5" disabled={clean === null || busy}>
          {busy && <Loader2 aria-hidden="true" />}
          Save
        </Button>
      </div>
      {(problem ?? error) && <RowError error={problem ?? error ?? undefined} />}
    </form>
  );
}

function DeviceRow({ device, onChanged, rename }: { device: DeviceView; onChanged: () => void; rename: ComputerRenameApi }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, remove } = useDeviceRemove(device, onChanged);
  const { info } = device;
  if (rename.rename?.deviceKey === device.key) {
    return (
      <div data-testid="device-row">
        <RenameRow
          device={device}
          draft={{ name: rename.rename.name, setName: rename.setName }}
          onDone={(changed) => {
            rename.finish();
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
        icon={<PlatformIcon platform={info.platform} size="inherit" />}
        error={error}
      >
        {() => (
          <span className="flex min-w-0 items-center gap-4.5">
            <span className="info-val flex min-w-0 flex-wrap items-center justify-end gap-x-3 text-minor tabular-nums">
              <span className="flex items-center gap-1.5">
                <StatusDot status={device.status} />
                <span>{platformLabel(info.platform)}</span>
              </span>
              {!info.self && info.link !== null && info.link !== "local" && <span>{LINK_LABELS[info.link]}</span>}
              {!info.self && <StatusText status={device.status} lastOnlineAt={device.lastOnlineAt} online />}
            </span>
            <span className="info-actions shrink-0">
              {confirming ? (
                <>
                  <InfoAction disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </InfoAction>
                  <InfoAction
                    danger
                    disabled={busy}
                    onClick={() =>
                      void remove().then((ok) => {
                        if (!ok) setConfirming(false);
                      })
                    }
                  >
                    {busy && <Loader2 className="size-3.5" aria-hidden="true" />}
                    Remove
                  </InfoAction>
                </>
              ) : (
                <>
                  <InfoAction aria-label={`Rename ${info.name}`} onClick={() => rename.start(device.key, info.name)}>
                    Rename…
                  </InfoAction>
                  {!info.self && (
                    <InfoAction danger aria-label={`Remove ${info.name}`} onClick={() => setConfirming(true)}>
                      Remove…
                    </InfoAction>
                  )}
                </>
              )}
            </span>
          </span>
        )}
      </SettingsRow>
    </div>
  );
}

export function ComputersSection({ devices, onChanged, account, rename }: DeviceSettings & { account: ReactNode; rename: ComputerRenameApi }) {
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  return (
    <>
      {account}
      <SettingsGroup title="This computer">
        {mine.map((device) => (
          <DeviceRow key={device.key} device={device} onChanged={onChanged} rename={rename} />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Your computers">
        {others.length === 0 ? (
          <p className="py-1.5 text-minor text-muted-foreground">No other computers</p>
        ) : (
          others.map((device) => <DeviceRow key={device.key} device={device} onChanged={onChanged} rename={rename} />)
        )}
      </SettingsGroup>
    </>
  );
}
