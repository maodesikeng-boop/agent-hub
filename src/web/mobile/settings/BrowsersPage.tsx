// #/settings/browsers：进页拉一次已登录浏览器（staleTime 0），整行可点，本机置顶；
// 任何退出（单个、本机、全部）一律拉起底部确认抽屉，红色 destructive 确认才提交（第 6 节决策 6）。
import { Loader2, Monitor, Smartphone, Tablet } from "../../ui/icons.ts";
import { useMemo, useState } from "react";
import type { BrowserSessionInfo } from "../../../shared/index.ts";
import { describeUserAgent, formatAgo, userAgentKind } from "../../browser-sessions.ts";
import { RowError, SettingsGroup } from "../../components/SettingsList.tsx";
import { useBrowserSessions } from "../../settings-model.ts";
import { ConfirmBody, SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";
import { SettingsNavRow } from "./SettingsNavRow.tsx";

const KIND_ICONS = { computer: Monitor, phone: Smartphone, tablet: Tablet } as const;

function KindIcon({ userAgent }: { userAgent: string }) {
  const Icon = KIND_ICONS[userAgentKind(userAgent)];
  return <Icon aria-hidden="true" />;
}

/** 本机置顶，其余按最近活跃排。 */
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
