import { Loader2 } from "../../ui/icons.ts";
import { useMemo, useState } from "react";
import type { BrowserSessionInfo } from "../../../shared/index.ts";
import { describeUserAgent, formatAgo, userAgentDevice } from "../../browser-sessions.ts";
import { platformIcon } from "../../components/DeviceBadges.tsx";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { useBrowserSessions } from "../../settings-model.ts";
import { ConfirmBody, SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";
import { SettingsNavRow } from "./SettingsNavRow.tsx";

function KindIcon({ userAgent }: { userAgent: string }) {
  const Icon = platformIcon(userAgentDevice(userAgent));
  return <Icon aria-hidden="true" />;
}

const byRecency = (a: BrowserSessionInfo, b: BrowserSessionInfo) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt;

export function BrowsersPage({ onSignedOut }: { onSignedOut?: () => void }) {
  const { sessions, loadError, rowErrors, allError, busy, signOutAsync, signOutAllAsync } = useBrowserSessions(
    onSignedOut !== undefined ? { onSignedOut } : {},
  );
  const confirm = useDrawerTarget<BrowserSessionInfo>();
  const [allOpen, setAllOpen] = useState(false);
  const now = Date.now();
  const active = useMemo(() => sessions?.toSorted(byRecency) ?? [], [sessions]);
  const target = confirm.target;
  const targetName = target === null ? "" : describeUserAgent(target.userAgent);

  return (
    <>
      <SettingsGroup label="Signed-in browsers">
        {sessions === null && loadError === null && (
          <div className="flex min-h-12 items-center justify-center">
            <Loader2 className="size-pixel text-muted-foreground" aria-label="Loading" />
          </div>
        )}
        {loadError !== null && (
          <div className="px-4 py-3">
            <RowError error={loadError} />
          </div>
        )}
        {active.map((session) => (
          <SettingsNavRow
            key={session.id}
            icon={<KindIcon userAgent={session.userAgent} />}
            label={describeUserAgent(session.userAgent)}
            detail={
              <span className="flex flex-wrap items-center gap-x-3">
                {session.current && <span>This browser</span>}
                <span>{formatAgo(session.lastSeenAt, now)}</span>
              </span>
            }
            onClick={() => confirm.show(session)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup label="Sign out all browsers">
        <SettingsNavRow danger label="Sign out all browsers…" onClick={() => setAllOpen(true)} />
      </SettingsGroup>

      <SettingsDrawer open={confirm.open} onOpenChange={confirm.onOpenChange} title={target?.current ? "Sign out this browser" : `Sign out ${targetName}`}>
        {target !== null && (
          <ConfirmBody
            description={target.current ? "You'll need a new sign-in link to get back in on this device" : `${targetName} will need a new sign-in link to get back in`}
            confirmLabel={target.current ? "Sign out this browser" : "Sign out"}
            busy={busy === `exit:${target.id}`}
            error={rowErrors[target.id]}
            onConfirm={() => void signOutAsync(target).then(confirm.close, () => {})}
            onCancel={confirm.close}
          />
        )}
      </SettingsDrawer>
      <SettingsDrawer open={allOpen} onOpenChange={setAllOpen} title="Sign out all browsers">
        <ConfirmBody
          description="Changes the master key and signs out every browser, including this one"
          confirmLabel="Sign out all browsers"
          busy={busy === "all"}
          error={allError}
          onConfirm={() => void signOutAllAsync().catch(() => {})}
          onCancel={() => setAllOpen(false)}
        />
      </SettingsDrawer>
    </>
  );
}
