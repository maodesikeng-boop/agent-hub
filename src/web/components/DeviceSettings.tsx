// 设置 → 设备（docs/multi-device-design.md 第 3.2、4.2 节，docs/hub-tunnel-design.md 第 8 节）：设备列表（名字、系统、连法、在线状态）、连到中心、邀请、添加、改名、移除。
// 这些都是入口自己的接口（不转发），一律走 client.ts 里入口本机的那几个函数；改完让外面重新拉设备清单。
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  PEER_TRANSPORT_SPECS,
  normalizeName,
  type DeviceId,
  type DeviceInviteResponse,
  type TunnelState,
  type TunnelStatus,
} from "../../shared/index.ts";
import { deleteDevice, patchDevice, postAddDevice, postDeviceInvite, postTunnelConnect, postTunnelRetry } from "../client.ts";
import { platformLabel, type DeviceView } from "../devices.ts";
import { errorText, nameError, type ErrorLike } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { COPIED_RESET_MS, copyText } from "./CodeBlock.tsx";
import { StatusDot, StatusText } from "./DeviceBadges.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 设置弹窗要的：所有设备（入口本机第一）、本机隧道状态与仓库路径，改了之后重新拉清单。 */
export interface DeviceSettings {
  devices: readonly DeviceView[];
  tunnel?: TunnelStatus | null;
  repoDir?: string;
  onChanged: () => void;
}

const TUNNEL_STATE_SPECS: Record<TunnelState, { text: string; canRetry: boolean }> = {
  connecting: { text: "Connecting…", canRetry: false },
  connected: { text: "Connected", canRetry: false },
  retrying: { text: "Retrying…", canRetry: true },
  auth_failed: { text: "密钥被拒绝", canRetry: true },
  hostkey_mismatch: { text: "服务器指纹变了", canRetry: true },
};

function RenameRow({ device, onDone }: { device: DeviceView; onDone: (changed: boolean) => void }) {
  const [name, setName] = useState(device.info.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const clean = normalizeName(name);
  const problem = nameError(name);
  const save = async () => {
    if (clean === null || busy) return;
    if (clean === device.info.name) return onDone(false);
    setBusy(true);
    setError(null);
    try {
      await patchDevice(device.info.id, { name: clean });
      onDone(true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form
      className="px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex min-h-9 items-center gap-2">
        <Input
          aria-label="设备名"
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
          取消
        </Button>
        <Button type="submit" size="sm" disabled={clean === null || busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          保存
        </Button>
      </div>
      {(problem ?? error) && <RowError error={problem ?? error ?? undefined} />}
    </form>
  );
}

function DeviceRow({ device, onChanged }: { device: DeviceView; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
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
  const remove = async (id: DeviceId) => {
    setBusy(true);
    setError(null);
    try {
      await deleteDevice(id);
      onChanged();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <div data-testid="device-row">
      <SettingsRow
        label={info.name}
        error={error}
        detail={
          <span className="flex items-center gap-3">
            <span>{platformLabel(info.platform)}</span>
            {!info.self && info.transport && info.transport.kind !== "local" && (
              <span>{PEER_TRANSPORT_SPECS[info.transport.kind].label}</span>
            )}
            {info.self ? (
              <span>本机</span>
            ) : (
              <span className="flex items-center gap-2">
                <StatusDot status={device.status} />
                <StatusText status={device.status} lastOnlineAt={device.lastOnlineAt} online />
              </span>
            )}
          </span>
        }
      >
        {() =>
          confirming ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void remove(info.id)}>
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                确认移除
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`给 ${info.name} 改名`} onClick={() => setRenaming(true)}>
                <Pencil aria-hidden="true" />
              </Button>
              {!info.self && (
                <Button variant="ghost" size="icon-sm" aria-label={`移除 ${info.name}`} onClick={() => setConfirming(true)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </>
          )
        }
      </SettingsRow>
    </div>
  );
}

/** 邀请别的设备：拿一个邀请码（10 分钟、只能用一次），到另一台的“添加设备”里填。 */
function InvitePanel() {
  const [invite, setInvite] = useState<DeviceInviteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await postDeviceInvite());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup title="邀请别的设备">
      <SettingsRow label="邀请码" error={error}>
        {(id) =>
          invite ? (
            <span id={id} className="font-mono text-[15px] select-all">
              {invite.code}
            </span>
          ) : (
            <Button id={id} size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              生成
            </Button>
          )
        }
      </SettingsRow>
      {invite && (
        <SettingsRow label="本机网址" wide>
          {(id) => (
            <span id={id} className="truncate font-mono text-[13.5px] text-muted-foreground select-all" title={invite.url ?? undefined}>
              {invite.url ?? "还没装 Tailscale"}
            </span>
          )}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** 添加设备：填那台的网址和它给的邀请码。 */
function AddPanel({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const ready = url.trim() !== "" && code.trim() !== "" && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await postAddDevice({ url: url.trim(), code: code.trim() });
      setUrl("");
      setCode("");
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SettingsGroup title="添加设备">
        <SettingsRow label="网址">
          {(id) => <Input id={id} value={url} autoComplete="off" spellCheck={false} placeholder="https://…ts.net" className="w-[240px]" onChange={(e) => setUrl(e.target.value)} />}
        </SettingsRow>
        <SettingsRow label="邀请码" error={error}>
          {(id) => <Input id={id} value={code} autoComplete="off" spellCheck={false} className="w-[240px] font-mono" onChange={(e) => setCode(e.target.value)} />}
        </SettingsRow>
      </SettingsGroup>
      <div className="flex justify-end">
        <Button type="submit" disabled={!ready}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          添加
        </Button>
      </div>
    </form>
  );
}

/** 本机到中心的 ssh 隧道状态行（docs/hub-tunnel-design.md 第 8 节）。报错英文原文只放 title。 */
function TunnelRow({ tunnel, onChanged }: { tunnel: TunnelStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const spec = TUNNEL_STATE_SPECS[tunnel.state];
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await postTunnelRetry();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="tunnel-row">
      <SettingsRow
        label="中心隧道"
        error={error}
        detail={<span title={tunnel.detail ?? undefined}>{spec.text}</span>}
      >
        {() =>
          spec.canRetry ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              重试
            </Button>
          ) : null
        }
      </SettingsRow>
    </div>
  );
}

/** 连到中心（SSH 隧道）：给出带本机仓库路径的 join 命令，或贴入 ahtun1_ 连接码连接。 */
function TunnelPanel({ repoDir, onConnected }: { repoDir?: string; onConnected: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const command = `node ${repoDir ?? "~/agent-hub"}/src/tunnel/main.ts join -i ~/.ssh/<密钥> ubuntu@<服务器IP>`;
  const ready = code.trim() !== "" && !busy;

  const copy = () => {
    void copyText(command).then(() => {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await postTunnelConnect(code.trim());
      setCode("");
      onConnected();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SettingsGroup title="连到中心">
        <SettingsRow
          label="终端命令"
          detail={<code className="block break-all font-mono text-[13.5px] select-all">{command}</code>}
        >
          {(id) => (
            <Button id={id} type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? "已复制" : "复制"}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label="连接码" error={error}>
          {(id) => (
            <Input
              id={id}
              value={code}
              autoComplete="off"
              spellCheck={false}
              placeholder="ahtun1_…"
              className="w-[240px] font-mono"
              onChange={(e) => setCode(e.target.value)}
            />
          )}
        </SettingsRow>
      </SettingsGroup>
      <div className="flex justify-end">
        <Button type="submit" disabled={!ready}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          连接
        </Button>
      </div>
    </form>
  );
}

/** 设置弹窗里的“设备”一组，下面按需展开“连到中心”、“邀请”或“添加”。 */
export function DevicesSection({ devices, tunnel, repoDir, onChanged }: DeviceSettings) {
  const [panel, setPanel] = useState<"tunnel" | "invite" | "add" | null>(null);
  const toggle = (next: "tunnel" | "invite" | "add") => setPanel((p) => (p === next ? null : next));
  return (
    <>
      <SettingsGroup
        title="设备"
        action={
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" aria-expanded={panel === "tunnel"} onClick={() => toggle("tunnel")}>
              连到中心
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={panel === "invite"} onClick={() => toggle("invite")}>
              邀请
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={panel === "add"} onClick={() => toggle("add")}>
              添加
            </Button>
          </span>
        }
      >
        {devices.map((device) => (
          <DeviceRow key={device.key} device={device} onChanged={onChanged} />
        ))}
        {tunnel !== null && tunnel !== undefined && <TunnelRow tunnel={tunnel} onChanged={onChanged} />}
      </SettingsGroup>
      {panel === "tunnel" && (
        <TunnelPanel
          {...(repoDir !== undefined ? { repoDir } : {})}
          onConnected={() => {
            setPanel(null);
            onChanged();
          }}
        />
      )}
      {panel === "invite" && <InvitePanel />}
      {panel === "add" && (
        <AddPanel
          onAdded={() => {
            setPanel(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
