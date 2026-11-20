import { ArrowDown, ArrowUp, ExternalLink, Loader2 } from "../ui/icons.ts";
import { useState } from "react";
import type { DeviceId, MeshApprovalView, MeshDeviceView, RelayConnectionState } from "../../shared/index.ts";
import { platformLabel } from "../devices.ts";
import { movePriority, useAccount } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { PlatformIcon } from "./DeviceBadges.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const RELAY_TEXT: Readonly<Record<RelayConnectionState, string>> = {
  connecting: "Connecting to relay…",
  connected: "Connected",
  unreachable: "Relay unreachable",
};

type Account = ReturnType<typeof useAccount>;

function SasCode({ code }: { code: string }) {
  return (
    <span data-testid="sas-code" className="font-mono text-title tabular-nums tracking-widest">
      {code.slice(0, 3)} {code.slice(3)}
    </span>
  );
}

function ApprovalRow({ account, approval, joining }: { account: Account; approval: MeshApprovalView; joining: boolean }) {
  const { device, requestId, sas } = approval;
  const busy = account.busy?.endsWith(`:${requestId}`) ?? false;
  return (
    <SettingsRow
      label={joining ? `Approve on ${device.name}` : device.name}
      icon={<PlatformIcon platform={device.platform} />}
      detail={sas === null ? (joining ? "Waiting for verification" : `${platformLabel(device.platform)} wants to join`) : platformLabel(device.platform)}
    >
      {() =>
        sas === null ? (
          joining ? null : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void account.beginApproval(requestId)}>
              {busy && <Loader2 aria-hidden="true" />}
              Verify
            </Button>
          )
        ) : (
          <span className="flex flex-wrap items-center justify-end gap-2 pointer-coarse:gap-y-3.5">
            <SasCode code={sas} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void account.answerApproval(requestId, false)}>
              Doesn't match
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void account.answerApproval(requestId, true)}>
              Match
            </Button>
          </span>
        )
      }
    </SettingsRow>
  );
}

function SignInRow({ account, lastError }: { account: Account; lastError: string | null }) {
  const [relayUrl, setRelayUrl] = useState("");
  const [custom, setCustom] = useState(false);
  return (
    <>
      <SettingsRow label="GitHub" error={account.error ?? lastError}>
        {() => (
          <span className="flex flex-wrap items-center justify-end gap-2 pointer-coarse:gap-y-3.5">
            <Button size="sm" variant="ghost" onClick={() => setCustom((v) => !v)}>
              Relay…
            </Button>
            <Button size="sm" disabled={account.busy !== null} onClick={() => void account.signIn(custom && relayUrl.trim() !== "" ? relayUrl.trim() : undefined)}>
              {account.busy === "login" && <Loader2 aria-hidden="true" />}
              Sign in with GitHub
            </Button>
          </span>
        )}
      </SettingsRow>
      {custom && (
        <SettingsRow label="Relay URL" wide>
          {(id) => (
            <Input
              id={id}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={relayUrl}
              placeholder="https://relay.example.com"
              className="sm:w-64"
              onChange={(e) => setRelayUrl(e.target.value)}
            />
          )}
        </SettingsRow>
      )}
    </>
  );
}

function PriorityGroup({
  account,
  priority,
  devices,
  holder,
}: {
  account: Account;
  priority: readonly DeviceId[];
  devices: ReadonlyMap<DeviceId, MeshDeviceView>;
  holder: DeviceId | null;
}) {
  const busy = account.busy === "priority";
  return (
    <SettingsGroup title="Hub order">
      {priority.length === 0 ? (
        <p className="px-4 py-3 text-body text-muted-foreground">No computer can host the Feishu bot</p>
      ) : (
        priority.map((id, index) => {
          const device = devices.get(id);
          const name = device?.name ?? id.slice(0, 8);
          const detail = id === holder ? "Hosting the Feishu bot now" : device?.online === false ? "Offline" : undefined;
          return (
            <SettingsRow key={id} label={`${index + 1}. ${name}`} detail={detail}>
              {() => (
                <span className="-mr-2 flex items-center gap-1 pointer-coarse:gap-3.5">
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${name} up`} disabled={busy || index === 0} onClick={() => void account.setPriority(movePriority(priority, id, -1))}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${name} down`}
                    disabled={busy || index === priority.length - 1}
                    onClick={() => void account.setPriority(movePriority(priority, id, 1))}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </span>
              )}
            </SettingsRow>
          );
        })
      )}
    </SettingsGroup>
  );
}

export function AccountSettings() {
  const account = useAccount();
  const { status } = account;
  if (status === null) {
    return account.loadError === null ? null : (
      <SettingsGroup title="Account">
        <div className="px-4 py-3">
          <RowError error={account.loadError} />
        </div>
      </SettingsGroup>
    );
  }
  if (status.state === "signed_out") {
    return (
      <SettingsGroup title="Account">
        <SignInRow account={account} lastError={status.lastError} />
      </SettingsGroup>
    );
  }
  if (status.state === "signing_in") {
    return (
      <SettingsGroup title="Account">
        <SettingsRow
          label={`Enter ${status.userCode} on GitHub`}
          detail={
            <a className="inline-flex items-center gap-1 underline" href={status.verificationUri} target="_blank" rel="noreferrer">
              {status.verificationUri}
              <ExternalLink className="size-pixel-sm" aria-hidden="true" />
            </a>
          }
          error={account.error}
        >
          {() => (
            <Button size="sm" variant="outline" disabled={account.busy !== null} onClick={() => void account.cancelSignIn()}>
              Cancel
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
    );
  }
  if (status.state === "awaiting_approval") {
    return (
      <SettingsGroup title="Account">
        <SettingsRow
          label={status.login.login}
          detail={
            <span className="flex flex-wrap items-center gap-x-3">
              <span>Waiting for approval</span>
              <span>{RELAY_TEXT[status.relay]}</span>
            </span>
          }
          error={account.error}
        >
          {() => (
            <Button size="sm" variant="outline" disabled={account.busy !== null} onClick={() => void account.signOut()}>
              Sign out
            </Button>
          )}
        </SettingsRow>
        {status.approval !== null && <ApprovalRow account={account} approval={status.approval} joining />}
      </SettingsGroup>
    );
  }
  const devicesById = new Map(status.devices.map((d) => [d.id, d]));
  return (
    <>
      <SettingsGroup title="Account">
        <SettingsRow label={status.login.login} detail={RELAY_TEXT[status.relay]} error={account.error}>
          {() => (
            <Button size="sm" variant="outline" disabled={account.busy !== null} onClick={() => void account.signOut()}>
              {account.busy === "logout" && <Loader2 aria-hidden="true" />}
              Sign out
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
      {status.approvals.length > 0 && (
        <SettingsGroup title="Waiting to join">
          {status.approvals.map((approval) => (
            <ApprovalRow key={approval.requestId} account={account} approval={approval} joining={false} />
          ))}
        </SettingsGroup>
      )}
      <PriorityGroup account={account} priority={status.centerPriority} devices={devicesById} holder={status.feishuHolder} />
    </>
  );
}
