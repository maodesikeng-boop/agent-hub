// 设置 → 登录与安全（联机 P6，docs/multi-device-design.md 第 3.4 节）：
// “在手机上登录”显示一次性登录链接的二维码（5 分钟、用一次）；
// “已登录的浏览器”默认收起（有待批准的才展开），每个浏览器一行（左边电脑 / 手机图标），能单个退出；“全部退出”换主钥匙、清所有会话。
import { Loader2, Monitor, Smartphone, Tablet } from "lucide-react";
import { describeUserAgent, formatAgo, formatCountdown, userAgentKind } from "../browser-sessions.ts";
import { useBrowserSessions, useSignInLink } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { QrCode } from "./QrCode.tsx";
import { CollapsibleGroup, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 行左边的图标：电脑、手机、平板。 */
const KIND_ICONS = { computer: Monitor, phone: Smartphone, tablet: Tablet } as const;

export function BrowserSessionsSettings({ onSignedOut }: { onSignedOut?: () => void }) {
  const signIn = useSignInLink();
  const {
    sessions,
    hasPending,
    loadError,
    rowErrors,
    allError,
    busy,
    confirmingSelf,
    setConfirmingSelf,
    confirmingAll,
    setConfirmingAll,
    signOut,
    approve,
    signOutAll,
  } = useBrowserSessions({
    pollWhileActive: signIn.polling,
    ...(onSignedOut !== undefined ? { onSignedOut } : {}),
  });

  return (
    <>
      <SettingsGroup label="Sign in on phone">
        <SettingsRow label="Sign in on phone" error={signIn.error}>
          {(id) => (
            <Button
              id={id}
              variant="ghost"
              size="sm"
              aria-label={signIn.link === null ? "Show QR code" : "Hide"}
              disabled={signIn.busy}
              className="-mr-3"
              onClick={() => (signIn.link === null ? signIn.generate() : signIn.hide())}
            >
              {signIn.busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {signIn.link === null ? "Show QR code" : "Hide"}
            </Button>
          )}
        </SettingsRow>
        {signIn.link !== null && (
          <div className="flex flex-col items-center gap-3 px-4 py-4">
            {signIn.expired ? (
              <>
                <p className="text-body text-muted-foreground">Expired</p>
                <Button variant="outline" size="sm" disabled={signIn.busy} onClick={signIn.generate}>
                  Regenerate
                </Button>
              </>
            ) : (
              <>
                <QrCode text={signIn.link.url} label="Sign-in QR code" className="size-40 rounded-xl" />
                <p className="text-body text-muted-foreground tabular-nums">{formatCountdown(signIn.remainingMs)}</p>
              </>
            )}
          </div>
        )}
      </SettingsGroup>
      <CollapsibleGroup
        title="Signed-in browsers"
        summary={sessions === null ? undefined : String(sessions.length)}
        defaultOpen={hasPending || loadError !== null}
      >
        {sessions === null && loadError === null && (
          <div className="flex min-h-13 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        )}
        {loadError !== null && (
          <div className="px-4 py-3">
            <RowError error={loadError} />
          </div>
        )}
        {sessions?.map((session) => {
          const name = describeUserAgent(session.userAgent);
          const ago = formatAgo(session.lastSeenAt, signIn.now);
          const pending = session.status === "pending_approval";
          const confirming = session.current && confirmingSelf;
          const KindIcon = KIND_ICONS[userAgentKind(session.userAgent)];
          const detail = (
            <span className="flex flex-wrap items-center gap-x-3">
              {session.current && <span>This browser</span>}
              {pending && <span>Pending approval</span>}
              {session.viaPublic && <span>Via public access</span>}
              <span>{ago}</span>
            </span>
          );
          return (
            <SettingsRow key={session.id} label={name} icon={<KindIcon />} detail={detail} error={rowErrors[session.id]}>
              {(id) =>
                pending ? (
                  <span className="-mr-3 flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label="Deny" disabled={busy !== null} onClick={() => signOut(session)}>
                      {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}Deny
                    </Button>
                    <Button id={id} variant="ghost" size="sm" aria-label="Allow" disabled={busy !== null} onClick={() => approve(session)}>
                      {busy === `approve:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}Allow
                    </Button>
                  </span>
                ) : confirming ? (
                  <span className="-mr-3 flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmingSelf(false)}>
                      Cancel
                    </Button>
                    <Button
                      id={id}
                      variant="ghost"
                      size="sm"
                      aria-label="Confirm sign out"
                      disabled={busy !== null}
                      className="text-danger hover:text-danger"
                      onClick={() => signOut(session)}
                    >
                      {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}Sign out
                    </Button>
                  </span>
                ) : (
                  <Button
                    id={id}
                    variant="ghost"
                    size="sm"
                    aria-label={`Sign out ${name}`}
                    disabled={busy !== null}
                    className="-mr-3"
                    onClick={() => (session.current ? setConfirmingSelf(true) : signOut(session))}
                  >
                    {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}Sign out
                  </Button>
                )
              }
            </SettingsRow>
          );
        })}
        <SettingsRow label="All browsers" error={allError}>
          {(id) => (
            <Button
              id={id}
              variant="ghost"
              size="sm"
              aria-label={confirmingAll ? "Confirm sign out all" : "Sign out all"}
              disabled={busy !== null}
              className={confirmingAll ? "-mr-3 text-danger hover:text-danger" : "-mr-3"}
              onClick={() => (confirmingAll ? signOutAll() : setConfirmingAll(true))}
              onBlur={() => setConfirmingAll(false)}
            >
              {busy === "all" && <Loader2 className="animate-spin" aria-hidden="true" />}
              {confirmingAll ? "Confirm sign out all" : "Sign out all"}
            </Button>
          )}
        </SettingsRow>
      </CollapsibleGroup>
    </>
  );
}
