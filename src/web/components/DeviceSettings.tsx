// 设置 → 电脑（docs/multi-device-design.md 第 3.2、4.2 节，docs/hub-tunnel-design.md 第 8 节）：你的电脑（本机名字、系统、中心隧道）与已连上的电脑（名字、系统、连法、在线状态）、连到中心、邀请、添加、改名、移除；
// 设置 → 登录与安全里的“公网入口”也在这里（没开时收起）。
// 底层状态与入口本机接口调用统一由 settings-model.ts 提供，桌面弹窗与手机设置子页共用。
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { PEER_TRANSPORT_SPECS, type PublicEntryStatus, type TunnelStatus } from "../../shared/index.ts";
import { platformLabel, type DeviceView } from "../devices.ts";
import {
  TUNNEL_STATE_SPECS,
  useAddDevice,
  useDeviceInvite,
  useDeviceRemove,
  useDeviceRename,
  usePublicEntrySetting,
  useTunnelConnect,
  useTunnelRetry,
  type DeviceSettings,
} from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { PlatformIcon, StatusDot, StatusText } from "./DeviceBadges.tsx";
import { CollapsibleGroup, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

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
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
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
            {!info.self && info.transport && info.transport.kind !== "local" && (
              <span>{PEER_TRANSPORT_SPECS[info.transport.kind].label}</span>
            )}
            {info.self ? <span>This computer</span> : <StatusText status={device.status} lastOnlineAt={device.lastOnlineAt} online />}
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
                size="sm"
                disabled={busy}
                onClick={() =>
                  void remove().then((ok) => {
                    if (!ok) setConfirming(false);
                  })
                }
              >
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                Remove
              </Button>
            </>
          ) : (
            <span className="-mr-2 flex items-center gap-1">
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

/** 邀请别的设备：拿一个邀请码（10 分钟、只能用一次），支持一键复制邀请码与本机 URL。 */
function InvitePanel() {
  const { invite, busy, error, generate, codeCopied, copyCode, urlCopied, copyUrl } = useDeviceInvite();
  return (
    <SettingsGroup title="Invite a computer">
      <SettingsRow label="Invite code" error={error}>
        {(id) =>
          invite ? (
            <>
              <span className="font-mono text-body select-all">{invite.code}</span>
              <Button id={id} type="button" size="sm" variant="outline" aria-label={codeCopied ? "Copied" : "Copy code"} onClick={copyCode}>
                {codeCopied ? "Copied" : "Copy code"}
              </Button>
            </>
          ) : (
            <Button id={id} size="sm" variant="outline" aria-label="Generate" disabled={busy} onClick={() => void generate()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Generate
            </Button>
          )
        }
      </SettingsRow>
      {invite && (
        <SettingsRow
          label="This computer's URL"
          detail={invite.url ? <span className="block break-all font-mono text-minor select-all">{invite.url}</span> : undefined}
          wide={!invite.url}
        >
          {(id) =>
            invite.url ? (
              <Button id={id} type="button" size="sm" variant="outline" aria-label={urlCopied ? "Copied" : "Copy URL"} onClick={copyUrl}>
                {urlCopied ? "Copied" : "Copy URL"}
              </Button>
            ) : (
              <span id={id} className="truncate font-mono text-minor text-muted-foreground">
                Tailscale isn't installed
              </span>
            )
          }
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** 添加设备：填那台的网址和它给的邀请码。 */
function AddPanel({ onAdded }: { onAdded: () => void }) {
  const { url, setUrl, code, setCode, ready, busy, error, submit } = useAddDevice(onAdded);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SettingsGroup title="Add a computer">
        <SettingsRow label="URL">
          {(id) => <Input id={id} value={url} autoComplete="off" spellCheck={false} placeholder="https://…ts.net" className="w-60" onChange={(e) => setUrl(e.target.value)} />}
        </SettingsRow>
        <SettingsRow label="Invite code" error={error}>
          {(id) => <Input id={id} value={code} autoComplete="off" spellCheck={false} className="w-60 font-mono" onChange={(e) => setCode(e.target.value)} />}
        </SettingsRow>
        <div className="flex justify-end px-4 py-2.5">
          <Button type="submit" size="sm" disabled={!ready}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            Add
          </Button>
        </div>
      </SettingsGroup>
    </form>
  );
}

/** 本机到中心的 ssh 隧道状态行（docs/hub-tunnel-design.md 第 8 节）。报错英文原文只放 title。 */
function TunnelRow({ tunnel, onChanged }: { tunnel: TunnelStatus; onChanged: () => void }) {
  const { busy, error, retry } = useTunnelRetry(onChanged);
  const spec = TUNNEL_STATE_SPECS[tunnel.state];
  return (
    <div data-testid="tunnel-row">
      <SettingsRow
        label="Hub tunnel"
        error={error}
        detail={<span title={tunnel.detail ?? undefined}>{spec.text}</span>}
      >
        {() =>
          spec.canRetry ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Retry
            </Button>
          ) : null
        }
      </SettingsRow>
    </div>
  );
}

/** 连到中心（SSH 隧道）：给出带本机仓库路径的 join 命令，或贴入 ahtun1_ 连接码连接。 */
function TunnelPanel({ repoDir, onConnected }: { repoDir?: string; onConnected: () => void }) {
  const { command, code, setCode, ready, busy, error, copied, copyCommand, submit } = useTunnelConnect(repoDir, onConnected);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SettingsGroup title="Connect to hub">
        <SettingsRow
          label="Terminal command"
          detail={<code className="block break-all font-mono text-minor select-all">{command}</code>}
        >
          {(id) => (
            <Button id={id} type="button" variant="outline" size="sm" aria-label={copied ? "Copied" : "Copy"} onClick={copyCommand}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label="Connection code" error={error}>
          {(id) => (
            <>
              <Input
                id={id}
                value={code}
                autoComplete="off"
                spellCheck={false}
                placeholder="ahtun1_…"
                className="w-60 font-mono"
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="submit" disabled={!ready}>
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                Connect
              </Button>
            </>
          )}
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}

/** 公网入口开关与 Tailscale Funnel 命令向导（docs/mac-app-and-mobile-design.md 第 2.2 节）：没开、也没填过域名时收起成一行。 */
export function PublicEntrySection({ publicEntry, onChanged }: { publicEntry?: PublicEntryStatus; onChanged: () => void }) {
  const { entry, summary, hostname, setHostname, busy, error, copied, toggle, copyCommand } = usePublicEntrySetting(publicEntry, onChanged);
  return (
    <CollapsibleGroup title="Public access" summary={summary} defaultOpen={entry.enabled || entry.hostname !== null}>
      <SettingsRow
        label="Public domain"
        detail={
          entry.enabled && entry.hostname ? (
            <span className="font-mono text-minor select-all">{`https://${entry.hostname}`}</span>
          ) : undefined
        }
        error={error}
      >
        {(id) => (
          <>
            <Input
              id={id}
              value={hostname}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. tokyo.tailnet.ts.net"
              className="w-60 min-w-0 font-mono"
              onChange={(e) => setHostname(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void toggle()}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {entry.enabled ? "Turn off" : "Turn on"}
            </Button>
          </>
        )}
      </SettingsRow>
      {entry.enabled && (
        <SettingsRow
          label="Funnel command"
          detail={<code className="block break-all font-mono text-minor select-all">{entry.funnelCommand}</code>}
        >
          {(id) => (
            <Button id={id} type="button" variant="outline" size="sm" aria-label={copied ? "Copied" : "Copy command"} onClick={copyCommand}>
              {copied ? "Copied" : "Copy command"}
            </Button>
          )}
        </SettingsRow>
      )}
    </CollapsibleGroup>
  );
}

type Panel = "tunnel" | "invite" | "add";

/** 标题右边打开向导的小按钮：打开时 aria-expanded 浅底。 */
function PanelButton({ panel, current, onToggle, children }: { panel: Panel; current: Panel | null; onToggle: (p: Panel) => void; children: string }) {
  return (
    <Button variant="ghost" size="sm" className="aria-expanded:bg-accent aria-expanded:text-foreground" aria-expanded={current === panel} onClick={() => onToggle(panel)}>
      {children}
    </Button>
  );
}

/** 设置 → 电脑：“你的电脑”（本机、中心隧道，可连到中心）和“已连上的电脑”（别的设备，可邀请、添加），向导在各自组下面展开。 */
export function ComputersSection({ devices, tunnel, repoDir, onChanged }: Omit<DeviceSettings, "publicEntry">) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const toggle = (next: Panel) => setPanel((p) => (p === next ? null : next));
  const done = () => {
    setPanel(null);
    onChanged();
  };
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  return (
    <>
      <div className="grid gap-3">
        <SettingsGroup
          title="This computer"
          action={
            <span className="-mr-3 flex items-center gap-1">
              <PanelButton panel="tunnel" current={panel} onToggle={toggle}>
                Connect to hub
              </PanelButton>
            </span>
          }
        >
          {mine.map((device) => (
            <DeviceRow key={device.key} device={device} onChanged={onChanged} />
          ))}
          {tunnel !== null && tunnel !== undefined && <TunnelRow tunnel={tunnel} onChanged={onChanged} />}
        </SettingsGroup>
        {panel === "tunnel" && <TunnelPanel {...(repoDir !== undefined ? { repoDir } : {})} onConnected={done} />}
      </div>
      <div className="grid gap-3">
        <SettingsGroup
          title="Connected computers"
          action={
            <span className="-mr-3 flex items-center gap-1">
              <PanelButton panel="invite" current={panel} onToggle={toggle}>
                Invite
              </PanelButton>
              <PanelButton panel="add" current={panel} onToggle={toggle}>
                Add
              </PanelButton>
            </span>
          }
        >
          {others.length === 0 ? (
            <p className="px-4 py-3 text-body text-muted-foreground">No other computers yet</p>
          ) : (
            others.map((device) => <DeviceRow key={device.key} device={device} onChanged={onChanged} />)
          )}
        </SettingsGroup>
        {panel === "invite" && <InvitePanel />}
        {panel === "add" && <AddPanel onAdded={done} />}
      </div>
    </>
  );
}
