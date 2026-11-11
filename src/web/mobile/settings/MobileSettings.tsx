// 手机外壳的全局设置（docs/mobile-settings-design.md 第 2 节）：整屏二级路由钻取，#/settings 一级主页（Inset Grouped 状态总览）→ #/settings/<section> 聚焦子页。
// 一级主页 6～7 行摘要全从内存、localStorage 与 react-query 已有缓存同步读，打开时 0 次 HTTP 请求；进子页时一级主页用 <Activity hidden> 保活（滚动位置不丢）。
// 桌面外壳不经过这里（Sidebar 打开 SettingsDialog）；两边的状态与接口都来自 settings-model.ts。
import { Activity, memo, type ReactNode } from "react";
import { Bell, Blocks, Globe, Monitor, QrCode, Smartphone, Type } from "lucide-react";
import { SettingsGroup } from "../../components/SettingsList.tsx";
import type { NotifySettings } from "../../notify.ts";
import type { SettingsSection } from "../../route.ts";
import {
  describeComputersSummary,
  describeNotifySummary,
  describePublicEntrySummary,
  useCachedBrowserSessionsSummary,
  useUiScaleSetting,
  useVendorSyncSetting,
  type DeviceSettings,
} from "../../settings-model.ts";
import { Loader2 } from "lucide-react";
import { BrowsersPage } from "./BrowsersPage.tsx";
import { ComputersPage } from "./ComputersPage.tsx";
import { NotificationsPage } from "./NotificationsPage.tsx";
import { PublicAccessPage } from "./PublicAccessPage.tsx";
import { ScalePage } from "./ScalePage.tsx";
import { SettingsNavRow } from "./SettingsNavRow.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { SignInPage } from "./SignInPage.tsx";
import { VendorSyncFooter, VendorSyncPage, type VendorSync } from "./VendorSyncPage.tsx";

export interface MobileSettingsProps {
  /** 当前子页；undefined 是一级主页。 */
  section: SettingsSection | undefined;
  notify: NotifySettings;
  /** 守护进程支持联机时才有：电脑组与公网入口。 */
  devices: DeviceSettings | null;
  onOpen: (section: SettingsSection) => void;
  /** 顶栏返回（一级回列表、子页回一级），App 里走 mobileBack。 */
  onBack: () => void;
  /** 本机会话被退出后怎么办（默认刷新页面回到登录态）；测试注入。 */
  onSignedOut?: () => void;
}

interface SubpageContext {
  notify: NotifySettings;
  devices: DeviceSettings | null;
  vendor: VendorSync;
  onSignedOut?: () => void;
}

interface SubpageSpec {
  title: string;
  render: (ctx: SubpageContext) => ReactNode;
  footer?: (ctx: SubpageContext) => ReactNode;
}

/** 需要联机的子页：设备清单还没到时转圈（没开联机的直达网址由 shell-model 退回一级）。 */
const withDevices = (ctx: SubpageContext, render: (devices: DeviceSettings) => ReactNode) =>
  ctx.devices === null ? (
    <div className="flex min-h-24 items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
    </div>
  ) : (
    render(ctx.devices)
  );

/** 每个子页的标题与内容；Record 穷尽 SettingsSection，漏配一个 typecheck 就报错（第 3.3 节）。 */
const SUBPAGES: Record<SettingsSection, SubpageSpec> = {
  scale: { title: "Interface scale", render: () => <ScalePage /> },
  notifications: { title: "Notifications", render: (ctx) => <NotificationsPage notify={ctx.notify} /> },
  "vendor-sync": {
    title: "Vendor sync",
    render: (ctx) => <VendorSyncPage vendor={ctx.vendor} />,
    footer: (ctx) => (ctx.vendor.preview === null ? null : <VendorSyncFooter vendor={ctx.vendor} />),
  },
  computers: { title: "Computers", render: (ctx) => withDevices(ctx, (devices) => <ComputersPage devices={devices} />) },
  "sign-in": { title: "Sign in", render: () => <SignInPage /> },
  browsers: { title: "Signed-in browsers", render: (ctx) => <BrowsersPage {...(ctx.onSignedOut !== undefined ? { onSignedOut: ctx.onSignedOut } : {})} /> },
  "public-access": { title: "Public access", render: (ctx) => withDevices(ctx, (devices) => <PublicAccessPage devices={devices} />) },
};

function SettingsHome({
  notify,
  devices,
  vendorSynced,
  onOpen,
  onBack,
}: {
  notify: NotifySettings;
  devices: DeviceSettings | null;
  vendorSynced: boolean;
  onOpen: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  const { label: scaleLabel } = useUiScaleSetting();
  const browsers = useCachedBrowserSessionsSummary();
  return (
    <SettingsPage title="Settings" home onBack={onBack}>
      <SettingsGroup title="General">
        <SettingsNavRow icon={<Type aria-hidden="true" />} label="Interface scale" summary={scaleLabel} onClick={() => onOpen("scale")} />
        <SettingsNavRow icon={<Bell aria-hidden="true" />} label="Notifications" summary={describeNotifySummary(notify)} onClick={() => onOpen("notifications")} />
        <SettingsNavRow
          icon={<Blocks aria-hidden="true" />}
          label="Vendor sync"
          {...(vendorSynced ? { summary: "Synced" } : {})}
          onClick={() => onOpen("vendor-sync")}
        />
      </SettingsGroup>
      {devices !== null && (
        <SettingsGroup title="Computers">
          <SettingsNavRow icon={<Monitor aria-hidden="true" />} label="Computers" summary={describeComputersSummary(devices)} onClick={() => onOpen("computers")} />
        </SettingsGroup>
      )}
      <SettingsGroup title="Security & Access">
        <SettingsNavRow icon={<QrCode aria-hidden="true" />} label="Sign in on another device" onClick={() => onOpen("sign-in")} />
        <SettingsNavRow
          icon={<Smartphone aria-hidden="true" />}
          label="Signed-in browsers"
          summary={browsers.summary}
          attention={browsers.hasPending}
          attentionTestId="browsers-attention"
          onClick={() => onOpen("browsers")}
        />
        {devices !== null && (
          <SettingsNavRow
            icon={<Globe aria-hidden="true" />}
            label="Public access"
            summary={describePublicEntrySummary(devices.publicEntry)}
            onClick={() => onOpen("public-access")}
          />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

// memo：App 每个流式帧都会重画，这里的 props（通知设置、设备设置、两个回调）都是稳定引用，设置页开着时不跟着重画
export const MobileSettings = memo(function MobileSettings({ section, notify, devices, onOpen, onBack, onSignedOut }: MobileSettingsProps) {
  // 同步预览与结果放在这一层：从子页回到一级主页还看得到 Synced，再进子页预览还在（全是按需的 mutation，没有初始请求）
  const vendor = useVendorSyncSetting();
  const spec = section === undefined ? null : SUBPAGES[section];
  const ctx: SubpageContext = { notify, devices, vendor, ...(onSignedOut !== undefined ? { onSignedOut } : {}) };
  return (
    <div data-testid="mobile-settings" className="flex h-full min-w-0 flex-1 flex-col">
      <Activity mode={spec === null ? "visible" : "hidden"}>
        <SettingsHome notify={notify} devices={devices} vendorSynced={vendor.lastSummary !== null} onOpen={onOpen} onBack={onBack} />
      </Activity>
      {spec !== null && (
        <SettingsPage key={section} title={spec.title} onBack={onBack} footer={spec.footer?.(ctx)}>
          {spec.render(ctx)}
        </SettingsPage>
      )}
    </div>
  );
});
