// #/settings/computers：清爽行列表 + 底部抽屉（docs/mobile-settings-design.md 第 2.3 节子页 3）。
// 行上不放小图标按钮（根治相邻 32px 改名 / 移除按钮热区重叠误删）：本机行点了改名，远程电脑行点了拉起管理抽屉（改名…、移除电脑…二次确认）；
// 隧道报错原因直接写在行里（触屏看不到 title）；连到中心、邀请、添加都是整行入口 + 全宽表单抽屉。状态与接口全来自 settings-model.ts。
import { Cable, Loader2, Plus, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PEER_TRANSPORT_SPECS, type TunnelStatus } from "../../../shared/index.ts";
import { PlatformIcon, StatusDot, StatusText } from "../../components/DeviceBadges.tsx";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { platformLabel, type DeviceView } from "../../devices.ts";
import {
  TUNNEL_STATE_SPECS,
  useAddDevice,
  useDeviceInvite,
  useDeviceRemove,
  useDeviceRename,
  useTunnelConnect,
  useTunnelRetry,
  type DeviceSettings,
} from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { ConfirmBody, DRAWER_BUTTON, SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";
import { CodeLine, FieldBlock, NO_AUTOCORRECT, SettingsNavRow, TOUCH_INPUT } from "./SettingsNavRow.tsx";

/** 设备行的小字：状态点 + 系统、连法、在线状态（本机写 This computer），用间距分开，不用 · 拼接。 */
function DeviceDetail({ device }: { device: DeviceView }) {
  const { info } = device;
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <span className="flex items-center gap-2">
        <StatusDot status={device.status} />
        <span>{platformLabel(info.platform)}</span>
      </span>
      {!info.self && info.transport && info.transport.kind !== "local" && <span>{PEER_TRANSPORT_SPECS[info.transport.kind].label}</span>}
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

/** 中心隧道：状态词在第二行，出问题时 ssh 的报错原文直接折行写出来，能重试的右边一个 Retry。 */
function TunnelRow({ tunnel, onChanged }: { tunnel: TunnelStatus; onChanged: () => void }) {
  const { busy, error, retry } = useTunnelRetry(onChanged);
  const spec = TUNNEL_STATE_SPECS[tunnel.state];
  return (
    <div data-testid="tunnel-row" className="flex min-h-12 items-center gap-3 px-4 py-3">
      <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4 [&_svg]:stroke-[1.5]">
        <Cable aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body">Hub tunnel</p>
        <p className="mt-0.5 text-minor leading-snug text-muted-foreground">{spec.text}</p>
        {tunnel.state !== "connected" && tunnel.detail && (
          <p className="mt-1 font-mono text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{tunnel.detail}</p>
        )}
        {error && <RowError error={error} />}
      </div>
      {spec.canRetry && (
        <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={() => void retry()}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          Retry
        </Button>
      )}
    </div>
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
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
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
        description={`${device.info.name} stops showing here until you add it again with a new invite code`}
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

/** 连到中心：带本机仓库路径的 join 命令 + 复制，或贴入 ahtun1_ 连接码连接。 */
function TunnelForm({ repoDir, onConnected }: { repoDir?: string; onConnected: () => void }) {
  const { command, code, setCode, ready, busy, error, copied, copyCommand, submit } = useTunnelConnect(repoDir, onConnected);
  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Block label="Terminal command">
        <CodeLine>{command}</CodeLine>
        <Button type="button" variant="outline" className={DRAWER_BUTTON} onClick={copyCommand}>
          {copied ? "Copied" : "Copy command"}
        </Button>
      </Block>
      <FieldBlock bare label="Connection code" error={error}>
        {(id) => (
          <Input id={id} {...NO_AUTOCORRECT} value={code} placeholder="ahtun1_…" className={`${TOUCH_INPUT} font-mono`} onChange={(e) => setCode(e.target.value)} />
        )}
      </FieldBlock>
      <Button type="submit" className={DRAWER_BUTTON} disabled={!ready}>
        {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
        Connect
      </Button>
    </form>
  );
}

/** 邀请别的电脑：生成 10 分钟一次性邀请码，邀请码与本机完整 URL 各配全宽复制按钮（不截断、不藏进 title）。 */
function InviteView() {
  const { invite, busy, error, generate, codeCopied, copyCode, urlCopied, copyUrl } = useDeviceInvite();
  if (invite === null) {
    return (
      <>
        <Button className={DRAWER_BUTTON} disabled={busy} onClick={() => void generate()}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          Generate
        </Button>
        {error && <RowError error={error} />}
      </>
    );
  }
  return (
    <>
      <Block label="Invite code">
        <p className="text-center font-mono text-title font-semibold tracking-wider break-all select-all">{invite.code}</p>
        <Button className={DRAWER_BUTTON} onClick={copyCode}>
          {codeCopied ? "Copied" : "Copy code"}
        </Button>
      </Block>
      <Block label="This computer's URL">
        {invite.url ? (
          <>
            <CodeLine>{invite.url}</CodeLine>
            <Button variant="outline" className={DRAWER_BUTTON} onClick={copyUrl}>
              {urlCopied ? "Copied" : "Copy URL"}
            </Button>
          </>
        ) : (
          <p className="text-minor text-muted-foreground">Tailscale isn't installed</p>
        )}
      </Block>
    </>
  );
}

/** 添加别的电脑：纵向全宽表单（URL + 邀请码），关掉自动大写和纠错。 */
function AddForm({ onAdded }: { onAdded: () => void }) {
  const { url, setUrl, code, setCode, ready, busy, error, submit } = useAddDevice(onAdded);
  return (
    <form
      className="grid grid-cols-1 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FieldBlock bare label="URL">
        {(id) => (
          <Input id={id} type="url" inputMode="url" {...NO_AUTOCORRECT} value={url} placeholder="https://…ts.net" className={TOUCH_INPUT} onChange={(e) => setUrl(e.target.value)} />
        )}
      </FieldBlock>
      <FieldBlock bare label="Invite code" error={error}>
        {(id) => <Input id={id} {...NO_AUTOCORRECT} value={code} className={`${TOUCH_INPUT} font-mono`} onChange={(e) => setCode(e.target.value)} />}
      </FieldBlock>
      <Button type="submit" className={DRAWER_BUTTON} disabled={!ready}>
        {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
        Add
      </Button>
    </form>
  );
}

/** 抽屉里的一块：小标题 + 内容，纵向排。 */
function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid grid-cols-1 gap-2">
      <h3 className="text-minor font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

type Panel = "tunnel" | "invite" | "add";

const PANEL_TITLES: Record<Panel, string> = { tunnel: "Connect to hub", invite: "Invite a computer", add: "Add a computer" };

export function ComputersPage({ devices: settings }: { devices: DeviceSettings }) {
  const { devices, tunnel, repoDir, onChanged } = settings;
  const rename = useDrawerTarget<DeviceView>();
  const manage = useDrawerTarget<DeviceView>();
  const panel = useDrawerTarget<Panel>();
  const mine = devices.filter((d) => d.info.self);
  const others = devices.filter((d) => !d.info.self);
  const done = () => {
    panel.close();
    onChanged();
  };
  return (
    <>
      <SettingsGroup title="This computer">
        {mine.map((device) => (
          <DeviceNavRow key={device.key} device={device} onClick={() => rename.show(device)} />
        ))}
        {tunnel != null && <TunnelRow tunnel={tunnel} onChanged={onChanged} />}
        <SettingsNavRow icon={<Cable aria-hidden="true" />} label="Connect to hub…" onClick={() => panel.show("tunnel")} />
      </SettingsGroup>
      <SettingsGroup title="Connected computers">
        {others.length === 0 ? (
          <p className="px-4 py-3 text-body text-muted-foreground">No other computers yet</p>
        ) : (
          others.map((device) => <DeviceNavRow key={device.key} device={device} onClick={() => manage.show(device)} />)
        )}
        <SettingsNavRow icon={<Send aria-hidden="true" />} label="Invite a computer…" onClick={() => panel.show("invite")} />
        <SettingsNavRow icon={<Plus aria-hidden="true" />} label="Add a computer…" onClick={() => panel.show("add")} />
      </SettingsGroup>

      <SettingsDrawer open={rename.open} onOpenChange={rename.onOpenChange} title="Rename computer">
        {rename.target !== null && <RenameForm device={rename.target} onChanged={onChanged} onDone={rename.close} onCancel={rename.close} />}
      </SettingsDrawer>
      <SettingsDrawer open={manage.open} onOpenChange={manage.onOpenChange} title={manage.target?.info.name ?? ""}>
        {manage.target !== null && <ManageView device={manage.target} onChanged={onChanged} close={manage.close} />}
      </SettingsDrawer>
      <SettingsDrawer open={panel.open} onOpenChange={panel.onOpenChange} title={panel.target === null ? "" : PANEL_TITLES[panel.target]}>
        {panel.target === "tunnel" && <TunnelForm {...(repoDir !== undefined ? { repoDir } : {})} onConnected={done} />}
        {panel.target === "invite" && <InviteView />}
        {panel.target === "add" && <AddForm onAdded={done} />}
      </SettingsDrawer>
    </>
  );
}
