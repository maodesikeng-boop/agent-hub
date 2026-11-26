import { Loader2 } from "../ui/icons.ts";
import type { VendorSyncVendorBadge } from "../../shared/index.ts";
import { VENDOR_STATUS_LABELS, visibleMcpVendorBadges, type VendorSyncModel } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { HostBoundNote } from "./HostBoundNote.tsx";
import { ReadonlyValue, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

function VendorBadges({ badges }: { badges: readonly VendorSyncVendorBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {badges.map((badge) => (
        <span
          key={badge.vendor}
          className="inline-flex items-center gap-1.5 rounded-xs bg-panel px-2.5 py-0.5 text-xs text-muted-foreground"
        >
          <span className="font-medium text-foreground">{badge.label}</span>
          <span>{VENDOR_STATUS_LABELS[badge.status]}</span>
        </span>
      ))}
    </span>
  );
}

export function VendorSyncSettings({ vendor, showScan }: { vendor: VendorSyncModel; showScan: boolean }) {
  const {
    preview,
    checkedMcp,
    checkedSkills,
    summary,
    scanning,
    applying,
    scanError,
    applyError,
    hasSyncableItems,
    isEmptyPreview,
    previewVendorSync,
    applyVendorSync,
    toggleMcp,
    toggleSkill,
    closePreview,
  } = vendor;

  return (
    <>
      {showScan && <SettingsGroup title="Integrations">
        <SettingsRow label="Vendor sync" detail={summary} error={scanError}>
          {(id) => (
            <Button
              id={id}
              variant="outline"
              size="sm"
              className="min-w-24"
              aria-label={scanning ? "Scanning…" : "Scan…"}
              disabled={scanning}
              onClick={previewVendorSync}
            >
              {scanning && <Loader2 aria-hidden="true" />}
              {scanning ? "Scanning…" : "Scan…"}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>}

      {/* Radix must register the preview after the Settings dialog when columns return. */}
      <Dialog
        key={showScan ? "desktop" : "mobile"}
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogContent title="Sync preview">
          <DialogBody className="grid-cols-1">
            {isEmptyPreview && (
              <p className="text-minor text-muted-foreground">No MCP servers, skills, or cloud connectors found</p>
            )}

            {preview && preview.mcpServers.length > 0 && (
              <SettingsGroup title="MCP servers">
                {preview.mcpServers.map((item) => {
                  const isChecked = checkedMcp.has(item.key);
                  const detail = (
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-xs bg-panel px-2 py-0.5 font-mono text-xs text-muted-foreground">
                          {item.transport}
                        </span>
                        <span className="font-mono text-xs break-all">{item.maskedTarget}</span>
                      </div>
                      {item.maskedAuth.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.maskedAuth.map((entry) => (
                            <span
                              key={entry}
                              className="rounded-xs bg-panel px-2 py-0.5 font-mono text-xs text-muted-foreground"
                            >
                              {entry}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.hostBound && <HostBoundNote hostBound={item.hostBound} />}
                      {!isChecked && !item.hostBound && <span className="text-xs text-danger">Unchecked — will be removed</span>}
                      <VendorBadges badges={visibleMcpVendorBadges(item, isChecked)} />
                    </div>
                  );
                  return (
                    <SettingsRow key={item.key} label={item.name} detail={detail}>
                      {(id) => (
                        <Switch
                          id={id}
                          aria-label={item.name}
                          checked={isChecked}
                          disabled={applying}
                          onCheckedChange={(on) => toggleMcp(item.key, on)}
                        />
                      )}
                    </SettingsRow>
                  );
                })}
              </SettingsGroup>
            )}

            {preview && preview.skills.length > 0 && (
              <SettingsGroup title="Skills">
                {preview.skills.map((item) => {
                  const isChecked = checkedSkills.has(item.key);
                  const detail = (
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-xs bg-panel px-2 py-0.5 text-xs text-muted-foreground">
                          {item.scope === "global" ? "Global" : (item.projectLabel ?? "Project")}
                        </span>
                        <span className="font-mono text-xs break-all">{item.sourcePath}</span>
                      </div>
                      {!isChecked && <span className="text-xs text-danger">Unchecked — will be removed</span>}
                      <VendorBadges badges={item.vendors} />
                    </div>
                  );
                  return (
                    <SettingsRow key={item.key} label={item.name} detail={detail}>
                      {(id) => (
                        <Switch
                          id={id}
                          aria-label={item.name}
                          checked={isChecked}
                          disabled={applying}
                          onCheckedChange={(on) => toggleSkill(item.key, on)}
                        />
                      )}
                    </SettingsRow>
                  );
                })}
              </SettingsGroup>
            )}

            {preview && preview.nonSyncable.length > 0 && (
              <SettingsGroup title="Cloud connectors">
                {preview.nonSyncable.map((item) => {
                  const detail = (
                    <div className="flex flex-col gap-1">
                      <span className="inline-flex w-fit items-center rounded-xs bg-panel px-2.5 py-0.5 text-xs font-medium text-foreground">
                        {item.vendorLabel}
                      </span>
                      <span>{item.reason}</span>
                    </div>
                  );
                  return (
                    <SettingsRow key={item.key} label={item.name} detail={detail}>
                      {(id) => <ReadonlyValue id={id}>Not syncable</ReadonlyValue>}
                    </SettingsRow>
                  );
                })}
              </SettingsGroup>
            )}
          </DialogBody>

          {applyError !== null && (
            <div className="px-4">
              <RowError error={applyError} />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={applying} onClick={closePreview}>
              Cancel
            </Button>
            <Button type="button" disabled={applying || !hasSyncableItems} onClick={applyVendorSync}>
              {applying && <Loader2 aria-hidden="true" />}
              Sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
