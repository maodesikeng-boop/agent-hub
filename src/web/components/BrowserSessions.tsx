import { Loader2 } from "../ui/icons.ts";
import { describeUserAgent, formatAgo, formatCountdown, userAgentDevice } from "../browser-sessions.ts";
import { useBrowserSessions, useSignInLink } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { PlatformIcon } from "./DeviceBadges.tsx";
import { QrCode } from "./QrCode.tsx";
import { CollapsibleGroup, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

export function BrowserSessionsSettings({ onSignedOut }: { onSignedOut?: () => void }) {
  const signIn = useSignInLink();
  const {
    sessions,
    loadError,
    rowErrors,
    allError,
    busy,
    confirmingSelf,
    setConfirmingSelf,
    confirmingAll,
    setConfirmingAll,
    signOut,
    signOutAll,
  } = useBrowserSessions({
    pollWhileActive: signIn.polling,
    ...(onSignedOut !== undefined ? { onSignedOut } : {}),
  });

  return (
    <>
      <SettingsGroup label="Sign in on another device">
        <SettingsRow label="Sign in on another device" error={signIn.error}>
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
              {signIn.busy && <Loader2 aria-hidden="true" />}
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
                <QrCode text={signIn.link.url} label="Sign-in QR code" className="size-40 border-2 border-border" />
                <p className="text-body text-muted-foreground tabular-nums">{formatCountdown(signIn.remainingMs)}</p>
              </>
            )}
          </div>
        )}
      </SettingsGroup>
      <CollapsibleGroup
        title="Signed-in browsers"
        summary={sessions === null ? undefined : String(sessions.length)}
        defaultOpen={loadError !== null}
      >
        {sessions === null && loadError === null && (
          <div className="flex min-h-13 items-center justify-center">
            <Loader2 className="size-pixel text-muted-foreground" aria-label="Loading" />
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
          const confirming = session.current && confirmingSelf;
          const detail = (
            <span className="flex flex-wrap items-center gap-x-3">
              {session.current && <span>This browser</span>}
              <span>{ago}</span>
            </span>
          );
          return (
            <SettingsRow key={session.id} label={name} icon={<PlatformIcon platform={userAgentDevice(session.userAgent)} size="inherit" />} detail={detail} error={rowErrors[session.id]}>
              {(id) =>
                confirming ? (
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
                      {busy === `exit:${session.id}` && <Loader2 aria-hidden="true" />}Sign out
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
                    {busy === `exit:${session.id}` && <Loader2 aria-hidden="true" />}Sign out
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
              {busy === "all" && <Loader2 aria-hidden="true" />}
              {confirmingAll ? "Confirm sign out all" : "Sign out all"}
            </Button>
          )}
        </SettingsRow>
      </CollapsibleGroup>
    </>
  );
}
