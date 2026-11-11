// #/settings/vendor-sync：跨厂商 MCP 与技能并集同步（对齐桌面 VendorSyncSettings，状态与请求全来自 settings-model.ts 的 useVendorSyncSetting）。
// 手机上不再套一层桌面 Dialog：Scan… 之后直接在页里分组预览（MCP servers / Skills / Cloud connectors），整行开关勾选，底部固定全宽 Sync 一键应用。
// 完全由接口数据驱动，不写死厂商名，不用 · | / 拼接。
import { Loader2 } from "lucide-react";
import type { VendorSyncVendorBadge } from "../../../shared/index.ts";
import { ReadonlyValue, RowError, SettingsGroup, SettingsRow } from "../../components/SettingsList.tsx";
import { VENDOR_STATUS_LABELS, type useVendorSyncSetting } from "../../settings-model.ts";
import { Button } from "../../ui/button.tsx";
import { DRAWER_BUTTON } from "./SettingsDrawer.tsx";
import { SwitchRow } from "./SettingsNavRow.tsx";

export type VendorSync = ReturnType<typeof useVendorSyncSetting>;

const CHIP = "rounded-full bg-sidebar px-2 py-0.5 text-xs text-muted-foreground";

function VendorBadges({ badges }: { badges: readonly VendorSyncVendorBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {badges.map((badge) => (
        <span key={badge.vendor} className="inline-flex items-center gap-1.5 rounded-full bg-sidebar px-2.5 py-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{badge.label}</span>
          <span>{VENDOR_STATUS_LABELS[badge.status]}</span>
        </span>
      ))}
    </span>
  );
}

const Removed = () => <span className="text-xs text-danger">Unchecked — will be removed</span>;

export function VendorSyncPage({ vendor }: { vendor: VendorSync }) {
  const { preview, checkedMcp, checkedSkills, summary, scanning, applying, scanError, isEmptyPreview, previewVendorSync, toggleMcp, toggleSkill } = vendor;
  return (
    <>
      <SettingsGroup label="Vendor sync">
        <div className="grid grid-cols-1 gap-3 px-4 py-4">
          <p className="text-minor leading-snug text-muted-foreground">{summary}</p>
          <Button variant={preview === null ? "default" : "outline"} className={DRAWER_BUTTON} disabled={scanning || applying} onClick={previewVendorSync}>
            {scanning && <Loader2 className="animate-spin" aria-hidden="true" />}
            {scanning ? "Scanning…" : "Scan…"}
          </Button>
          {scanError && <RowError error={scanError} />}
        </div>
      </SettingsGroup>

      {isEmptyPreview && <p className="px-4 text-minor text-muted-foreground">No MCP servers, skills, or cloud connectors found</p>}

      {preview && preview.mcpServers.length > 0 && (
        <SettingsGroup title="MCP servers">
          {preview.mcpServers.map((item) => {
            const checked = checkedMcp.has(item.key);
            return (
              <SwitchRow
                key={item.key}
                label={item.name}
                checked={checked}
                disabled={applying}
                onCheckedChange={(on) => toggleMcp(item.key, on)}
                detail={
                  <span className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`${CHIP} font-mono`}>{item.transport}</span>
                      <span className="font-mono text-xs break-all">{item.maskedTarget}</span>
                    </span>
                    {item.maskedAuth.length > 0 && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {item.maskedAuth.map((entry) => (
                          <span key={entry} className={`${CHIP} font-mono`}>
                            {entry}
                          </span>
                        ))}
                      </span>
                    )}
                    {!checked && <Removed />}
                    <VendorBadges badges={item.vendors} />
                  </span>
                }
              />
            );
          })}
        </SettingsGroup>
      )}

      {preview && preview.skills.length > 0 && (
        <SettingsGroup title="Skills">
          {preview.skills.map((item) => {
            const checked = checkedSkills.has(item.key);
            return (
              <SwitchRow
                key={item.key}
                label={item.name}
                checked={checked}
                disabled={applying}
                onCheckedChange={(on) => toggleSkill(item.key, on)}
                detail={
                  <span className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={CHIP}>{item.scope === "global" ? "Global" : (item.projectLabel ?? "Project")}</span>
                      <span className="font-mono text-xs break-all">{item.sourcePath}</span>
                    </span>
                    {!checked && <Removed />}
                    <VendorBadges badges={item.vendors} />
                  </span>
                }
              />
            );
          })}
        </SettingsGroup>
      )}

      {preview && preview.nonSyncable.length > 0 && (
        <SettingsGroup title="Cloud connectors">
          {preview.nonSyncable.map((item) => (
            <SettingsRow
              key={item.key}
              label={item.name}
              detail={
                <span className="flex flex-col gap-1">
                  <span className="inline-flex w-fit items-center rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium text-foreground/80">{item.vendorLabel}</span>
                  <span>{item.reason}</span>
                </span>
              }
            >
              {(id) => <ReadonlyValue id={id}>Not syncable</ReadonlyValue>}
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
    </>
  );
}

/** 预览出来后固定在底部的主操作：全宽 Sync（没有可同步的项时灰）。 */
export function VendorSyncFooter({ vendor }: { vendor: VendorSync }) {
  if (vendor.preview === null) return null;
  return (
    <>
      {vendor.applyError && <RowError error={vendor.applyError} />}
      <Button className={DRAWER_BUTTON} disabled={vendor.applying || !vendor.hasSyncableItems} onClick={vendor.applyVendorSync}>
        {vendor.applying && <Loader2 className="animate-spin" aria-hidden="true" />}
        Sync
      </Button>
    </>
  );
}
