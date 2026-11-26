import { Loader2 } from "../ui/icons.ts";
import { describeUserAgent, formatAgo, formatCountdown, userAgentDevice } from "../browser-sessions.ts";
import { useBrowserSessions, useSignInLink } from "../settings-model.ts";
import { PlatformIcon } from "./DeviceBadges.tsx";
import { QrCode } from "./QrCode.tsx";
import { CollapsibleGroup, InfoAction, ReadonlyValue, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

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
            <InfoAction
              id={id}
              aria-label={signIn.link === null ? "Show QR code" : "Hide"}
              disabled={signIn.busy}
              onClick={() => (signIn.link === null ? signIn.generate() : signIn.hide())}
            >
              {signIn.busy && <Loader2 className="size-3.5" aria-hidden="true" />}
              {signIn.link === null ? "Show QR code" : "Hide"}
            </InfoAction>
          )}
        </SettingsRow>
        {signIn.link !== null && (
          <div className="flex flex-col items-center gap-2 py-3">
            {signIn.expired ? (
              <>
                <p className="text-minor text-muted-foreground">Expired</p>
                <InfoAction disabled={signIn.busy} onClick={signIn.generate}>
                  Regenerate
                </InfoAction>
              </>
            ) : (
              <>
                <QrCode text={signIn.link.url} label="Sign-in QR code" className="size-40 rounded-sm border border-border" />
                <p className="info-val text-minor tabular-nums">{formatCountdown(signIn.remainingMs)}</p>
              </>
            )}
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup>
      <CollapsibleGroup
        title="Signed-in browsers"
        summary={sessions === null ? undefined : String(sessions.length)}
        defaultOpen={loadError !== null}
      >
        {sessions === null && loadError === null && (
          <div className="flex h-7.5 items-center justify-center">
            <Loader2 className="size-pixel text-muted-foreground" aria-label="Loading" />
          </div>
        )}
        {loadError !== null && (
          <div>
            <RowError error={loadError} />
          </div>
        )}
        {sessions?.map((session) => {
          const name = describeUserAgent(session.userAgent);
          const ago = formatAgo(session.lastSeenAt, signIn.now);
          const confirming = session.current && confirmingSelf;
          const detail = (
            <span className="inline-flex flex-wrap items-center justify-end gap-x-3">
              {session.current && <span>This browser</span>}
              <span>{ago}</span>
            </span>
          );
          return (
            <SettingsRow key={session.id} label={name} icon={<PlatformIcon platform={userAgentDevice(session.userAgent)} size="inherit" />} error={rowErrors[session.id]}>
              {(id) => (
                <span className="flex items-center gap-4.5">
                  <ReadonlyValue>{detail}</ReadonlyValue>
                  {confirming ? (
                    <>
                      <InfoAction disabled={busy !== null} onClick={() => setConfirmingSelf(false)}>
                        Cancel
                      </InfoAction>
                      <InfoAction id={id} danger aria-label="Confirm sign out" disabled={busy !== null} onClick={() => signOut(session)}>
                        {busy === `exit:${session.id}` && <Loader2 className="size-3.5" aria-hidden="true" />}Sign out
                      </InfoAction>
                    </>
                  ) : (
                    <InfoAction
                      id={id}
                      aria-label={`Sign out ${name}`}
                      disabled={busy !== null}
                      onClick={() => (session.current ? setConfirmingSelf(true) : signOut(session))}
                    >
                      {busy === `exit:${session.id}` && <Loader2 className="size-3.5" aria-hidden="true" />}Sign out
                    </InfoAction>
                  )}
                </span>
              )}
            </SettingsRow>
          );
        })}
        <SettingsRow label="All browsers" error={allError}>
          {(id) => (
            <InfoAction
              id={id}
              danger
              aria-label={confirmingAll ? "Confirm sign out all" : "Sign out all"}
              disabled={busy !== null}
              onClick={() => (confirmingAll ? signOutAll() : setConfirmingAll(true))}
              onBlur={() => setConfirmingAll(false)}
            >
              {busy === "all" && <Loader2 className="size-3.5" aria-hidden="true" />}
              {confirmingAll ? "Confirm sign out all" : "Sign out all"}
            </InfoAction>
          )}
        </SettingsRow>
      </CollapsibleGroup>
      </SettingsGroup>
    </>
  );
}
