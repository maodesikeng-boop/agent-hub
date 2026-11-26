import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import {
  DEFAULT_AGENT_VENDOR,
  MAX_PERSONA_BYTES,
  effortLabel,
  modelShortLabel,
  splitModelEffort,
  utf8Bytes,
  type ModelCatalog,
  type PersonaChange,
  type PersonaView,
  type Pm,
  type PmMode,
  type Project,
  type ProjectFolder,
  type ScheduleRecord,
} from "../../shared/index.ts";
import { resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import { capabilitySections, capabilityTotals, useCapabilitiesView } from "../capabilities-model.ts";
import { useClient } from "../device-scope.tsx";
import { DEFAULT_CHOICE, errorLine, errorText, formatArchiveRemaining, shortPath, type ErrorLike } from "../format.ts";
import { folderBaseName, infoRowsOf, type InfoPage } from "../info-rows.ts";
import { cn } from "../lib/utils.ts";
import { useModelCatalog } from "../models.tsx";
import {
  formatChangeSummary,
  personaLoadHint,
  useAgentEditor,
  useAliveRef,
  useInstantSave,
  usePersona,
  usePersonaText,
} from "../pm-persona.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { ChevronRight, Loader2, Pencil, Pin, PinFilled } from "../ui/icons.ts";
import { Textarea } from "../ui/input.tsx";
import { AgentRows } from "./AgentRows.tsx";
import { Avatar } from "./Avatar.tsx";
import { CapabilitiesPanel } from "./CapabilitiesPanel.tsx";
import { ModeRows } from "./ModeRows.tsx";
import { PmMemoryFilesGroup } from "./PmMemoryFilesGroup.tsx";
import { WorktreeSetupGroup } from "./ProjectGroups.tsx";
import { ScheduleGroup } from "./ScheduleGroup.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { SlimePicker } from "./SlimePicker.tsx";

export interface InfoTabProps {
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  rev: number;
  renewing: boolean;
  /** null shows the summary rows. */
  page: InfoPage | null;
  /** The PM's computer is offline: every edit is disabled. */
  readOnly: boolean;
  onNavigate: (page: InfoPage | null) => void;
  /** After Archive succeeds. */
  onArchived: () => void;
  onTogglePin: (pinned: boolean) => void;
  onManageProviders?: () => void;
  onEditDefaults?: () => void;
}

export function formatModelSummary(persona: Pick<PersonaView, "vendor" | "model" | "effort">, catalog: ModelCatalog): string {
  const split = splitModelEffort(persona.vendor, persona.model, persona.effort, catalog);
  const modelPart =
    split.model === null
      ? catalog.defaultModel !== null
        ? modelShortLabel(persona.vendor, catalog.defaultModel, catalog)
        : DEFAULT_CHOICE
      : modelShortLabel(persona.vendor, split.model, catalog);
  const effortPart = split.effort === null ? null : effortLabel(split.effort, persona.vendor, catalog);
  return effortPart === null ? modelPart : `${modelPart} ${effortPart}`;
}

function LookAvatarButton({ pm, disabled }: { pm: Pm; disabled: boolean }) {
  const client = useClient();
  const saved = resolvePmLook(pm);
  const [preview, setPreview] = useState<{ look: SlimeLook; awaitingEchoFrom: Pm | null } | null>(null);
  const [error, setError] = useState<ErrorLike | null>(null);
  const queued = useRef<{ look: SlimeLook; before: Pm } | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    if (preview?.look === saved && preview.awaitingEchoFrom !== null && pm !== preview.awaitingEchoFrom) {
      setPreview(null);
    }
  }, [preview, saved, pm]);
  const look = preview?.look ?? saved;
  const change = async (next: SlimeLook) => {
    queued.current = { look: next, before: pm };
    setPreview({ look: next, awaitingEchoFrom: null });
    setError(null);
    if (saving.current) return;
    saving.current = true;
    while (queued.current !== null) {
      const { look: pending, before } = queued.current;
      queued.current = null;
      try {
        await client.putPmLook(pm.id, pending);
        if (queued.current === null) setPreview({ look: pending, awaitingEchoFrom: before });
      } catch (err) {
        if (queued.current === null) {
          setPreview(null);
          setError(errorText(err));
        }
      }
    }
    saving.current = false;
  };
  return (
    <SlimePicker look={look} onChange={(next) => void change(next)} error={error}>
      <button
        type="button"
        disabled={disabled}
        aria-label="Change look"
        title="Change look"
        className="info-avatar touch-target shrink-0"
      >
        <Avatar look={look} size={44} />
        <span aria-hidden="true" data-testid="info-avatar-pencil" className="info-avatar-pen">
          <Pencil className="size-2.5" aria-hidden="true" />
        </span>
      </button>
    </SlimePicker>
  );
}

function ArchiveStatusGroup({ pmId, archivedAt, disabled }: { pmId: number; archivedAt: number; disabled: boolean }) {
  const client = useClient();
  const [unarchiving, setUnarchiving] = useState(false);
  const [unarchiveError, setUnarchiveError] = useState<ErrorLike | null>(null);
  const unarchive = async () => {
    setUnarchiving(true);
    setUnarchiveError(null);
    try {
      await client.postUnarchivePm(pmId);
    } catch (err) {
      setUnarchiveError(errorText(err));
    } finally {
      setUnarchiving(false);
    }
  };
  return (
    <div className="pt-4">
      <SettingsGroup label="Archive status">
        <SettingsRow label="Archived" detail={formatArchiveRemaining(archivedAt)} error={unarchiveError}>
          {() => (
            <Button disabled={disabled || unarchiving} onClick={() => void unarchive()}>
              {unarchiving && <Loader2 aria-hidden="true" />}
              {unarchiving ? "Restoring…" : "Restore"}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

function InfoFooterActions({
  pm,
  renewing,
  readOnly,
  switchingVendor,
  onArchived,
}: {
  pm: Pm;
  renewing: boolean;
  readOnly: boolean;
  switchingVendor: boolean;
  onArchived: () => void;
}) {
  const client = useClient();
  const [confirmRenew, setConfirmRenew] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [sendingRenew, setSendingRenew] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<ErrorLike | null>(null);
  const renewBusy = renewing || sendingRenew;

  const doRenew = async () => {
    setConfirmRenew(false);
    setSendingRenew(true);
    setActionError(null);
    try {
      await client.postRenewSession(pm.id);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setSendingRenew(false);
    }
  };

  const doArchive = async () => {
    setConfirmArchive(false);
    setArchiving(true);
    setActionError(null);
    try {
      await client.postArchivePm(pm.id);
      onArchived();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="pt-3">
      <div className="flex flex-wrap items-center gap-4.5">
        <button
          type="button"
          disabled={readOnly || renewBusy || switchingVendor}
          onClick={() => setConfirmRenew(true)}
          className="info-action touch-target"
        >
          {renewBusy && <Loader2 className="size-3.5" aria-hidden="true" />}
          {renewBusy ? "Handing off…" : "New session"}
        </button>
        <button
          type="button"
          disabled={readOnly || archiving}
          onClick={() => setConfirmArchive(true)}
          className="info-action info-action-danger touch-target"
        >
          {archiving && <Loader2 className="size-3.5" aria-hidden="true" />}
          Archive
        </button>
      </div>
      {actionError && (
        <div className="mt-2">
          <RowError error={actionError} />
        </div>
      )}

      <Dialog open={confirmRenew} onOpenChange={setConfirmRenew}>
        <DialogContent title="Start a new session?" className="max-w-110">
          <p>The project manager writes a handoff, then continues in a fresh session. Your chat history stays.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={() => void doRenew()}>New session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent title="Archive project manager?" className="max-w-110">
          <p>Archiving stops the current session, ends unfinished Workers and pauses schedules. You can restore it within 7 days. After that, its chat and internal data are deleted for good. Your project folder stays untouched.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void doArchive()}>
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoSummaryRows({
  pm,
  project,
  folders,
  schedules,
  persona,
  onNavigate,
}: {
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  persona: PersonaView;
  onNavigate: (page: InfoPage) => void;
}) {
  const catalog = useModelCatalog(persona.vendor);
  const archived = pm.archivedAt != null;
  const { data: capsView } = useCapabilitiesView({ kind: "pm", pmId: pm.id }, !archived);
  const modelText = formatModelSummary(persona, catalog);
  const capabilities = capsView === undefined ? null : capabilityTotals(capabilitySections(capsView));
  const groups = infoRowsOf({
    pm,
    persona,
    modelText,
    folders,
    schedules,
    capabilities,
    memoryFiles: persona.memoryFileCount ?? null,
    hasProject: project !== null,
    setupCommand: project?.setupCommand ?? null,
  });

  return (
    <nav aria-label="Project manager settings pages">
      {groups.map((rows, groupIndex) => (
        <div key={groupIndex} data-info-group={groupIndex} className="info-sec">
          {rows.map((row) => (
            <button
              key={row.page}
              type="button"
              aria-label={row.value !== null && row.value !== "" ? `${row.label}, ${row.value}` : row.label}
              onClick={() => onNavigate(row.page)}
              className="info-row h-7.5 pointer-coarse:min-h-11"
            >
              <span className="min-w-0 truncate text-minor text-foreground" title={row.label}>
                {row.label}
              </span>
              <span className="ml-auto flex min-w-0 shrink items-center gap-1.5">
                {row.value !== null && (
                  <span title={row.value} className="info-val max-w-44 truncate text-minor tabular-nums">
                    {row.value}
                  </span>
                )}
                <ChevronRight className="work-row-chevron size-3.5 shrink-0" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function ChangeRow({
  change,
  revertable,
  busy,
  onRevert,
}: {
  change: PersonaChange;
  revertable: boolean;
  busy: boolean;
  onRevert: () => void;
}) {
  const [open, setOpen] = useState(false);
  const catalog = useModelCatalog(change.vendorAfter);
  const { actor, summary, timestamp } = formatChangeSummary(change, catalog);
  const textChanged = change.textBefore !== change.textAfter;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-body break-words">
            <span className="font-medium">{actor}</span> {summary}
            {change.reason && <span>: {change.reason}</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{timestamp}</div>
        </div>
        {revertable && (
          <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={onRevert}>
            Undo
          </Button>
        )}
      </div>
      {textChanged && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group mt-1.5 flex cursor-pointer items-center gap-1 text-minor text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus">
            <ChevronRight className="size-pixel-sm transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            View changes
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid grid-cols-1 gap-2">
            {(["Before", "After"] as const).map((label) => (
              <div key={label} className="min-w-0">
                <div className="mb-1 text-minor font-medium text-muted-foreground">{label}</div>
                <pre className="min-h-10 max-h-60 overflow-auto rounded-sm bg-panel p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {label === "Before" ? change.textBefore : change.textAfter}
                </pre>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}

function PersonaEditor({ persona, readOnly }: { persona: ReturnType<typeof usePersonaText>; readOnly: boolean }) {
  const { savedText, syncKey, textError, busy, save } = persona;
  const [trackedSyncKey, setTrackedSyncKey] = useState(syncKey);
  const [draftText, setDraftText] = useState<string | null>(null);
  if (trackedSyncKey !== syncKey) {
    setTrackedSyncKey(syncKey);
    setDraftText(null);
  }
  const text = readOnly ? savedText : (draftText ?? savedText);
  const dirty = !readOnly && text !== savedText;
  const tooLong = utf8Bytes(text) > MAX_PERSONA_BYTES;
  const hint = personaLoadHint(text);
  return (
    <SettingsGroup
      label="Persona"
      action={
        dirty && (
          <Button size="sm" disabled={tooLong || busy !== null} onClick={() => save(text)}>
            {busy === "text" && <Loader2 aria-hidden="true" />}
            Save
          </Button>
        )
      }
    >
      <Textarea
        aria-label="Persona"
        placeholder="No persona yet"
        rows={1}
        disabled={readOnly}
        className={cn(
          "block max-h-[60vh] min-h-0 resize-none border-0 bg-transparent px-4 py-3 placeholder:font-sans placeholder:text-body field-sizing-content focus:border-0 focus:shadow-none",
          text === "" ? "text-body" : "font-mono text-minor",
        )}
        value={text}
        onChange={(e) => {
          if (!readOnly) setDraftText(e.target.value);
        }}
      />
      {hint !== null && !tooLong && <p className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{hint}</p>}
      {(tooLong || textError) && (
        <div className="px-4 py-2.5">
          {tooLong ? <RowError>Persona is too long</RowError> : textError !== undefined && <RowError error={textError} />}
        </div>
      )}
    </SettingsGroup>
  );
}

function FoldersPage({ folders }: { folders: ProjectFolder[] }) {
  return (
    <SettingsGroup label="Folders">
      {folders.length === 0 ? (
        <p className="px-4 py-3 text-body text-muted-foreground">No folders</p>
      ) : (
        <ul className="divide-y divide-border">
          {folders.map((f) => (
            <li key={f.id} title={f.path} className="min-w-0 px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-body text-foreground" title={folderBaseName(f.path)}>
                  {folderBaseName(f.path)}
                </span>
                {f.isMain && <span className="shrink-0 text-xs text-muted-foreground">Main folder</span>}
              </div>
              <div className="mt-0.5 truncate text-minor text-muted-foreground" title={f.path}>
                {shortPath(f.path)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function InfoDetailPage({
  page,
  pm,
  project,
  folders,
  schedules,
  persona,
  readOnly,
  onUpdate,
  onManageProviders,
  onEditDefaults,
}: {
  page: InfoPage;
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  persona: PersonaView;
  readOnly: boolean;
  onUpdate: (p: PersonaView) => void;
  onManageProviders: (() => void) | undefined;
  onEditDefaults: (() => void) | undefined;
}) {
  const aliveRef = useAliveRef();
  const agent = useAgentEditor(pm.id, persona, onUpdate, aliveRef);
  const modeSave = useInstantSave<PmMode>(pm.id, onUpdate, aliveRef);
  const text = usePersonaText({ pmId: pm.id, persona, onUpdate, aliveRef, onReverted: () => {} });
  const locked = readOnly || pm.archivedAt != null;

  if (page === "model") {
    return (
      <SettingsGroup label="Model">
        <AgentRows
          value={agent.draft}
          onChange={agent.change}
          disabled={agent.saving || locked}
          switchingToVendor={persona.switchingToVendor}
          onCustomSubmit={() => void agent.save()}
          {...(onManageProviders !== undefined ? { onManageProviders } : {})}
        />
        {agent.edited && (
          <div className="px-4 py-3">
            {agent.error && <RowError error={agent.error} />}
            <div className={agent.error ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
              <Button type="button" variant="ghost" size="sm" disabled={agent.saving} onClick={agent.cancel}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={!agent.canSave || locked} onClick={() => void agent.save()}>
                {agent.saving && <Loader2 aria-hidden="true" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    );
  }
  if (page === "mode") {
    const mode = modeSave.draft ?? persona.mode;
    return (
      <SettingsGroup label="Mode">
        <ModeRows label="Mode" value={mode} disabled={locked} onChange={(m) => modeSave.save(m, m === persona.mode ? {} : { mode: m })} />
        {modeSave.error && (
          <div className="px-4 py-2.5">
            <RowError error={modeSave.error} />
          </div>
        )}
      </SettingsGroup>
    );
  }
  if (page === "folders") return <FoldersPage folders={folders} />;
  if (page === "schedules") return <ScheduleGroup pmId={pm.id} schedules={schedules} disabled={locked} />;
  if (page === "capabilities") {
    return (
      <CapabilitiesPanel
        scope={{ kind: "pm", pmId: pm.id }}
        lead={pm.vendor ?? DEFAULT_AGENT_VENDOR}
        disabled={locked}
        {...(onEditDefaults !== undefined ? { onEditDefaults } : {})}
      />
    );
  }
  if (page === "persona") return <PersonaEditor persona={text} readOnly={locked} />;
  if (page === "memory") return <PmMemoryFilesGroup key={pm.id} pmId={pm.id} archived={locked} titled={false} />;
  if (page === "worktree") {
    return project !== null ? <WorktreeSetupGroup project={project} readOnly={locked} titled={false} /> : null;
  }
  return (
    <SettingsGroup label="History">
      {text.revertError && (
        <div className="px-4 py-2.5">
          <RowError error={text.revertError} />
        </div>
      )}
      {persona.changes.length === 0 ? (
        <p className="px-4 py-3 text-body text-muted-foreground">No changes yet</p>
      ) : (
        <ul aria-label="History" className="divide-y divide-border">
          {persona.changes.map((change) => (
            <ChangeRow
              key={change.id}
              change={change}
              revertable={change.id === persona.revertableChangeId}
              busy={locked || text.busy !== null}
              onRevert={() => text.revert(change.id)}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

/**
 * Postcondition: the summary shows the 44px avatar with no frame (hover shows a pencil badge; clicking opens the look
 * picker), the 16px name and the muted project name, the two row groups from infoRowsOf, and the `New session` and red
 * `Archive` text actions; an archived PM shows the existing archive status group instead of Archive. A page renders the
 * existing editor for that page (AgentRows, ModeRows, folders list, ScheduleGroup, CapabilitiesPanel, persona editor,
 * PmMemoryFilesGroup, WorktreeSetupGroup, history list).
 */
export function InfoTab({
  pm,
  project,
  folders,
  schedules,
  rev,
  renewing,
  page,
  readOnly,
  onNavigate,
  onArchived,
  onTogglePin,
  onManageProviders,
  onEditDefaults,
}: InfoTabProps): React.ReactElement {
  const { load, retry, set } = usePersona(pm.id, rev);
  const archived = pm.archivedAt != null;
  const activePage = archived && page === "capabilities" ? null : page;
  const pinned = pm.pinnedAt != null;
  const pinLabel = pinned ? "Unpin project" : "Pin project";

  if (activePage !== null) {
    return (
      <div className="right-rail-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 py-4 [contain:layout_style]">
        <div className="mx-auto grid max-w-160 grid-cols-1 gap-4">
          {load.phase === "loading" && (
            <div className="flex items-center justify-center gap-2 py-8 text-minor text-muted-foreground">
              <Loader2 className="size-pixel" aria-hidden="true" />
              Loading…
            </div>
          )}
          {load.phase === "error" && (
            <div className="flex items-center justify-center gap-3 py-8">
              <p role="alert" className="text-minor text-danger">
                {errorLine(load.info)}
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {load.phase === "ready" && (
            <InfoDetailPage
              page={activePage}
              pm={pm}
              project={project}
              folders={folders}
              schedules={schedules}
              persona={load.persona}
              readOnly={readOnly}
              onUpdate={set}
              onManageProviders={onManageProviders}
              onEditDefaults={onEditDefaults}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="right-rail-scroll work-panel-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [contain:layout_style]">
      <div className="info-id">
        <LookAvatarButton pm={pm} disabled={readOnly || archived} />
        <div className="min-w-0 flex-1">
          <h1 title={pm.name} className="truncate text-title leading-snug font-semibold text-foreground">
            {pm.name}
          </h1>
          {project !== null && (
            <p title={project.name} className="work-panel-muted mt-0.5 truncate text-xs">
              {project.name}
            </p>
          )}
        </div>
        {!archived && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={pinLabel}
            title={pinLabel}
            disabled={readOnly}
            onClick={() => onTogglePin(!pinned)}
          >
            {pinned ? <PinFilled aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </Button>
        )}
      </div>

      {load.phase === "loading" && (
        <div className="flex items-center justify-center gap-2 py-8 text-minor text-muted-foreground">
          <Loader2 className="size-pixel" aria-hidden="true" />
          Loading…
        </div>
      )}

      {load.phase === "error" && (
        <div className="flex items-center justify-center gap-3 py-8">
          <p role="alert" className="text-minor text-danger">
            {errorLine(load.info)}
          </p>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}

      {load.phase === "ready" && (
        <InfoSummaryRows
          key={`rows-${pm.id}`}
          pm={pm}
          project={project}
          folders={folders}
          schedules={schedules}
          persona={load.persona}
          onNavigate={(next) => onNavigate(next)}
        />
      )}

      {archived ? (
        <ArchiveStatusGroup key={`archive-${pm.id}`} pmId={pm.id} archivedAt={pm.archivedAt!} disabled={readOnly} />
      ) : (
        <InfoFooterActions
          pm={pm}
          renewing={renewing}
          readOnly={readOnly}
          switchingVendor={load.phase === "ready" && load.persona.switchingToVendor != null}
          onArchived={onArchived}
        />
      )}
    </div>
  );
}
