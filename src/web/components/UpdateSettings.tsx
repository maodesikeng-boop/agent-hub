import type { ReactNode } from "react";
import { PRODUCT_NAME, type UpdateAvailable } from "../../shared/index.ts";
import { Button } from "../ui/button.tsx";
import { Download, ExternalLink, Loader2 } from "../ui/icons.ts";
import {
  INSTALLER_PLATFORM_LABELS,
  dismissUpdate,
  downloadOfferOf,
  updateStatusLine,
  useCheckForUpdates,
  useDismissedUpdate,
  useUpdateStatus,
} from "../update-model.ts";
import { SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const INLINE_ACTION =
  "touch-target inline-flex cursor-pointer items-center gap-1 font-medium text-rail-ink outline-none hover:underline focus-visible:outline-2 focus-visible:outline-border-focus";

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={INLINE_ACTION} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function ReleaseNotes({ href }: { href: string }) {
  return (
    <InlineLink href={href}>
      Release notes
      <ExternalLink className="size-pixel-sm" aria-hidden="true" />
    </InlineLink>
  );
}

function Details({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap items-center gap-x-3">{children}</span>;
}

function DownloadRow({ offer }: { offer: UpdateAvailable }) {
  const dismissed = useDismissedUpdate() === offer.latestVersion;
  const { installer, platformTarget } = offer;
  const platform = platformTarget === "other" ? null : INSTALLER_PLATFORM_LABELS[platformTarget];
  return (
    <SettingsRow
      label={`v${offer.latestVersion} available`}
      detail={
        <Details>
          <ReleaseNotes href={offer.releaseUrl} />
          {installer && <InlineLink href={installer.sha256Url}>SHA-256</InlineLink>}
          {!dismissed && (
            <button type="button" className={INLINE_ACTION} onClick={() => dismissUpdate(offer.latestVersion)}>
              Skip this version
            </button>
          )}
        </Details>
      }
    >
      {() =>
        installer &&
        platform && (
          <Button asChild size="sm">
            <a href={installer.downloadUrl} target="_blank" rel="noreferrer">
              <Download aria-hidden="true" />
              Download for {platform}
            </a>
          </Button>
        )
      }
    </SettingsRow>
  );
}

export function UpdateSettings({ titled = true }: { titled?: boolean }) {
  const { data: status, isError, isFetching } = useUpdateStatus();
  const check = useCheckForUpdates();
  const offer = downloadOfferOf(status);
  const checking = check.isPending || (status === undefined && isFetching);
  const failed = check.isError || (status === undefined && isError);
  const line = failed || offer === null ? updateStatusLine(status, failed) : undefined;
  const notes = offer === null && status !== undefined ? status.releaseUrl : undefined;
  return (
    <SettingsGroup {...(titled ? { title: "Updates" } : { label: "Updates" })}>
      <SettingsRow
        label={status === undefined ? PRODUCT_NAME : `${PRODUCT_NAME} v${status.currentVersion}`}
        badge={status?.installKind === "source" ? <span className="tool-badge shrink-0 px-2 py-0.5 text-xs font-medium">Source</span> : undefined}
        detail={
          line === undefined && notes === undefined ? undefined : (
            <Details>
              {line !== undefined && <span>{line}</span>}
              {notes !== undefined && <ReleaseNotes href={notes} />}
            </Details>
          )
        }
      >
        {() => (
          <Button variant="ghost" size="sm" className="-mr-3" disabled={checking} onClick={() => check.mutate()}>
            {checking && <Loader2 aria-hidden="true" />}
            Check for updates
          </Button>
        )}
      </SettingsRow>
      {offer && <DownloadRow offer={offer} />}
    </SettingsGroup>
  );
}
