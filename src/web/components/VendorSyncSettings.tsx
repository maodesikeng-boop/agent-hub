// 全局设置 → 通用 → 跨厂商连接器、MCP 与技能并集同步入口及预览确认弹窗（docs/ui-standard.md 第 10 条）。
// 完全由接口返回的数据驱动渲染，零硬编码单家厂商分支、零符号拼接（不用 · / | / /）。
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import type {
  VendorSyncApplyResponse,
  VendorSyncItemVendorStatus,
  VendorSyncPreviewResponse,
  VendorSyncVendorBadge,
} from "../../shared/index.ts";
import { useClient } from "../device-scope.tsx";
import { errorText, type ErrorLike } from "../format.ts";
import { useHubQueryClient } from "../query-client.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Switch } from "../ui/switch.tsx";
import { ReadonlyValue, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

const VENDOR_STATUS_LABELS: Readonly<Record<VendorSyncItemVendorStatus, string>> = {
  present: "Synced",
  will_add: "Add",
  kept: "Kept existing",
  mcp_remote: "mcp-remote",
  native: "Native",
  symlink: "Linked",
  will_link: "Link",
  conflict: "Private preserved",
};

function formatApplySummary(result: VendorSyncApplyResponse): string {
  const parts: string[] = [];
  if (result.syncedMcpCount > 0) parts.push(`${result.syncedMcpCount} MCP synced`);
  if (result.removedMcpCount > 0) parts.push(`${result.removedMcpCount} MCP removed`);
  if (result.linkedSkillCount > 0) parts.push(`${result.linkedSkillCount} skills linked`);
  if (result.unlinkedSkillCount > 0) parts.push(`${result.unlinkedSkillCount} skills unlinked`);
  if (result.preservedPrivateSkillCount > 0) parts.push(`${result.preservedPrivateSkillCount} private skills kept`);
  if (parts.length === 0) return "All providers are already up to date";
  return parts.join(", ");
}

function VendorBadges({ badges }: { badges: readonly VendorSyncVendorBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {badges.map((badge) => (
        <span
          key={badge.vendor}
          className="inline-flex items-center gap-1.5 rounded-full bg-sidebar px-2.5 py-0.5 text-xs text-muted-foreground"
        >
          <span className="font-medium text-foreground/80">{badge.label}</span>
          <span>{VENDOR_STATUS_LABELS[badge.status]}</span>
        </span>
      ))}
    </span>
  );
}

export function VendorSyncSettings() {
  const qc = useHubQueryClient();
  const client = useClient();
  const [preview, setPreview] = useState<VendorSyncPreviewResponse | null>(null);
  const [checkedMcp, setCheckedMcp] = useState<ReadonlySet<string>>(() => new Set());
  const [checkedSkills, setCheckedSkills] = useState<ReadonlySet<string>>(() => new Set());
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const scanMutation = useMutation(
    {
      mutationFn: () => client.fetchVendorSyncPreview(),
      onSuccess: (data) => {
        setCheckedMcp(new Set(data.mcpServers.map((item) => item.key)));
        setCheckedSkills(new Set(data.skills.map((item) => item.key)));
        applyMutation.reset();
        setPreview(data);
      },
    },
    qc,
  );

  const applyMutation = useMutation(
    {
      mutationFn: () => {
        if (!preview) throw new Error("No preview loaded");
        const selectedMcpKeys: string[] = [];
        const removeMcpKeys: string[] = [];
        for (const item of preview.mcpServers) {
          if (checkedMcp.has(item.key)) {
            selectedMcpKeys.push(item.key);
          } else {
            removeMcpKeys.push(item.key);
          }
        }
        const selectedSkillKeys: string[] = [];
        const removeSkillKeys: string[] = [];
        for (const item of preview.skills) {
          if (checkedSkills.has(item.key)) {
            selectedSkillKeys.push(item.key);
          } else {
            removeSkillKeys.push(item.key);
          }
        }
        return client.postVendorSyncApply({
          selectedMcpKeys,
          removeMcpKeys,
          selectedSkillKeys,
          removeSkillKeys,
        });
      },
      onSuccess: (result) => {
        setLastSummary(formatApplySummary(result));
        setPreview(null);
      },
    },
    qc,
  );

  const scanError: ErrorLike | null = scanMutation.error ? errorText(scanMutation.error) : null;
  const applyError: ErrorLike | null = applyMutation.error ? errorText(applyMutation.error) : null;

  const toggleMcp = (key: string, nextChecked: boolean) => {
    setCheckedMcp((prev) => {
      const next = new Set(prev);
      if (nextChecked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleSkill = (key: string, nextChecked: boolean) => {
    setCheckedSkills((prev) => {
      const next = new Set(prev);
      if (nextChecked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const hasSyncableItems = preview !== null && (preview.mcpServers.length > 0 || preview.skills.length > 0);
  const isEmptyPreview =
    preview !== null &&
    preview.mcpServers.length === 0 &&
    preview.skills.length === 0 &&
    preview.nonSyncable.length === 0;

  return (
    <>
      <SettingsGroup title="Integrations">
        <SettingsRow
          label="Vendor sync"
          detail={lastSummary ?? "Merge MCP servers and skills across installed providers"}
          error={scanError}
        >
          {(id) => (
            <Button
              id={id}
              variant="outline"
              size="sm"
              aria-label={scanMutation.isPending ? "Scanning…" : "Scan…"}
              disabled={scanMutation.isPending}
              onClick={() => scanMutation.mutate()}
            >
              {scanMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {scanMutation.isPending ? "Scanning…" : "Scan…"}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !applyMutation.isPending) setPreview(null);
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
                        <span className="rounded-full bg-sidebar px-2 py-0.5 font-mono text-xs text-muted-foreground">
                          {item.transport}
                        </span>
                        <span className="font-mono text-xs break-all">{item.maskedTarget}</span>
                      </div>
                      {item.maskedAuth.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.maskedAuth.map((entry) => (
                            <span
                              key={entry}
                              className="rounded-xl bg-sidebar px-2 py-0.5 font-mono text-xs text-muted-foreground"
                            >
                              {entry}
                            </span>
                          ))}
                        </div>
                      )}
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
                          disabled={applyMutation.isPending}
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
                        <span className="rounded-full bg-sidebar px-2 py-0.5 text-xs text-muted-foreground">
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
                          disabled={applyMutation.isPending}
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
                      <span className="inline-flex w-fit items-center rounded-full bg-sidebar px-2.5 py-0.5 text-xs font-medium text-foreground/80">
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
            <Button
              type="button"
              variant="ghost"
              disabled={applyMutation.isPending}
              onClick={() => setPreview(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={applyMutation.isPending || !hasSyncableItems}
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
