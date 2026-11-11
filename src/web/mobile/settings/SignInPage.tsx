// #/settings/sign-in：进页不请求；点 Create sign-in link 才生成 5 分钟一次性链接，居中 192px 二维码 + 倒计时 + 全宽 Copy link / 系统 Share… / Hide。
// 只有二维码显示期间才每 3s 拉一次已登录浏览器（另一台扫码登录上了就收起）；离开子页卸载后倒计时与轮询一起停。
import { Loader2, QrCode as QrCodeIcon } from "lucide-react";
import { formatCountdown } from "../../browser-sessions.ts";
import { QrCode } from "../../components/QrCode.tsx";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { useBrowserSessions, useSignInLink } from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { DRAWER_BUTTON } from "./SettingsDrawer.tsx";

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

export function SignInPage() {
  const signIn = useSignInLink();
  useBrowserSessions({ enabled: signIn.polling, pollWhileActive: signIn.polling });
  const { link } = signIn;
  const share = () => {
    if (link === null) return;
    // 用户关掉分享面板会 reject（AbortError），不算错
    navigator.share({ url: link.url }).catch(() => {});
  };
  return (
    <SettingsGroup label="Sign in on another device">
      {link === null ? (
        <div className="flex flex-col items-center gap-5 px-4 pt-8 pb-4">
          <QrCodeIcon className="size-10 stroke-[1.5] text-muted-foreground" aria-hidden="true" />
          <div className="grid w-full grid-cols-1 gap-2">
            <Button className={DRAWER_BUTTON} disabled={signIn.busy} onClick={signIn.generate}>
              {signIn.busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Create sign-in link
            </Button>
            {signIn.error && <RowError error={signIn.error} />}
          </div>
        </div>
      ) : signIn.expired ? (
        <div className="flex flex-col items-center gap-4 px-4 pt-8 pb-4">
          <p className="text-body text-muted-foreground">Expired</p>
          <Button className={DRAWER_BUTTON} disabled={signIn.busy} onClick={signIn.generate}>
            {signIn.busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            Regenerate
          </Button>
          {signIn.error && <RowError error={signIn.error} />}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 px-4 pt-6 pb-4">
          <QrCode text={link.url} label="Sign-in QR code" className="size-48 rounded-xl" />
          <p className="text-body text-muted-foreground tabular-nums">{formatCountdown(signIn.remainingMs)}</p>
          <div className="mt-1 grid w-full grid-cols-1 gap-2">
            <Button className={DRAWER_BUTTON} onClick={signIn.copyLink}>
              {signIn.copied ? "Copied" : "Copy link"}
            </Button>
            {canShare() && (
              <Button variant="outline" className={DRAWER_BUTTON} onClick={share}>
                Share…
              </Button>
            )}
            <Button variant="ghost" className={DRAWER_BUTTON} onClick={signIn.hide}>
              Hide
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
