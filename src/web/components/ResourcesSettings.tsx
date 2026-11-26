// Invariant: discard actions always open a confirmation dialog before removing user-owned files, and routine quota denominators stay hidden below RESOURCES_WARN_RATIO.
import { useMemo, useState, type ReactNode } from "react";
import {
  type HeldResourceItem,
  type HeldResourceReason,
  type ResourceCleanupResponse,
  type ResourcesSnapshot,
} from "../../shared/index.ts";
import { LOCAL_DEVICE, type DeviceKey, type DeviceView } from "../devices.ts";
import { shortPath } from "../format.ts";
import { useResourcesModel } from "../resources-model.ts";
import type { DeviceSettings } from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Loader2, RefreshCw } from "../ui/icons.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Switch } from "../ui/switch.tsx";
import { formatBytes } from "../upload.ts";
import { CollapsibleGroup, ReadonlyValue, RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

export interface ResourcesSettingsProps {
  readonly active?: boolean;
  readonly devices?: DeviceSettings | null;
  readonly defaultDeviceKey?: DeviceKey;
  readonly titled?: boolean;
}

const REASON_LABELS: Readonly<Record<HeldResourceReason, string>> = {
  uncommitted_changes: "Unsaved file edits",
  untracked_files: "Untracked files",
  git_op_in_progress: "Git operation paused",
  unmerged_branch: "Unmerged branch",
  probe_failed: "Could not inspect",
  unmerged_ended_branch: "Unmerged branch",
  orphaned_temp_dir: "Leftover temp folder",
  leaked_process: "Leftover background process",
  shared_process: "Possibly shared process",
};

const TABLE_LABELS: Readonly<Record<string, string>> = {
  messages: "Chat messages",
  step_logs: "Activity logs",
  router_items: "Router & decisions",
  router_commands: "Router commands",
  task_graphs: "Task graphs",
  task_nodes: "Task steps",
  workers: "Worker records",
  sessions: "Sessions",
  conversations: "Conversations",
  pms: "Project managers",
  projects: "Projects",
  schedules: "Schedules",
  persona_changes: "Edit history",
  user_blockers: "User blockers",
};

function humanTableName(table: string): string {
  const mapped = TABLE_LABELS[table];
  if (mapped !== undefined) return mapped;
  const spaced = table.replaceAll("_", " ");
  return spaced === "" ? table : spaced[0]!.toUpperCase() + spaced.slice(1);
}

function humanDirectoryLabel(dir: { id: string; label: string }): string {
  return dir.id === "worktrees" ? "Worker workspaces" : dir.label;
}

function discardDialogTitle(item: HeldResourceItem): string {
  if (item.kind === "worktree") return "Delete workspace?";
  if (item.kind === "git_branch") return "Delete branch?";
  if (item.kind === "temp_dir") return "Delete temp folder?";
  return "Stop process?";
}

function discardTargetPath(item: HeldResourceItem): string {
  if (item.kind === "worktree") return shortPath(item.worktreePath);
  if (item.kind === "git_branch") return `${item.branch} (${shortPath(item.repoFolder)})`;
  if (item.kind === "temp_dir") return shortPath(item.tmpPath);
  return `PID ${item.pid} ${item.command}`.trim();
}

function summarizeCleanup(res: ResourceCleanupResponse): string {
  const parts: string[] = [];
  if (res.purgedDbRows > 0) parts.push(`${res.purgedDbRows} old records`);
  if (res.removedFiles > 0) parts.push(`${res.removedFiles} files`);
  if (res.removedWorktrees > 0) parts.push(`${res.removedWorktrees} workspaces`);
  if (res.removedBranches > 0) parts.push(`${res.removedBranches} branches`);
  if (res.removedTempDirs > 0) parts.push(`${res.removedTempDirs} temp folders`);
  if (res.reapedProcesses > 0) parts.push(`${res.reapedProcesses} processes`);
  return parts.length === 0 ? "Nothing to clean" : `Cleaned ${parts.join(", ")}`;
}

function selectableOnlineComputers(devices: readonly DeviceView[] | null): readonly DeviceView[] {
  if (devices === null || devices.length <= 1) return [];
  return devices.filter((d) => d.info.self || d.status === "online");
}

function HeldItemRow({
  item,
  kept,
  busy,
  onKeep,
  onUnkeep,
  onDiscardClick,
}: {
  item: HeldResourceItem;
  kept: boolean;
  busy: boolean;
  onKeep: () => void;
  onUnkeep: () => void;
  onDiscardClick: () => void;
}) {
  const detail = (
    <div className="grid grid-cols-1 gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {!kept && <span aria-hidden="true" className="size-2 rounded-full shrink-0 bg-caution" />}
          <span>{REASON_LABELS[item.reason]}</span>
        </span>
        {item.projectName && <span>{item.projectName}</span>}
        {item.bytes !== null && <span>{formatBytes(item.bytes)}</span>}
        {item.kind === "git_branch" && item.commitsAhead !== null && (
          <span>{item.commitsAhead === 1 ? "1 commit ahead" : `${item.commitsAhead} commits ahead`}</span>
        )}
      </div>
      {item.samplePaths.length > 0 && (
        <div className="truncate font-mono text-xs text-muted-foreground" title={item.samplePaths.join("\n")}>
          {item.samplePaths.join(", ")}
          {item.kind === "worktree" && item.dirtyCount > item.samplePaths.length
            ? ` +${item.dirtyCount - item.samplePaths.length} more`
            : ""}
        </div>
      )}
    </div>
  );

  return (
    <SettingsRow label={item.label} detail={detail}>
      {() => (
        <span className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={kept ? onUnkeep : onKeep}
          >
            {busy && <Loader2 aria-hidden="true" />}
            {kept ? "Allow cleanup" : "Keep"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            className="text-danger hover:text-danger"
            onClick={onDiscardClick}
          >
            {item.kind === "process" ? "Stop…" : "Delete…"}
          </Button>
        </span>
      )}
    </SettingsRow>
  );
}

function OverviewGroup({
  snapshot,
  refreshing,
  cleaning,
  lastCleanup,
  onRefresh,
  onRunCleanup,
}: {
  snapshot: ResourcesSnapshot;
  refreshing: boolean;
  cleaning: boolean;
  lastCleanup: ResourceCleanupResponse | null;
  onRefresh: () => void;
  onRunCleanup: () => void;
}) {
  const dbBytes = snapshot.database.fileBytes + snapshot.database.walBytes;
  const dbWarnTable = snapshot.database.tables.find((t) => t.warning);
  const storageBytes = snapshot.directories.reduce((sum, d) => sum + d.bytes, 0);
  const storageWarn = snapshot.directories.find((d) => d.warning);
  const activeBranches = snapshot.branches.reduce((sum, r) => sum + r.activeCount, 0);
  const cleanableBranches = snapshot.branches.reduce((sum, r) => sum + r.mergedCleanableCount, 0);
  const heldBranches = snapshot.branches.reduce((sum, r) => sum + r.unmergedHeldCount, 0);
  const heldWorktrees = snapshot.held.filter((h) => h.kind === "worktree").length;

  const workspaceSummaryParts: string[] = [];
  if (activeBranches > 0) workspaceSummaryParts.push(`${activeBranches} active`);
  if (cleanableBranches > 0) workspaceSummaryParts.push(`${cleanableBranches} ready to clean`);
  if (heldWorktrees + heldBranches > 0) workspaceSummaryParts.push(`${heldWorktrees + heldBranches} to review`);

  const dbDetail = dbWarnTable ? (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span aria-hidden="true" className="size-2 rounded-full shrink-0 bg-caution" />
      <span>{`${humanTableName(dbWarnTable.table)} ${dbWarnTable.rows.toLocaleString("en-US")} / ${dbWarnTable.rowLimit?.toLocaleString("en-US")}`}</span>
    </span>
  ) : snapshot.database.freelistBytes >= 1024 * 1024 ? (
    <span className="tabular-nums">{`${formatBytes(snapshot.database.freelistBytes)} freeable`}</span>
  ) : undefined;

  const storageDetail = storageWarn ? (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span aria-hidden="true" className="size-2 rounded-full shrink-0 bg-caution" />
      <span>
        {storageWarn.maxBytes !== null
          ? `${humanDirectoryLabel(storageWarn)} ${formatBytes(storageWarn.bytes)} / ${formatBytes(storageWarn.maxBytes)}`
          : `${humanDirectoryLabel(storageWarn)} ${storageWarn.fileCount} / ${storageWarn.maxFiles} files`}
      </span>
    </span>
  ) : undefined;

  const actionBar = (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={refreshing || cleaning} onClick={onRefresh}>
        {refreshing ? <Loader2 aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        Refresh
      </Button>
      <Button variant="outline" size="sm" disabled={cleaning || refreshing} onClick={onRunCleanup}>
        {cleaning && <Loader2 aria-hidden="true" />}
        Clean up
      </Button>
    </div>
  );

  return (
    <SettingsGroup title="Summary" action={actionBar}>
      <SettingsRow label="Chat & app data" detail={dbDetail}>
        {(id) => <ReadonlyValue id={id}><span className="tabular-nums">{formatBytes(dbBytes)}</span></ReadonlyValue>}
      </SettingsRow>
      <SettingsRow label="Files & workspaces" detail={storageDetail}>
        {(id) => <ReadonlyValue id={id}><span className="tabular-nums">{formatBytes(storageBytes)}</span></ReadonlyValue>}
      </SettingsRow>
      <SettingsRow label="Worker workspaces">
        {(id) => (
          <ReadonlyValue id={id}>
            <span className="inline-flex flex-wrap items-center justify-end gap-x-3 tabular-nums">
              {workspaceSummaryParts.length === 0 ? (
                <span>None</span>
              ) : (
                workspaceSummaryParts.map((part) => <span key={part}>{part}</span>)
              )}
            </span>
          </ReadonlyValue>
        )}
      </SettingsRow>
      <SettingsRow label="Background processes">
        {(id) => (
          <ReadonlyValue id={id}>
            <span className="inline-flex items-center gap-3 tabular-nums">
              <span>{`${snapshot.processes.trackedCount} running`}</span>
              {snapshot.processes.leakedCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <span aria-hidden="true" className="size-2 rounded-full bg-caution" />
                  <span>{`${snapshot.processes.leakedCount} leftover`}</span>
                </span>
              )}
            </span>
          </ReadonlyValue>
        )}
      </SettingsRow>
      {lastCleanup !== null && (
        <div className="px-4 py-2.5 text-minor text-muted-foreground tabular-nums">
          {summarizeCleanup(lastCleanup)}
        </div>
      )}
    </SettingsGroup>
  );
}

function StorageDetailsGroup({ snapshot }: { snapshot: ResourcesSnapshot }) {
  const topTables = snapshot.database.tables.filter((t) => t.rows > 0 || (t.bytes ?? 0) > 0).slice(0, 8);
  return (
    <CollapsibleGroup title="Storage breakdown" summary={formatBytes(snapshot.totalDiskBytes)}>
      {snapshot.directories.map((dir) => (
        <SettingsRow
          key={dir.id}
          label={humanDirectoryLabel(dir)}
          detail={
            dir.warning ? (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <span aria-hidden="true" className="size-2 rounded-full shrink-0 bg-caution" />
                <span>
                  {dir.maxBytes !== null
                    ? `${formatBytes(dir.bytes)} / ${formatBytes(dir.maxBytes)}`
                    : `${dir.fileCount} / ${dir.maxFiles} files`}
                </span>
              </span>
            ) : dir.fileCount > 0 ? (
              <span className="tabular-nums">{dir.fileCount === 1 ? "1 file" : `${dir.fileCount.toLocaleString("en-US")} files`}</span>
            ) : undefined
          }
        >
          {(id) => (
            <ReadonlyValue id={id}>
              <span className="tabular-nums">{dir.truncated ? `${formatBytes(dir.bytes)}+` : formatBytes(dir.bytes)}</span>
            </ReadonlyValue>
          )}
        </SettingsRow>
      ))}
      {topTables.map((table) => (
        <SettingsRow
          key={table.table}
          label={humanTableName(table.table)}
          detail={
            <span className="tabular-nums">
              {table.warning && table.rowLimit !== null
                ? `${table.rows.toLocaleString("en-US")} / ${table.rowLimit.toLocaleString("en-US")} records`
                : `${table.rows.toLocaleString("en-US")} records`}
            </span>
          }
        >
          {(id) => (
            <ReadonlyValue id={id}>
              <span className="tabular-nums">{table.bytes === null ? "—" : formatBytes(table.bytes)}</span>
            </ReadonlyValue>
          )}
        </SettingsRow>
      ))}
    </CollapsibleGroup>
  );
}

function DiscardConfirmDialog({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: HeldResourceItem | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (deleteBranch: boolean) => void;
}) {
  const [deleteBranch, setDeleteBranch] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open && !busy) {
      setDeleteBranch(false);
      onClose();
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        title={item ? discardDialogTitle(item) : "Delete item?"}
        className="max-w-110"
      >
        {item !== null && (
          <div className="grid grid-cols-1 gap-4">
            <div className="grid grid-cols-1 gap-1.5">
              <p className="text-body font-medium">{item.label}</p>
              <p className="font-mono text-xs break-all text-muted-foreground">{discardTargetPath(item)}</p>
              <div className="flex flex-wrap items-center gap-x-3 text-minor text-muted-foreground tabular-nums">
                <span>{REASON_LABELS[item.reason]}</span>
                {item.bytes !== null && <span>{formatBytes(item.bytes)}</span>}
              </div>
              {item.samplePaths.length > 0 && (
                <p className="rounded-sm bg-panel px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground">
                  {item.samplePaths.join("\n")}
                </p>
              )}
            </div>
            {item.kind === "worktree" && item.branch !== null && (
              <div className="rounded-sm border border-border">
                <SettingsRow label={`Also delete branch ${item.branch}`}>
                  {(id) => (
                    <Switch
                      id={id}
                      aria-label={`Also delete branch ${item.branch}`}
                      checked={deleteBranch}
                      disabled={busy}
                      onCheckedChange={setDeleteBranch}
                    />
                  )}
                </SettingsRow>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => onConfirm(item.kind === "worktree" && deleteBranch)}
              >
                {busy && <Loader2 aria-hidden="true" />}
                {item.kind === "process" ? "Stop process" : "Delete"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Precondition: rendered inside SettingsDialog (desktop) or ResourcesPage (mobile).
 * Postcondition: renders Needs review items (Keep / Delete or Stop), Summary totals, Storage breakdown, and collapsed Kept rows.
 */
export function ResourcesSettings({
  active = true,
  devices = null,
  defaultDeviceKey = LOCAL_DEVICE,
}: ResourcesSettingsProps): ReactNode {
  const computers = useMemo(() => selectableOnlineComputers(devices?.devices ?? null), [devices]);
  const [selectedDeviceKey, setSelectedDeviceKey] = useState<DeviceKey>(defaultDeviceKey);
  const effectiveDeviceKey =
    computers.length > 0
      ? computers.some((c) => c.key === selectedDeviceKey)
        ? selectedDeviceKey
        : LOCAL_DEVICE
      : undefined;

  const model = useResourcesModel({ deviceKey: effectiveDeviceKey, enabled: active });
  const [pendingDiscard, setPendingDiscard] = useState<HeldResourceItem | null>(null);

  const handleConfirmDiscard = async (deleteBranch: boolean) => {
    if (pendingDiscard === null) return;
    const res = await model.decide({
      kind: pendingDiscard.kind,
      targetKey: pendingDiscard.targetKey,
      action: "discard",
      ...(deleteBranch ? { deleteBranch: true } : {}),
    });
    if (res !== null) setPendingDiscard(null);
  };

  return (
    <>
      {computers.length > 1 && (
        <SettingsGroup label="Computer">
          <SettingsRow label="Computer">
            {(id) => (
              <Select value={effectiveDeviceKey ?? LOCAL_DEVICE} onValueChange={(next) => setSelectedDeviceKey(next as DeviceKey)}>
                <SelectTrigger id={id} aria-label="Computer" variant="plain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {computers.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.info.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}

      {model.loading && (
        <div className="flex min-h-24 items-center justify-center">
          <Loader2 className="size-pixel text-muted-foreground" aria-label="Loading" />
        </div>
      )}

      {model.loadError !== null && (
        <SettingsGroup label="Resources error">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <RowError error={model.loadError} />
            <Button variant="outline" size="sm" onClick={model.refresh}>
              Retry
            </Button>
          </div>
        </SettingsGroup>
      )}

      {model.actionError !== null && (
        <div className="px-4">
          <RowError error={model.actionError} />
        </div>
      )}

      {model.snapshot !== null && (
        <>
          {model.partitioned.needsDecision.length > 0 && (
            <SettingsGroup title="Needs review">
              {model.partitioned.needsDecision.map((item) => {
                const key = `${item.kind}:${item.targetKey}`;
                return (
                  <HeldItemRow
                    key={key}
                    item={item}
                    kept={false}
                    busy={model.decidingKey === key}
                    onKeep={() => void model.decide({ kind: item.kind, targetKey: item.targetKey, action: "keep" })}
                    onUnkeep={() => void model.decide({ kind: item.kind, targetKey: item.targetKey, action: "unkeep" })}
                    onDiscardClick={() => setPendingDiscard(item)}
                  />
                );
              })}
            </SettingsGroup>
          )}

          <OverviewGroup
            snapshot={model.snapshot}
            refreshing={model.refreshing}
            cleaning={model.cleaning}
            lastCleanup={model.lastCleanup}
            onRefresh={model.refresh}
            onRunCleanup={model.runCleanup}
          />

          <StorageDetailsGroup snapshot={model.snapshot} />

          {model.partitioned.kept.length > 0 && (
            <CollapsibleGroup
              title="Kept"
              summary={String(model.partitioned.kept.length)}
              defaultOpen={false}
            >
              {model.partitioned.kept.map((item) => {
                const key = `${item.kind}:${item.targetKey}`;
                return (
                  <HeldItemRow
                    key={key}
                    item={item}
                    kept={true}
                    busy={model.decidingKey === key}
                    onKeep={() => void model.decide({ kind: item.kind, targetKey: item.targetKey, action: "keep" })}
                    onUnkeep={() => void model.decide({ kind: item.kind, targetKey: item.targetKey, action: "unkeep" })}
                    onDiscardClick={() => setPendingDiscard(item)}
                  />
                );
              })}
            </CollapsibleGroup>
          )}
        </>
      )}

      <DiscardConfirmDialog
        item={pendingDiscard}
        busy={pendingDiscard !== null && model.decidingKey === `${pendingDiscard.kind}:${pendingDiscard.targetKey}`}
        onClose={() => setPendingDiscard(null)}
        onConfirm={(deleteBranch) => void handleConfirmDiscard(deleteBranch)}
      />
    </>
  );
}
